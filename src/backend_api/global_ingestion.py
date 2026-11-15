
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import random
import sqlite3
import time
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx

from global_store import GlobalStore, instant, utc
from quota import retry_seconds

BULK_SOURCES = {
    "MODIS_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv",
    "VIIRS_NOAA20_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv",
    "VIIRS_NOAA21_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv",
}
BULK_24H_SOURCES = {
    "MODIS_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv",
    "VIIRS_NOAA20_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
    "VIIRS_NOAA21_NRT": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv",
}
MAX_BULK_BYTES = 128 * 1024 * 1024


def configured_sources():
    configured = os.environ.get("SHARP_GLOBAL_SOURCES", "").strip()
    selected = [name.strip() for name in configured.split(",") if name.strip()] if configured else list(BULK_SOURCES)
    if not selected or any(source not in BULK_SOURCES for source in selected):
        raise ValueError("SHARP_GLOBAL_SOURCES supports MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT.")
    return selected


def parse_bulk(text, source):
    
    
    from app import Source, parse_features, feature_to_detection
    reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
    required = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Official FIRMS download did not return the expected CSV schema.")
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=reader.fieldnames)
    writer.writeheader()
    count = 0
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError("Official FIRMS CSV has an incomplete row.")
        count += 1
        if count > int(os.environ.get("SHARP_GLOBAL_MAX_SOURCE_RECORDS", "1500000")):
            raise ValueError("Global source exceeds the configured record bound; retain the previous publication.")
        writer.writerow(row)
        if count % 2000 == 0:
            for feature in parse_features(buffer.getvalue(), Source(source)):
                detection = feature_to_detection(feature)
                if detection is None:
                    raise ValueError("Official CSV contains an unsupported satellite.")
                yield detection
            buffer.seek(0); buffer.truncate(); writer.writeheader()
    if buffer.tell() > len(",".join(reader.fieldnames)) + 2:
        for feature in parse_features(buffer.getvalue(), Source(source)):
            detection = feature_to_detection(feature)
            if detection is None:
                raise ValueError("Official CSV contains an unsupported satellite.")
            yield detection


async def download_source(client, source, state=None, window="24h"):
    if window not in {"24h", "7d"}:
        raise ValueError("Shared ingestion supports 24h or an explicitly requested seven-day extract.")
    url = (BULK_24H_SOURCES if window == "24h" else BULK_SOURCES)[source]
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "firms.modaps.eosdis.nasa.gov" or parts.username:
        raise ValueError("Global downloads must use the configured official NASA host.")
    headers = {}
    if state and state.get("providerUrl") == url and state.get("etag"):
        headers["If-None-Match"] = state["etag"]
    elif state and state.get("providerUrl") == url and state.get("lastModified"):
        headers["If-Modified-Since"] = state["lastModified"]
    for attempt in range(3):
        try:
            async with client.stream("GET", url, headers=headers) as response:
                if response.status_code == 304:
                    return {"unchanged": True, "checkedAt": utc(time.time())}
                if response.status_code in (401, 403):
                    raise ValueError("Official global source access was rejected; check provider configuration.")
                if response.status_code == 429:
                    error = ValueError("Official global source rate limited; waiting before the next scheduled refresh.")
                    error.retry_after = retry_seconds(response.headers.get("retry-after"))
                    raise error
                if response.status_code >= 500 and attempt < 2:
                    await asyncio.sleep(2 ** attempt + random.random())
                    continue
                if response.status_code != 200:
                    raise ValueError(f"Official global source returned HTTP {response.status_code}.")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BULK_BYTES:
                        raise ValueError("Official global source exceeds the 128 MiB download bound.")
                metadata = {"etag": response.headers.get("etag"), "lastModified": response.headers.get("last-modified"), "provider": "NASA FIRMS public NRT bulk CSV", "processingTier": "NRT", "providerUrl": url, "downloadBytes": len(body), "checkedAt": utc(time.time()), "conditionalRequest": bool(headers)}
                return {"text": body.decode("utf-8-sig"), "metadata": metadata}
        except (httpx.RequestError, TimeoutError):
            if attempt == 2:
                raise ValueError("Official global source timed out or was unreachable.") from None
            await asyncio.sleep(2 ** attempt + random.random())
    raise ValueError("Official global source could not be loaded.")


