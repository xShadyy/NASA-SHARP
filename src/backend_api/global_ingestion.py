"""One leased owner downloads official NRT bulk products for all map visitors.

Public bulk URLs do not contain MAP_KEY. RT/URT API supplements remain a
separate explicitly budgeted path; bulk NRT is not represented as RT/URT.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import random
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
MAX_BULK_BYTES = 128 * 1024 * 1024


def configured_sources():
    configured = os.environ.get("SHARP_GLOBAL_SOURCES", "").strip()
    selected = [name.strip() for name in configured.split(",") if name.strip()] if configured else list(BULK_SOURCES)
    if not selected or any(source not in BULK_SOURCES for source in selected):
        raise ValueError("SHARP_GLOBAL_SOURCES supports MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT.")
    return selected


def parse_bulk(text, source):
    # Reuse the existing NASA-format validator and canonical conversion in bounded
    # batches rather than building a second full GeoJSON collection for the world.
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


async def download_source(client, source, state=None):
    url = BULK_SOURCES[source]
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "firms.modaps.eosdis.nasa.gov" or parts.username:
        raise ValueError("Global downloads must use the configured official NASA host.")
    headers = {}
    if state and state.get("etag"):
        headers["If-None-Match"] = state["etag"]
    elif state and state.get("lastModified"):
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


async def refresh_global(store=None, client=None, now=None, sources=None, force=False):
    store = store or GlobalStore()
    owner = uuid.uuid4().hex
    if not await asyncio.to_thread(store.lease, "global-ingestion", owner, 900):
        return {"state": "coalesced", "manifest": store.current_manifest()}
    cadence = max(300, int(os.environ.get("SHARP_GLOBAL_REFRESH_SECONDS", "900")))
    now = now or datetime.now(UTC)
    current = store.current_manifest()
    if not force and current.get("publishedAt") and now.timestamp() - instant(current["publishedAt"]).timestamp() < cadence:
        store.release("global-ingestion", owner)
        return {"state": "cached", "manifest": current}
    sources = sources or configured_sources()
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15), follow_redirects=False)
    started = time.perf_counter()
    # A single stable publication anchor, never one independently chosen per tile.
    anchor = datetime.fromtimestamp(int(now.timestamp() // cadence) * cadence, UTC)
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
    try:
        for source in sources:
            if lease_lost:
                raise ValueError("Global ingestion ownership changed; this refresh cannot publish.")
            state = store.source_state(source)
            if state and state.get("retryAt") and instant(state["retryAt"]) > now:
                failures.append(source)
                continue
            try:
                store.metric("upstream_bulk_requests")
                result = await download_source(client, source, state)
                if result.get("unchanged"):
                    state = {**state, "status": "ok", "checkedAt": result["checkedAt"], "failure": None}
                    # 304 never claims the old file contains newly acquired reports.
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
                    # The official page promises "last 7 days" without a precise
                    # public file start instant. Keep every supplied record within
                    # 168h, but do not claim the ambiguous first boundary date is a
                    # complete reporting window. Retained days can fill it later.
                    metadata["coverageStart"] = utc(datetime.combine(end.date(), datetime.min.time(), UTC) - timedelta(days=6))
                    metadata["coverageEndExclusive"] = utc(end)
                    metadata["coveragePolicy"] = "Conservative seven UTC calendar dates; ambiguous earlier boundary reports retained with unknown coverage"
                    write_task = asyncio.create_task(asyncio.to_thread(store.replace_source, source, parse_bulk(result["text"], source), end - timedelta(days=7), end, now.timestamp(), metadata))
                    try:
                        await asyncio.shield(write_task)
                    except asyncio.CancelledError:
                        # A shutdown must not release ownership while its SQLite
                        # partition transaction is still running in a thread.
                        await write_task
                        raise
                successes += 1
            except Exception as error:
                failures.append(source)
                store.record_failure(source, str(error), now.timestamp())
                state = store.source_state(source)
                state["retryAt"] = utc(now + timedelta(seconds=max(cadence, getattr(error, "retry_after", cadence))))
                store.update_source_state(source, state)
        # Anchor at the most recent known bulk generation, retaining failed source
        # data at that fixed interval with explicit stale/partial status.
        available = [store.source_state(source) for source in sources]
        ends = [instant(state["coverageEndExclusive"]) for state in available if state and state.get("coverageEndExclusive")]
        if lease_lost:
            raise ValueError("Global ingestion ownership changed; this refresh cannot publish.")
        if not changed and not failures and current.get("snapshot") and current.get("completeness") == "complete":
            return {"state": "unchanged", "successfulSources": successes, "failedSources": [], "manifest": store.current_manifest()}
        published = None
        if ends:
            publish_task = asyncio.create_task(asyncio.to_thread(store.publish, min(anchor, max(ends)), sources, now.timestamp()))
            try:
                published = await asyncio.shield(publish_task)
            except asyncio.CancelledError:
                await publish_task
                raise
        store.metric("ingestion_duration_ms", (time.perf_counter() - started) * 1000)
        return {"state": "published" if published else "unavailable", "successfulSources": successes, "failedSources": failures, "manifest": published or store.current_manifest()}
    finally:
        lease_task.cancel()
        await asyncio.gather(lease_task, return_exceptions=True)
        if own_client:
            await client.aclose()
        store.release("global-ingestion", owner)


async def run_owner(app):
    """Backend-lifetime service, independent of browser requests/disconnects."""
    if os.environ.get("SHARP_GLOBAL_INGEST_ENABLED", "1").lower() in {"0", "false", "no"}:
        return
    store = app.state.global_store
    # Let the server start and serve the retained manifest before cold acquisition.
    await asyncio.sleep(1)
    while True:
        try:
            await refresh_global(store)
        except asyncio.CancelledError:
            raise
        except Exception:
            store.metric("owner_failures")
        await asyncio.sleep(max(300, int(os.environ.get("SHARP_GLOBAL_REFRESH_SECONDS", "900"))))