async def refresh_global(store=None, client=None, now=None, sources=None, force=False, window="24h"):
    if window not in {"24h", "7d"}:
        raise ValueError("Shared ingestion supports 24h or an explicitly requested seven-day extract.")
    store = store or GlobalStore()
    owner = uuid.uuid4().hex
    if not await asyncio.to_thread(store.lease, "global-ingestion", owner, 900):
        return {"state": "coalesced", "manifest": store.current_manifest()}
    cadence = max(300, int(os.environ.get("SHARP_GLOBAL_REFRESH_SECONDS", "3600")))
    now = now or datetime.now(UTC)
    current = store.current_manifest()
    sources = sources or configured_sources()
    requested_hours = 24 if window == "24h" else 168
    def has_requested_extract(source):
        state = store.source_state(source) or {}
        hours = state.get("downloadWindowHours")
        if hours is None:
            hours = 168 if str(state.get("providerUrl", "")).endswith("_7d.csv") else 24 if str(state.get("providerUrl", "")).endswith("_24h.csv") else 0
        
        
        return hours == requested_hours
    if not force and current.get("publishedAt") and now.timestamp() - instant(current["publishedAt"]).timestamp() < cadence and all(has_requested_extract(source) for source in sources):
        store.release("global-ingestion", owner)
        return {"state": "cached", "manifest": current}
    store.update_ingestion_status(owner, phase="downloading", window=window, completedSources=0, totalSources=len(sources))
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15), follow_redirects=False)
    started = time.perf_counter()
    
    
    
    anchor = now.astimezone(UTC).replace(microsecond=0)
    successes = 0
    changed = False
    failures = []
    lease_lost = False
    async def heartbeat():
        nonlocal lease_lost
        while True:
            await asyncio.sleep(30)
            if not await asyncio.to_thread(store.lease, "global-ingestion", owner, 900):
                lease_lost = True
                return
    lease_task = asyncio.create_task(heartbeat())
    async def publish_snapshot(end):
        publish_task = asyncio.create_task(asyncio.to_thread(store.publish, end, sources, now.timestamp()))
        try:
            published = await asyncio.shield(publish_task)
        except asyncio.CancelledError:
            await publish_task
            raise
        
        
        await warm_retained_raster(store, published["snapshot"])
        return published
    try:
        for source in sources:
            if lease_lost:
                raise ValueError("Global ingestion ownership changed; this refresh cannot publish.")
            state = store.source_state(source)
            if state and state.get("retryAt") and instant(state["retryAt"]) > now:
                failures.append(source)
                continue
            try:
                store.update_ingestion_status(owner, phase="downloading", window=window, source=source, completedSources=successes, totalSources=len(sources))
                store.metric("upstream_bulk_requests")
                result = await download_source(client, source, state, window=window)
                if result.get("unchanged"):
                    state = {**state, "status": "ok", "checkedAt": result["checkedAt"], "failure": None}
                    
                    store.update_source_state(source, state)
                else:
                    changed = True
                    metadata = result["metadata"]
                    store.metric("upstream_bulk_bytes", metadata["downloadBytes"])
                    end = anchor
                    if metadata.get("lastModified"):
                        try:
                            end = min(anchor, parsedate_to_datetime(metadata["lastModified"]).astimezone(UTC))
                        except (ValueError, TypeError):
                            pass
                    metadata["timeAnchorBasis"] = "Provider Last-Modified bounded by publication anchor" if metadata.get("lastModified") else "Published retrieval anchor; provider generation time unavailable"
                    
                    
                    
                    
                    metadata["downloadWindowHours"] = 24 if window == "24h" else 168
                    metadata["coverageStart"] = utc(datetime.combine(end.date(), datetime.min.time(), UTC) - timedelta(days=0 if window == "24h" else 6))
                    metadata["coverageEndExclusive"] = utc(end)
                    metadata["coveragePolicy"] = "Current UTC date reporting extraction; ambiguous preceding boundary reports retained with unknown coverage" if window == "24h" else "Conservative seven UTC calendar dates; ambiguous earlier boundary reports retained with unknown coverage"
                    store.update_ingestion_status(owner, phase="processing", window=window, source=source, completedSources=successes, totalSources=len(sources))
                    write_task = asyncio.create_task(asyncio.to_thread(store.replace_source, source, parse_bulk(result["text"], source), end - timedelta(hours=metadata["downloadWindowHours"]), end, now.timestamp(), metadata))
                    try:
                        await asyncio.shield(write_task)
                    except asyncio.CancelledError:
                        
                        
                        await write_task
                        raise
                successes += 1
                if window == "24h" and not lease_lost:
                    
                    
                    available = [store.source_state(name) for name in sources]
                    ends = [instant(item["coverageEndExclusive"]) for item in available if item and item.get("coverageEndExclusive")]
                    if ends:
                        await publish_snapshot(min(anchor, max(ends)))
            except Exception as error:
                failures.append(source)
                store.record_failure(source, str(error), now.timestamp())
                state = store.source_state(source)
                state["retryAt"] = utc(now + timedelta(seconds=max(cadence, getattr(error, "retry_after", cadence))))
                store.update_source_state(source, state)
        
        
        available = [store.source_state(source) for source in sources]
        ends = [instant(state["coverageEndExclusive"]) for state in available if state and state.get("coverageEndExclusive")]
        if lease_lost:
            raise ValueError("Global ingestion ownership changed; this refresh cannot publish.")
        if not changed and not failures and current.get("snapshot") and current.get("completeness") == "complete":
            return {"state": "unchanged", "successfulSources": successes, "failedSources": [], "manifest": store.current_manifest()}
        published = None
        if ends:
            published = await publish_snapshot(min(anchor, max(ends)))
        store.metric("ingestion_duration_ms", (time.perf_counter() - started) * 1000)
        store.update_ingestion_status(owner, phase="complete" if published else "failed", window=window, completedSources=successes, totalSources=len(sources))
        return {"state": "published" if published else "unavailable", "successfulSources": successes, "failedSources": failures, "manifest": published or store.current_manifest()}
    finally:
        lease_task.cancel()
        await asyncio.gather(lease_task, return_exceptions=True)
        if own_client:
            await client.aclose()
        store.release("global-ingestion", owner)


async def warm_retained_raster(store, snapshot=None):
    
    if os.environ.get("SHARP_GLOBAL_RASTER_PREWARM_ENABLED", "1").lower() in {"0", "false", "no"}:
        return {"state": "disabled"}
    try:
        if snapshot is None:
            current = await asyncio.to_thread(store.current_manifest)
            snapshot = current.get("snapshot")
            if not snapshot or current.get("status") in {"building", "unavailable"}:
                return {"state": "unavailable"}
    except (sqlite3.Error, OSError, ValueError):
        return {"state": "skipped"}
    owner = uuid.uuid4().hex
    lease_name = "global-raster-prewarm:" + snapshot
    try:
        claimed = await asyncio.to_thread(store.lease, lease_name, owner, 120)
    except (sqlite3.Error, OSError):
        
        
        return {"state": "skipped"}
    if not claimed:
        return {"state": "coalesced"}
    try:
        from global_raster import prewarm_global_raster
        task = asyncio.create_task(asyncio.to_thread(prewarm_global_raster, store, snapshot, "24h"))
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
    except asyncio.CancelledError:
        raise
    except Exception:
        try:
            store.metric("raster_prewarm_failures")
            store.release(lease_name, owner)
        except (sqlite3.Error, OSError):
            pass
        return {"state": "failed"}
    
    
    return {"state": "warmed", "result": result}


async def run_owner(app):
    
    store = app.state.global_store
    
    await asyncio.sleep(1)
    await warm_retained_raster(store)
    if os.environ.get("SHARP_GLOBAL_INGEST_ENABLED", "1").lower() in {"0", "false", "no"}:
        return
    while True:
        try:
            result = await refresh_global(store, window="24h")
            if result.get("state") == "coalesced":
                await asyncio.sleep(2)
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            store.metric("owner_failures")
        await asyncio.sleep(max(300, int(os.environ.get("SHARP_GLOBAL_REFRESH_SECONDS", "3600"))))
