"""Serve NASA FIRMS MODIS and VIIRS active-fire detections as GeoJSON."""

import asyncio
import csv
import hashlib
import io
import json
import logging
import math
import os
import sqlite3
import tempfile
import time as clock
import zlib
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Query, Request

from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from cache import BatchCache
from area_analytics_summary import AreaAnalyticsSummary
from observation_explorer import (
    SelectionInvalid, cached_snapshot, has_snapshot, export_document, freeze_document,
    observations_document as explorer_document, remember_snapshot, source_generation,
)
from harmonize import (
    CanonicalStore,
    observation_kept,
    filters_from_query,
    Coverage,
    Detection,
    RejectedQuery,
    calendar_document,
    capabilities_payload,
    geometry_bbox,
    map_source_document,
    observation_document,
    observations_document,
    overview_document,
    parse_utc_interval,
    prepared_area,
    store_from_environment,
    time_series_document,
)
from query_time import query_window, timezone
from global_store import GlobalStore
from quota import QuotaGovernor, QuotaUnavailable, governed_csv, retry_seconds
from global_ingestion import run_owner

FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov"
VIIRS_RANKS = {"l": 0, "n": 1, "h": 2}
VIIRS_CLASSES = {"l": "low", "n": "nominal", "h": "high"}
MAX_CSV_BYTES = 50 * 1024 * 1024
NETHERLANDS_EUROPE_GEOMETRY = {
    "type": "Polygon",
    "coordinates": [[
        [6.9051, 53.4822],
        [7.0921, 53.144],
        [6.8429, 52.2284],
        [6.5894, 51.852],
        [5.9887, 51.8516],
        [6.1567, 50.8037],
        [5.607, 51.0373],
        [4.974, 51.475],
        [4.0471, 51.2673],
        [3.315, 51.3458],
        [3.8303, 51.6205],
        [4.706, 53.0918],
        [6.0742, 53.5104],
        [6.9051, 53.4822],
    ]],
}
NETHERLANDS_EUROPE_BOUNDS = "3.315,50.8037,7.0921,53.5104"
# The upstream API places the credential in the URL.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class Source(str, Enum):
    MODIS_NRT = "MODIS_NRT"
    MODIS_SP = "MODIS_SP"
    VIIRS_NOAA20_NRT = "VIIRS_NOAA20_NRT"
    VIIRS_NOAA20_SP = "VIIRS_NOAA20_SP"
    VIIRS_NOAA21_NRT = "VIIRS_NOAA21_NRT"
    VIIRS_NOAA21_SP = "VIIRS_NOAA21_SP"
    VIIRS_SNPP_NRT = "VIIRS_SNPP_NRT"
    VIIRS_SNPP_SP = "VIIRS_SNPP_SP"


@dataclass
class InFlightBatch:
    task: asyncio.Task
    started: asyncio.Event
    waiters: int = 0


class AreaHotspotsQuery(BaseModel):
    geometry: dict
    start_date: date
    days: int = Field(ge=1, le=31)
    daynight: Literal["all", "day", "night"] = "all"
    source: list[Source] | None = Field(default=None, max_length=8)
    modis_min_confidence: int = Field(default=0, ge=0, le=100)
    viirs_min_confidence: Literal["l", "n", "h"] = "l"
    summary: bool = True


class AreaAnalyticsHotspotsQuery(BaseModel):
    area: Literal["netherlands"] = "netherlands"
    geometry: dict | None = None
    start_date: date
    days: int = Field(ge=1, le=31)
    daynight: Literal["all", "day", "night"] = "all"
    source: list[Source] | None = Field(default=None, max_length=8)
    modis_min_confidence: int = Field(default=0, ge=0, le=100)
    viirs_min_confidence: Literal["l", "n", "h"] = "l"
    summary: bool = True


LIVE_SOURCES = [Source.MODIS_NRT, Source.VIIRS_NOAA20_NRT, Source.VIIRS_NOAA21_NRT]


class FIRMSFailure(Exception):
    """A sanitized upstream error safe to return to the caller."""


@asynccontextmanager
async def lifespan(app: FastAPI):
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    app.state.global_store = await asyncio.to_thread(GlobalStore)
    app.state.quota = QuotaGovernor(app.state.global_store.path, key)
    app.state.key = quote(key, safe="") if key else ""
    default_path = Path(tempfile.gettempdir()) / "firms-hotspots" / "cache.sqlite3"
    app.state.cache = await asyncio.to_thread(
        BatchCache, Path(os.getenv("FIRMS_CACHE_PATH", str(default_path)))
    )
    app.state.batch_locks = [asyncio.Lock() for _ in range(64)]
    app.state.batch_fetches = {}
    async with httpx.AsyncClient(
        base_url=FIRMS_URL,
        timeout=httpx.Timeout(120, connect=10),
        limits=httpx.Limits(max_connections=8),
        follow_redirects=False,
    ) as client:
        app.state.firms = client
        app.state.slots = asyncio.Semaphore(8)
        global_owner = asyncio.create_task(run_owner(app))
        try:
            yield
        finally:
            global_owner.cancel()
            await asyncio.gather(global_owner, return_exceptions=True)
            pending_fetches = [fetch.task for fetch in app.state.batch_fetches.values()]
            for task in pending_fetches:
                task.cancel()
            if pending_fetches:
                await asyncio.gather(*pending_fetches, return_exceptions=True)
app = FastAPI(title="FIRMS Hotspots", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def require_firms_key(request: Request) -> None:
    if not request.app.state.key:
        raise HTTPException(503, "Set FIRMS_MAP_KEY before using FIRMS routes.")


def require_firms_or_global(request: Request) -> None:
    if request.app.state.key:
        return
    stored = getattr(request.app.state, "global_store", None)
    if stored is None or not stored.current_manifest().get("snapshot"):
        require_firms_key(request)


async def _fetch_csv_unchecked(
    app: FastAPI, path: str, started: asyncio.Event | None = None
) -> str:
    try:
        async with asyncio.timeout(150), app.state.slots:
            if started is not None:
                started.set()
            async with app.state.firms.stream("GET", path) as response:
                if response.status_code in (401, 403):
                    raise FIRMSFailure("FIRMS rejected the map key or access.")
                if response.status_code == 429:
                    failure = FIRMSFailure("FIRMS rate limit reached.")
                    failure.retry_after = retry_seconds(response.headers.get("retry-after"))
                    raise failure
                if response.status_code != 200:
                    raise FIRMSFailure(f"FIRMS returned HTTP {response.status_code}.")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_CSV_BYTES:
                        raise FIRMSFailure("FIRMS response exceeded 50 MiB. Use a smaller area or fewer days.")
        return body.decode("utf-8-sig")
    except (httpx.RequestError, TimeoutError):
        raise FIRMSFailure("FIRMS request failed or timed out.") from None
    except UnicodeError:
        raise FIRMSFailure("FIRMS returned invalid text encoding.") from None


async def fetch_csv(app: FastAPI, path: str, started: asyncio.Event | None = None) -> str:
    try:
        return await governed_csv(app, path, started, _fetch_csv_unchecked)
    except QuotaUnavailable as exc:
        raise FIRMSFailure(str(exc)) from None


def csv_rows(text: str, required: set[str]) -> csv.DictReader:
    rows = csv.DictReader(io.StringIO(text, newline=""), strict=True)
    if not required.issubset(rows.fieldnames or []):
        # FIRMS can return an error message as text with HTTP 200.
        raise FIRMSFailure("FIRMS did not return the expected CSV. Check your map key, quota and product dates.")
    return rows


def number(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("Non-finite value")
    return parsed


def optional_number(row: dict, name: str) -> float | None:
    value = (row.get(name) or "").strip()
    return number(value) if value else None


def parse_area(area: str) -> str:
    if area.strip().lower() == "world":
        return "world"
    if area.strip().lower() == "netherlands":
        return NETHERLANDS_EUROPE_BOUNDS
    try:
        west, south, east, north = map(number, area.split(","))
        if -180 <= west < east <= 180 and -90 <= south < north <= 90:
            return ",".join(format(Decimal(str(value or 0.0)), "f") for value in (west, south, east, north))
    except ValueError:
        pass
    raise HTTPException(
        422,
        "Use world, netherlands, or west,south,east,north with increasing bounds. "
        "Split areas crossing 180° into two queries.",
    )


def area_boxes_for_geometry(geometry: dict) -> list[str]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        polygons = [coordinates]
    elif geometry_type == "MultiPolygon":
        polygons = coordinates
    else:
        raise HTTPException(422, "Analysis area must be a Polygon or MultiPolygon.")
    if not isinstance(polygons, list) or not polygons:
        raise HTTPException(422, "Analysis area has no polygon coordinates.")

    longitudes = []
    south = Decimal(90)
    north = Decimal(-90)
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            raise HTTPException(422, "Analysis area contains an invalid polygon.")
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                raise HTTPException(422, "Analysis area contains an invalid polygon ring.")
            for position in ring:
                if not isinstance(position, list) or len(position) < 2:
                    raise HTTPException(422, "Analysis area contains an invalid coordinate.")
                try:
                    longitude, latitude = map(number, position[:2])
                except (TypeError, ValueError):
                    raise HTTPException(422, "Analysis area contains an invalid coordinate.")
                if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                    raise HTTPException(422, "Analysis area coordinates are out of range.")
                longitudes.append(Decimal(str(longitude)) % Decimal(360))
                south = min(south, Decimal(str(latitude)))
                north = max(north, Decimal(str(latitude)))
            if ring[0][:2] != ring[-1][:2]:
                raise HTTPException(422, "Analysis area polygon rings must be closed.")

    longitudes = sorted(set(longitudes))
    if not longitudes:
        raise HTTPException(422, "Analysis area has no polygon coordinates.")
    gaps = [
        (
            longitudes[(index + 1) % len(longitudes)]
            + (Decimal(360) if index == len(longitudes) - 1 else Decimal(0))
            - longitude,
            (index + 1) % len(longitudes),
        )
        for index, longitude in enumerate(longitudes)
    ]
    largest_gap, start_index = max(gaps)
    span = Decimal(360) - largest_gap
    if span <= 0 or south >= north:
        raise HTTPException(422, "Analysis area must enclose a non-zero area.")
    west = longitudes[start_index]
    if west >= 180:
        west -= Decimal(360)
    east = west + span

    def format_box(box_west: Decimal, box_east: Decimal) -> str:
        return ",".join(
            format(value, "f")
            for value in (box_west, south, box_east, north)
        )

    if east <= 180:
        return [format_box(west, east)]
    return [format_box(west, Decimal(180)), format_box(Decimal(-180), east - Decimal(360))]


def parse_features(text: str, source: Source) -> list[dict]:
    required = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence"}
    features = []
    seen = set()
    is_modis = source.value.startswith("MODIS_")
    try:
        for row in csv_rows(text, required):
            lon, lat = number(row["longitude"]), number(row["latitude"])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError("Invalid coordinates")
            acq_date = date.fromisoformat(row["acq_date"])
            hhmm = row["acq_time"].strip().zfill(4)
            if not hhmm.isascii() or not hhmm.isdigit() or len(hhmm) != 4:
                raise ValueError("Invalid acquisition time")
            acquired = datetime.combine(acq_date, time(int(hhmm[:2]), int(hhmm[2:])), tzinfo=UTC)
            satellite = row["satellite"].strip()
            if not satellite:
                raise ValueError("Missing satellite")
            confidence = row["confidence"].strip().lower()
            if is_modis:
                confidence = int(confidence) if confidence else None
                if confidence is not None and not 0 <= confidence <= 100:
                    raise ValueError("Invalid MODIS confidence")
            elif confidence and confidence not in VIIRS_RANKS:
                raise ValueError("Invalid VIIRS confidence")
            elif not confidence:
                confidence = None

            # Drop identical rows within this product and keep separate satellite observations.
            if None in row or any(value is None for value in row.values()):
                raise ValueError("Incomplete CSV row")
            row_key = tuple(row.items())
            if row_key in seen:
                continue
            seen.add(row_key)
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "source": source.value,
                    "sensor": "MODIS" if is_modis else "VIIRS",
                    "satellite": satellite,
                    "processing": "SP" if source.value.endswith("_SP") else "NRT",
                    "nominal_resolution_m": 1000 if is_modis else 375,
                    "acquired_at": acquired.isoformat().replace("+00:00", "Z"),
                    "confidence": confidence,
                    "confidence_scale": "0-100" if is_modis else "low/nominal/high",
                    "confidence_class": None if is_modis else VIIRS_CLASSES.get(confidence),
                    "frp_mw": optional_number(row, "frp"),
                    "scan_km": optional_number(row, "scan"),
                    "track_km": optional_number(row, "track"),
                    "brightness_k": optional_number(row, "brightness" if is_modis else "bright_ti4"),
                    "brightness_band": "MODIS channel 21/22" if is_modis else "VIIRS I-4",
                    "daynight": (row.get("daynight") or "").strip().upper() or None,
                    "fire_type_code": row.get("type") or None,
                    "version": row.get("version") or None,
                },
            })
    except (csv.Error, TypeError, AttributeError, ValueError, KeyError):
        raise FIRMSFailure("FIRMS returned malformed hotspot CSV.") from None
    return features


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/availability")
async def availability(request: Request):
    require_firms_key(request)
    app = request.app
    try:
        allowed = {source.value for source in Source}
        windows = await product_windows(app)
        products = [{"source": source, "min_date": span[0], "max_date": span[1]} for source, span in windows.items() if source in allowed]
        return {"products": products}
    except FIRMSFailure as exc:
        raise HTTPException(502, str(exc)) from None
    except (csv.Error, TypeError, ValueError):
        raise HTTPException(502, "FIRMS returned malformed availability CSV.") from None


def batch_ttl(product: Source, day: date, today: date) -> int:
    if product.value.endswith("_SP"):
        return 7 * 86400
    return 300 if day >= today - timedelta(days=1) else 86400


async def fetch_and_cache_batch(
    app: FastAPI,
    product: Source,
    bounds: str,
    day: date,
    today: date,
    key: str,
    started: asyncio.Event,
):
    path = f"/api/area/csv/{app.state.key}/{product.value}/{bounds}/1"
    if day != today or product.value.endswith("_SP"):
        path += f"/{day.isoformat()}"
    text = await fetch_csv(app, path, started)
    fetched = clock.time()
    features = await asyncio.to_thread(parse_features, text, product)
    # Keep a rolling-day request made across midnight out of the wrong cache entry.
    if any(feature["properties"]["acquired_at"][:10] != day.isoformat() for feature in features):
        raise FIRMSFailure("FIRMS returned data outside the requested UTC day; retry the query.")
    if day == today and datetime.fromtimestamp(fetched, UTC).date() != today:
        raise FIRMSFailure("The UTC day changed during retrieval; retry the query.")
    ttl = batch_ttl(product, day, today)
    try:
        await asyncio.to_thread(app.state.cache.put, key, features, fetched, ttl)
    except sqlite3.Error:
        logging.warning("Could not write FIRMS cache; serving data from NASA.")
    return features, fetched


class GlobalFeatureBatch(list):
    coverage_state = "complete"


def global_source_partition(app, product, day):
    stored = getattr(app.state, "global_store", None)
    if stored is None:
        return None
    manifest = stored.current_manifest("7d")
    if not manifest.get("snapshot"):
        return None
    from contextlib import closing
    with closing(stored.connect()) as db:
        partition = db.execute("SELECT p.* FROM global_partition_versions p JOIN global_snapshot_partitions s ON s.version=p.version WHERE s.snapshot=? AND p.source=? AND p.day=?", (manifest["snapshot"], product.value, day.isoformat())).fetchone()
    return (stored, manifest, dict(partition)) if partition else None


def global_source_batch(app, product, bounds, day):
    retained = global_source_partition(app, product, day)
    if retained is None:
        return None
    stored, manifest, partition = retained
    bbox = None if bounds == "world" else tuple(float(value) for value in bounds.split(","))
    result = GlobalFeatureBatch()
    result.coverage_state = partition["coverage"]
    classes = {"low": "l", "nominal": "n", "high": "h"}
    from harmonize import detection_id
    for row in stored.iter_observations(manifest["snapshot"], "7d", bbox):
        if row.acquired_at.date() != day or row.source_product != product.value:
            continue
        modis = row.platform in {"aqua", "terra"}
        identity = detection_id(row)
        result.append({"type": "Feature", "id": identity, "geometry": {"type": "Point", "coordinates": [row.longitude, row.latitude]},
                       "properties": {"id": identity, "source": row.source_product, "sensor": "MODIS" if modis else "VIIRS", "satellite": row.platform,
                                      "processing": row.processing_tier, "nominal_resolution_m": row.nominal_resolution_m,
                                      "acquired_at": row.acquired_at.isoformat().replace("+00:00", "Z"), "confidence": row.confidence_pct if modis else classes.get(row.confidence_class),
                                      "confidence_scale": "0-100" if modis else "low/nominal/high", "confidence_class": row.confidence_class,
                                      "frp_mw": row.frp_mw, "scan_km": row.scan_km, "track_km": row.track_km, "brightness_k": None, "brightness_band": None,
                                      "daynight": row.day_night, "fire_type_code": None, "version": row.product_version, "snapshot": manifest["snapshot"]}})
        if len(result) > MAX_CANONICAL_ACQUISITION_ROWS:
            raise FIRMSFailure("Stored regional source/day exceeds the 200,000 observation budget; select a smaller region.")
    return result, partition["retrieved"], True


async def load_batch(app: FastAPI, product: Source, bounds: str, day: date, today: date, acquisition_started: asyncio.Event | None = None):
    retained = await asyncio.to_thread(global_source_batch, app, product, bounds, day)
    if retained is not None:
        return retained
    key = app.state.cache.key(product.value, bounds, day.isoformat())
    lock = app.state.batch_locks[hash(key) % len(app.state.batch_locks)]
    async with lock:
        try:
            cached = await asyncio.to_thread(app.state.cache.get, key)
            if cached is not None:
                features, fetched = cached
                return features, fetched, True
        except (sqlite3.Error, ValueError, zlib.error):
            logging.warning("Could not read FIRMS cache; fetching from NASA.")

        if not app.state.key:
            raise FIRMSFailure("No stored global source/day is available. Set FIRMS_MAP_KEY for bounded regional acquisition.")

        fetch = app.state.batch_fetches.get(key)
        shared_fetch = fetch is not None
        if fetch is None:
            started = asyncio.Event()
            task = asyncio.create_task(
                fetch_and_cache_batch(app, product, bounds, day, today, key, started)
            )
            fetch = InFlightBatch(task=task, started=started)
            app.state.batch_fetches[key] = fetch

            def clear_fetch(completed: asyncio.Task):
                if app.state.batch_fetches.get(key) is fetch:
                    del app.state.batch_fetches[key]
                if not completed.cancelled():
                    error = completed.exception()
                    if error is not None:
                        logging.warning("Shared FIRMS batch fetch failed: %s", error)

            task.add_done_callback(clear_fetch)
        fetch.waiters += 1

    observer = None
    if acquisition_started is not None:
        async def observe_start():
            await fetch.started.wait()
            acquisition_started.set()
        observer = asyncio.create_task(observe_start())
    try:
        features, fetched = await asyncio.shield(fetch.task)
        return features, fetched, shared_fetch
    finally:
        if observer is not None:
            observer.cancel()
        fetch.waiters -= 1
        if fetch.waiters == 0 and not fetch.started.is_set() and not fetch.task.done():
            fetch.task.cancel()


def filter_features(
    batches, lower, upper, zone, daynight, modis_min, viirs_min, geometry=None
):
    features = []
    area = prepared_area(geometry) if geometry else None
    for batch in batches:
        for feature in batch:
            props = feature["properties"]
            acquired = datetime.fromisoformat(props["acquired_at"])
            if not lower <= acquired < upper:
                continue
            if area and not area.contains(*feature["geometry"]["coordinates"]):
                continue
            if daynight != "all" and props["daynight"] != {"day": "D", "night": "N"}[daynight]:
                continue
            confidence = props["confidence"]
            if props["sensor"] == "MODIS" and (confidence is None and modis_min > 0 or confidence is not None and confidence < modis_min):
                continue
            if props["sensor"] == "VIIRS" and (confidence is None and viirs_min != "l" or confidence is not None and VIIRS_RANKS[confidence] < VIIRS_RANKS[viirs_min]):
                continue
            features.append({
                **feature,
                "properties": {**props, "acquired_at_local": acquired.astimezone(zone).isoformat()},
            })
    return features


@app.get("/hotspots")
async def hotspots(
    request: Request,
    area: Annotated[str, Query(max_length=100)],
    days: Annotated[int | None, Query(ge=1, le=31)] = None,
    start_date: date | None = None,
    start: Annotated[str | None, Query(max_length=40)] = None,
    end: Annotated[str | None, Query(max_length=40)] = None,
    tz: Annotated[str | None, Query(max_length=64)] = None,
    daynight: Literal["all", "day", "night"] = "all",
    source: Annotated[list[Source] | None, Query(max_length=8)] = None,
    modis_min_confidence: Annotated[int, Query(ge=0, le=100)] = 0,
    viirs_min_confidence: Annotated[str, Query(pattern="^[lnh]$")] = "l",
    summary: bool = False,
    geometry_json: Annotated[
        str | None, Query(max_length=2_000_000, include_in_schema=False)
    ] = None,
):
    require_firms_or_global(request)
    country_geometry = (
        NETHERLANDS_EUROPE_GEOMETRY if area.strip().lower() == "netherlands" else None
    )
    if geometry_json is not None:
        try:
            selected_geometry = json.loads(geometry_json)
        except json.JSONDecodeError:
            raise HTTPException(422, "Analysis area is not valid JSON.")
        if not isinstance(selected_geometry, dict):
            raise HTTPException(422, "Analysis area must be a GeoJSON geometry.")
        area_bounds = area_boxes_for_geometry(selected_geometry)
        geometry_cache_key = "custom-v1:" + hashlib.sha256(
            json.dumps(selected_geometry, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    else:
        selected_geometry = country_geometry
        area_bounds = [parse_area(area)]
        geometry_cache_key = (
            "netherlands-europe-v1" if country_geometry is not None else None
        )
    zone = timezone(tz)
    today = datetime.now(UTC).date()
    lower, upper, dates = query_window(start, end, start_date, days, zone, tz is not None, today)
    sources = list(dict.fromkeys(source or LIVE_SOURCES))
    if start_date is None and start is None and any(s.value.endswith("_SP") for s in sources):
        raise HTTPException(422, "Provide start_date or start and end for standard-processing products.")
    completed_sources: dict[date, set[str]] = {day: set() for day in dates}

    async def report_day_processed(day: date, product: Source):
        progress_callback = getattr(request.state, "area_analytics_progress", None)
        if progress_callback is None:
            return
        completed_sources[day].add(product.value)
        processed_days = sum(
            1 for completed in completed_sources.values() if len(completed) == len(sources)
        )
        await progress_callback(
            {"processed_days": processed_days, "total_days": len(dates)}
        )

    async def load_product(product: Source):
        batches = []
        fetched_at = []
        cache_hits = 0
        failures = []
        product_summary = AreaAnalyticsSummary() if summary else None

        async def load_summary_day(day: date):
            global_partition = await asyncio.to_thread(global_source_partition, request.app, product, day)
            batch_keys = [
                request.app.state.cache.key(product.value, bounds, day.isoformat())
                for bounds in area_bounds
            ]
            day_start = datetime.combine(day, time.min, tzinfo=UTC)
            day_end = day_start + timedelta(days=1)
            window_key: str | list[str] = (
                "full_utc_day"
                if lower <= day_start and upper >= day_end
                else [lower.isoformat(), upper.isoformat()]
            )
            summary_key = json.dumps(
                [
                    1,
                    batch_keys,
                    geometry_cache_key,
                    window_key,
                    daynight,
                    modis_min_confidence,
                    VIIRS_RANKS[viirs_min_confidence],
                ],
                separators=(",", ":"),
            )
            if len(batch_keys) == 1 and global_partition is None:
                try:
                    cached_summary = await asyncio.to_thread(
                        request.app.state.cache.get_summary, summary_key, batch_keys[0]
                    )
                    if cached_summary is not None:
                        summary_json, fetched = cached_summary
                        try:
                            daily_summary = AreaAnalyticsSummary.from_cache(summary_json)
                            await report_day_processed(day, product)
                            return day, daily_summary, [fetched], 1, None
                        except (KeyError, TypeError, ValueError):
                            logging.warning("Could not read Area Analytics summary cache; recalculating.")
                except sqlite3.Error:
                    logging.warning("Could not read Area Analytics summary cache; recalculating.")

            features = []
            fetched_values = []
            cache_hits_for_day = 0
            for bounds in area_bounds:
                try:
                    batch, fetched, batch_cached = await load_batch(
                        request.app, product, bounds, day, today
                    )
                    if getattr(batch, "coverage_state", "complete") != "complete":
                        failures.append({"date": day.isoformat(), "detail": "Stored global reporting window is partial; available observations are included."})
                except FIRMSFailure as exc:
                    await report_day_processed(day, product)
                    return day, None, None, 0, str(exc)
                features.extend(batch)
                fetched_values.append(fetched)
                cache_hits_for_day += batch_cached
            daily_summary = AreaAnalyticsSummary()
            lower_key = lower.astimezone(UTC).isoformat(timespec="microseconds").replace(
                "+00:00", "Z"
            )
            upper_key = upper.astimezone(UTC).isoformat(timespec="microseconds").replace(
                "+00:00", "Z"
            )
            await asyncio.to_thread(
                daily_summary.add_filtered,
                features,
                lower_key,
                upper_key,
                daynight,
                modis_min_confidence,
                VIIRS_RANKS[viirs_min_confidence],
                selected_geometry,
            )
            if len(batch_keys) == 1 and global_partition is None:
                try:
                    await asyncio.to_thread(
                        request.app.state.cache.put_summary,
                        summary_key,
                        batch_keys[0],
                        daily_summary.to_cache(),
                        min(fetched_values),
                    )
                except sqlite3.Error:
                    logging.warning("Could not write Area Analytics summary cache; serving calculated data.")
            await report_day_processed(day, product)
            return day, daily_summary, fetched_values, cache_hits_for_day, None

        if summary:
            day_results = await asyncio.gather(*(load_summary_day(day) for day in dates))
            successful_days = 0
            for day, daily_summary, fetched, cached, failure in day_results:
                if failure is not None:
                    failures.append({"date": day.isoformat(), "detail": failure})
                    continue
                assert daily_summary is not None and fetched is not None
                product_summary.merge(daily_summary)
                fetched_at.extend(fetched)
                successful_days += 1
                cache_hits += cached
            day_results.clear()
            selected_count = product_summary.count
            selected_features = None
        else:
            successful_days = 0
            for day in dates:
                day_features = []
                day_fetched = []
                day_cache_hits = 0
                try:
                    for bounds in area_bounds:
                        features, fetched, cached = await load_batch(
                            request.app, product, bounds, day, today
                        )
                        if getattr(features, "coverage_state", "complete") != "complete":
                            failures.append({"date": day.isoformat(), "detail": "Stored global reporting window is partial; available observations are included."})
                        day_features.extend(features)
                        day_fetched.append(fetched)
                        day_cache_hits += cached
                except FIRMSFailure as exc:
                    failures.append({"date": day.isoformat(), "detail": str(exc)})
                    continue
                batches.append(day_features)
                fetched_at.extend(day_fetched)
                successful_days += 1
                cache_hits += day_cache_hits
            selected_features = await asyncio.to_thread(
                filter_features,
                batches,
                lower,
                upper,
                zone,
                daynight,
                modis_min_confidence,
                viirs_min_confidence,
                selected_geometry,
            )
            selected_count = len(selected_features)
        report = {
            "source": product.value,
            "status": ("partial" if fetched_at else "error") if failures else "ok",
            "count": selected_count,
            "successful_days": successful_days,
            "cache_hits": cache_hits,
            "oldest_fetched_at": (
                datetime.fromtimestamp(min(fetched_at), UTC).isoformat() if fetched_at else None
            ),
            "failed_days": failures,
        }
        return (product_summary if summary else selected_features), report

    results = await asyncio.gather(*(load_product(product) for product in sources))
    reports = [report for _, report in results]
    if all(report["status"] == "error" for report in reports):
        raise HTTPException(502, detail={"sources": reports})

    if summary:
        combined_summary = AreaAnalyticsSummary()
        for product_summary, _ in results:
            combined_summary.merge(product_summary)
        results.clear()
        summary_payload = combined_summary.payload(dates, zone)
        features = summary_payload.pop("features")
        return {
            "type": "FeatureCollection",
            "features": features,
            "count": combined_summary.count,
            "partial": any(report["status"] != "ok" for report in reports),
            "sources": reports,
            "window": {
                "start_utc": lower.isoformat(),
                "end_utc_exclusive": upper.isoformat(),
                "timezone": zone.key,
            },
            "summary": summary_payload,
        }

    features = [feature for selected, _ in results for feature in selected]
    features.sort(key=lambda feature: feature["properties"]["acquired_at"], reverse=True)
    return {
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "partial": any(report["status"] != "ok" for report in reports),
        "sources": reports,
        "window": {"start_utc": lower.isoformat(), "end_utc_exclusive": upper.isoformat(), "timezone": zone.key},
    }


@app.post("/hotspots/area")
async def hotspots_for_analysis_area(request: Request, query: AreaHotspotsQuery):
    return await hotspots(
        request,
        area="custom",
        days=query.days,
        start_date=query.start_date,
        start=None,
        end=None,
        tz=None,
        daynight=query.daynight,
        source=query.source,
        modis_min_confidence=query.modis_min_confidence,
        viirs_min_confidence=query.viirs_min_confidence,
        summary=query.summary,
        geometry_json=json.dumps(query.geometry, separators=(",", ":")),
    )


@app.post("/hotspots/stream")
async def stream_area_analytics_hotspots(
    request: Request, query: AreaAnalyticsHotspotsQuery
):
    if not query.summary:
        raise HTTPException(422, "Streaming Area Analytics requests require summary=true.")
    require_firms_or_global(request)
    events: asyncio.Queue[dict | None] = asyncio.Queue()

    async def publish_progress(progress: dict):
        await events.put({"type": "progress", **progress})

    request.state.area_analytics_progress = publish_progress

    async def load_result():
        try:
            result = await hotspots(
                request,
                area="custom" if query.geometry is not None else query.area,
                days=query.days,
                start_date=query.start_date,
                start=None,
                end=None,
                tz=None,
                daynight=query.daynight,
                source=query.source,
                modis_min_confidence=query.modis_min_confidence,
                viirs_min_confidence=query.viirs_min_confidence,
                summary=True,
                geometry_json=(
                    json.dumps(query.geometry, separators=(",", ":"))
                    if query.geometry is not None
                    else None
                ),
            )
            await events.put({"type": "result", "data": result})
        except HTTPException as exc:
            await events.put({"type": "error", "detail": exc.detail})
        except Exception:
            logging.exception("Area Analytics progress stream failed.")
            await events.put({"type": "error", "detail": "Hotspot processing failed unexpectedly."})
        finally:
            await events.put(None)

    task = asyncio.create_task(load_result())

    async def event_stream():
        try:
            while True:
                event = await events.get()
                if event is None:
                    break
                yield json.dumps(event, separators=(",", ":")) + "\n"
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/capabilities")
def analysis_capabilities():
    try:
        store = store_from_environment()
        from historical_activity import load_archive
        from activity_outlook import TARGET
        manifest, archive = load_archive()
        historical_available = bool(manifest and archive and archive.coverage)
        capabilities = capabilities_payload(store)
        capabilities.update({
            "summaries": True,
            "exportFormats": ["csv", "geojson", "json"],
            "seasonal": historical_available,
            "historical": {"available": historical_available,
                "datasetVersion": manifest.get("datasetVersion") if manifest else None,
                "regionId": manifest.get("regionId") if manifest else None,
                "coverageStart": min(item.day for item in archive.coverage).isoformat() if historical_available else None,
                "coverageEndInclusive": max(item.day for item in archive.coverage).isoformat() if historical_available else None},
            "forecast": {"target": TARGET, "horizonHours": 24,
                "availability": "region-and-validation-dependent" if historical_available else "unavailable"},
        })
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=422)
    except RuntimeError as exc:
        return JSONResponse({"message": str(exc)}, status_code=502)
    return capabilities


PLATFORM_PRODUCTS = {
    "terra": ("MODIS_NRT", "MODIS_SP"),
    "aqua": ("MODIS_NRT", "MODIS_SP"),
    "suomi-npp": ("VIIRS_SNPP_NRT", "VIIRS_SNPP_SP"),
    "noaa-20": ("VIIRS_NOAA20_NRT", "VIIRS_NOAA20_SP"),
    "noaa-21": ("VIIRS_NOAA21_NRT", "VIIRS_NOAA21_SP"),
}
LIVE_ANALYSIS_DAYS = 31


def platform_from_satellite(value: str) -> str | None:
    token = value.strip().upper().replace(" ", "").replace("_", "-")
    return {
        "T": "terra",
        "TERRA": "terra",
        "A": "aqua",
        "AQUA": "aqua",
        "N": "suomi-npp",
        "SNPP": "suomi-npp",
        "S-NPP": "suomi-npp",
        "SUOMI-NPP": "suomi-npp",
        "N20": "noaa-20",
        "NOAA-20": "noaa-20",
        "NOAA20": "noaa-20",
        "JPSS-1": "noaa-20",
        "J1": "noaa-20",
        "N21": "noaa-21",
        "NOAA-21": "noaa-21",
        "NOAA21": "noaa-21",
        "JPSS-2": "noaa-21",
        "J2": "noaa-21",
    }.get(token)


def feature_to_detection(feature: dict) -> Detection | None:
    props = feature.get("properties") if isinstance(feature, dict) else None
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    if not isinstance(props, dict) or not isinstance(geometry, dict):
        return None
    platform = platform_from_satellite(str(props.get("satellite") or ""))
    coordinates = geometry.get("coordinates")
    if platform is None or not isinstance(coordinates, list) or len(coordinates) < 2:
        return None
    acquired = datetime.fromisoformat(str(props["acquired_at"]).replace("Z", "+00:00"))
    modis = props.get("sensor") == "MODIS"
    confidence = props.get("confidence")
    return Detection(
        platform,
        float(coordinates[1]),
        float(coordinates[0]),
        acquired,
        None if props.get("frp_mw") is None else float(props["frp_mw"]),
        None if modis else props.get("confidence_class"),
        int(confidence) if modis and isinstance(confidence, int) else None,
        props.get("daynight"),
        None if props.get("scan_km") is None else float(props["scan_km"]),
        None if props.get("track_km") is None else float(props["track_km"]),
        None if props.get("nominal_resolution_m") is None else float(props["nominal_resolution_m"]),
        str(props["source"]) if props.get("source") else None,
        str(props["version"]) if props.get("version") else None,
        str(props["processing"]) if props.get("processing") else None,
    )


async def product_windows(app: FastAPI) -> dict[str, tuple[date, date]]:
    cached = getattr(app.state, "product_windows", None)
    if cached is not None and cached[0] > clock.time() - 3600:
        return cached[1]
    text = await fetch_csv(app, f"/api/data_availability/csv/{app.state.key}/ALL")
    windows: dict[str, tuple[date, date]] = {}
    for row in csv_rows(text, {"data_id", "min_date", "max_date"}):
        try:
            windows[row["data_id"]] = (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
        except ValueError:
            continue
    app.state.product_windows = (clock.time(), windows)
    return windows


def product_on(platform: str, day: date, windows: dict[str, tuple[date, date]]) -> Source | None:
    for name in PLATFORM_PRODUCTS.get(platform, ()):
        window = windows.get(name)
        if window is not None and window[0] <= day <= window[1]:
            return Source(name)
    return None


def validate_acquisition_longitudes(geometry: dict) -> None:
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise RejectedQuery("Analysis area must be a Polygon or MultiPolygon.")
    polygons = [geometry.get("coordinates")] if geometry["type"] == "Polygon" else geometry.get("coordinates")
    try:
        longitudes = [float(position[0]) for polygon in polygons for ring in polygon for position in ring]
    except (TypeError, ValueError, IndexError) as exc:
        raise RejectedQuery("Analysis area contains invalid coordinates.") from exc
    if not longitudes or any(not math.isfinite(value) or value < -180 or value > 180 for value in longitudes):
        raise RejectedQuery("Analysis area longitude must stay between -180 and 180 degrees.")
    linear_span = max(longitudes) - min(longitudes)
    if linear_span <= 180:
        return
    circular = sorted({value % 360 for value in longitudes})
    largest_gap = max(circular[(index + 1) % len(circular)] + (360 if index == len(circular) - 1 else 0) - value for index, value in enumerate(circular))
    if 360 - largest_gap < 180:
        raise RejectedQuery("This area crosses 180 degrees longitude. Live analysis currently supports one side of the date line per query.")


def stored_global_aoi(app, query, bbox):
    """Reuse durable source/day reporting partitions; never performs acquisition."""
    global_store = getattr(app.state, "global_store", None)
    if global_store is None:
        return None
    try:
        manifest = global_store.current_manifest("7d")
        interval = query.get("interval", {})
        lower = datetime.fromisoformat(interval.get("start", "").replace("Z", "+00:00"))
        upper = datetime.fromisoformat(interval.get("endExclusive", "").replace("Z", "+00:00"))
        selected_window = manifest.get("interval", {})
        anchor = datetime.fromisoformat(selected_window.get("endUtcExclusive", "").replace("Z", "+00:00"))
        available_start = datetime.fromisoformat(selected_window.get("startUtc", "").replace("Z", "+00:00"))
        current_day_end = datetime.combine(anchor.date() + timedelta(days=1), time.min, UTC)
        if not manifest.get("snapshot") or not available_start <= lower < anchor or not lower < upper <= current_day_end:
            return None
        stored = global_store.canonical_store(manifest["snapshot"], "7d", bbox, {"platforms": acquisition_platforms(query)}, max_rows=MAX_CANONICAL_ACQUISITION_ROWS)
        return stored if stored.coverage else None
    except (ValueError, TypeError, KeyError) as exc:
        if "budget" in str(exc).lower() or "canonical observations" in str(exc).lower():
            raise RejectedQuery(str(exc)) from exc
        return None


async def firms_canonical_store(app: FastAPI, query: dict, bbox: tuple[float, float, float, float], started: asyncio.Event | None = None) -> CanonicalStore:
    validate_acquisition_longitudes(query.get("aoi", {}).get("geometry"))
    try:
        start, end = parse_utc_interval(query.get("interval"))
    except ValueError as exc:
        raise RejectedQuery(str(exc)) from exc
    if (end - start).days > LIVE_ANALYSIS_DAYS:
        raise RejectedQuery("Live FIRMS analysis accepts at most 31 UTC days. Narrow the date range.")
    selected = acquisition_platforms(query)
    stored = await asyncio.to_thread(stored_global_aoi, app, query, bbox)
    already_covered = {(record.day, record.platform) for record in stored.coverage} if stored else set()
    missing = [(platform, start + timedelta(days=offset)) for platform in selected for offset in range((end - start).days) if (start + timedelta(days=offset), platform) not in already_covered]
    windows = await product_windows(app) if missing else {}
    bounds = ",".join(format(Decimal(str(value)), "f") for value in bbox)
    today = datetime.now(UTC).date()
    jobs: dict[tuple[Source, date], set[str]] = {}
    unavailable = []
    for platform in selected:
        cursor = start
        while cursor < end:
            if (cursor, platform) in already_covered:
                cursor += timedelta(days=1)
                continue
            product = product_on(platform, cursor, windows)
            if product is not None:
                jobs.setdefault((product, cursor), set()).add(platform)
            cursor += timedelta(days=1)

    async def run(product: Source, day: date, covered: set[str]):
        try:
            features, fetched, cached = await load_batch(app, product, bounds, day, today, started)
            expires = fetched + batch_ttl(product, day, today)
            try:
                persisted_expiry = await asyncio.to_thread(app.state.cache.expires_at, app.state.cache.key(product.value, bounds, day.isoformat()), fetched)
                if persisted_expiry is not None:
                    expires = min(expires, persisted_expiry)
            except (sqlite3.Error, AttributeError):
                pass
            return features, [Coverage(day, item, "complete") for item in covered], None, fetched, expires, cached
        except FIRMSFailure as exc:
            return [], [Coverage(day, item, "partial") for item in covered], str(exc), None, clock.time() + 30, False

    workers = asyncio.Semaphore(4)
    async def bounded(product: Source, day: date, covered: set[str]):
        async with workers:
            return await run(product, day, covered)
    pending = [asyncio.create_task(bounded(product, day, covered)) for (product, day), covered in jobs.items()]
    loaded = [(None, stored.coverage, None, stored.fetched_at, stored.expires_at, True)] if stored else []
    coverage = [*stored.coverage, *unavailable] if stored else list(unavailable)
    rows = {(row.platform, row.acquired_at, row.longitude, row.latitude): row for row in stored.rows} if stored else {}
    try:
        for completed in asyncio.as_completed(pending):
            features, records, error, fetched, expires, cached = await completed
            coverage.extend(records)
            loaded.append((None, records, error, fetched, expires, cached))
            for feature in features:
                try:
                    row = feature_to_detection(feature)
                except (TypeError, ValueError, KeyError):
                    continue
                if row is not None and start <= row.acquired_at.astimezone(UTC).date() < end:
                    identity = (row.platform, row.acquired_at, row.longitude, row.latitude)
                    rows[identity] = row
                    if len(rows) > MAX_CANONICAL_ACQUISITION_ROWS:
                        raise RejectedQuery("This bounding region exceeds the 200,000 candidate-observation acquisition budget. Select a smaller region or shorter period; no records were truncated.")
    finally:
        for task in pending:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    errors = [error for _, _, error, *_ in loaded if error]
    if jobs and errors and not rows and all(record.state != "complete" for record in coverage):
        raise RuntimeError(errors[0])
    fetched = [item[3] for item in loaded if item[3] is not None]
    return CanonicalStore(
        tuple(sorted(rows.values(), key=lambda row: (row.acquired_at, row.platform, row.longitude, row.latitude))), tuple(sorted(coverage, key=lambda record: (record.day, record.platform))),
        "NASA FIRMS daily area batches. Exact point-in-polygon filtering follows acquisition.",
        min(fetched) if fetched else None,
        min((item[4] for item in loaded), default=clock.time() + 300),
        bool(loaded) and all(item[5] for item in loaded),
    )


@dataclass
class FirmsStoreEntry:
    store: CanonicalStore
    size: int


@dataclass
class FirmsStoreTask:
    task: asyncio.Task
    started: asyncio.Event
    waiters: int = 0


MAX_CANONICAL_ACQUISITION_ROWS = 200_000
MAX_FIRMS_STORES = 4
MAX_FIRMS_STORE_ROWS = 200_000
MAX_FIRMS_STORE_BYTES = 64 * 1024 * 1024
_FIRMS_STORES: OrderedDict[tuple, FirmsStoreEntry] = OrderedDict()
_FIRMS_TASKS: dict[tuple, FirmsStoreTask] = {}


def acquisition_platforms(query: dict) -> tuple[str, ...]:
    filters = query.get("filters") if isinstance(query.get("filters"), dict) else {}
    requested = filters.get("platforms")
    selected = {item for item in requested if item in PLATFORM_PRODUCTS} if isinstance(requested, list) else set()
    return tuple(sorted(selected or {"aqua", "suomi-npp", "noaa-20", "noaa-21"}))


def firms_store_key(query: dict, bbox: tuple[float, float, float, float]) -> tuple:
    start, end = parse_utc_interval(query.get("interval"))
    return tuple(float(value) for value in bbox), start, end, acquisition_platforms(query)


def retain_firms_store(key: tuple, store: CanonicalStore):
    now = clock.time()
    for cached_key, entry in list(_FIRMS_STORES.items()):
        if entry.store.expires_at is None or entry.store.expires_at <= now:
            del _FIRMS_STORES[cached_key]
    size = len(store.rows) * 1024 + len(store.coverage) * 256 + len(store.source)
    if len(store.rows) > MAX_FIRMS_STORE_ROWS or size > MAX_FIRMS_STORE_BYTES or store.expires_at is None or store.expires_at <= now:
        return
    _FIRMS_STORES[key] = FirmsStoreEntry(store, size)
    _FIRMS_STORES.move_to_end(key)
    while len(_FIRMS_STORES) > MAX_FIRMS_STORES or sum(len(entry.store.rows) for entry in _FIRMS_STORES.values()) > MAX_FIRMS_STORE_ROWS or sum(entry.size for entry in _FIRMS_STORES.values()) > MAX_FIRMS_STORE_BYTES:
        _FIRMS_STORES.popitem(last=False)


async def shared_firms_store(app: FastAPI, query: dict, bbox: tuple[float, float, float, float]) -> CanonicalStore:
    try:
        key = (id(app), *firms_store_key(query, bbox))
    except ValueError as exc:
        raise RejectedQuery(str(exc)) from exc
    entry = _FIRMS_STORES.get(key)
    if entry is not None:
        if entry.store.expires_at is not None and entry.store.expires_at > clock.time():
            _FIRMS_STORES.move_to_end(key)
            return replace(entry.store, cache_hit=True)
        del _FIRMS_STORES[key]
    shared = _FIRMS_TASKS.get(key)
    if shared is None:
        started = asyncio.Event()
        async def acquire():
            store = await firms_canonical_store(app, query, bbox, started)
            retain_firms_store(key, store)
            return store
        task = asyncio.create_task(acquire())
        shared = FirmsStoreTask(task, started)
        _FIRMS_TASKS[key] = shared
        def completed(done: asyncio.Task):
            if _FIRMS_TASKS.get(key) is shared:
                _FIRMS_TASKS.pop(key, None)
            if not done.cancelled():
                done.exception()
        task.add_done_callback(completed)
    shared.waiters += 1
    try:
        return await asyncio.shield(shared.task)
    finally:
        shared.waiters -= 1
        if shared.waiters == 0 and not shared.task.done():
            shared.task.cancel()


async def analysis_document(request: Request, build):
    try:
        body = await request.json()
    except ClientDisconnect:
        return JSONResponse({"message": "The browser closed the analysis request before it was read."}, status_code=499)
    except ValueError:
        return JSONResponse({"message": "The analysis request must be JSON."}, status_code=422)
    if not isinstance(body, dict):
        body = {}
    query = body.get("query")
    geometry = query.get("aoi", {}).get("geometry") if isinstance(query, dict) and isinstance(query.get("aoi"), dict) else None
    bbox = geometry_bbox(geometry) if isinstance(geometry, dict) else None
    try:
        if not isinstance(query, dict):
            raise RejectedQuery("Analysis query identity is required.")
        options = body.get("options") if isinstance(body.get("options"), dict) else {}
        # Interaction with an already investigated source must not turn expiry
        # into a new FIRMS acquisition. Refreshing the map is explicit.
        interaction = request.url.path in {"/analysis/observations", "/analysis/observations/export", "/analysis/method", "/analysis/recurrence"}
        frozen_request = (bool(options.get("selectionToken"))
            or request.url.path in {"/analysis/selections", "/analysis/observations/export", "/analysis/recurrence"}
            or interaction and has_snapshot(query)
            or request.url.path == "/analysis/observations" and isinstance(options.get("page"), int) and options["page"] > 1)
        store = cached_snapshot(query, options) if frozen_request else store_from_environment(bbox)
        global_reused = False
        if not frozen_request and not store.rows and not store.coverage and isinstance(bbox, tuple):
            stored = await asyncio.to_thread(stored_global_aoi, request.app, query, bbox)
            if stored is not None:
                store = stored
                global_reused = True
        if not frozen_request and not store.rows and not store.coverage and os.environ.get("SHARP_HISTORY_PATH"):
            from historical_activity import load_archive, supports_geometry
            try:
                manifest, archived = await asyncio.to_thread(load_archive)
                first, last = parse_utc_interval(query.get("interval"))
                covered_days = [record.day for record in archived.coverage] if archived is not None else []
                if manifest is not None and covered_days and supports_geometry(manifest, geometry) and min(covered_days) <= first and last <= max(covered_days) + timedelta(days=1):
                    store = archived
            except ValueError as exc:
                raise RejectedQuery(str(exc)) from exc
        needs_supplement = False
        if global_reused:
            first, last = parse_utc_interval(query.get("interval"))
            known = {(record.day, record.platform) for record in store.coverage}
            needs_supplement = any((first + timedelta(days=offset), platform) not in known for platform in acquisition_platforms(query) for offset in range((last-first).days))
        if not frozen_request and request.app.state.key and (not store.rows and not store.coverage or needs_supplement) and isinstance(bbox, tuple):
            validate_acquisition_longitudes(geometry)
            store = await shared_firms_store(request.app, query, bbox)
        interval = query.get("interval", {})
        try:
            lower = datetime.fromisoformat(str(interval.get("start", "")).replace("Z", "+00:00"))
            upper = datetime.fromisoformat(str(interval.get("endExclusive", "")).replace("Z", "+00:00"))
        except (ValueError, AttributeError) as exc:
            raise RejectedQuery("Analysis requires a UTC interval.") from exc
        if lower.tzinfo is None or upper.tzinfo is None or upper <= lower:
            raise RejectedQuery("Analysis requires a valid start-inclusive/end-exclusive interval.")
        partial_start = any((lower.hour, lower.minute, lower.second, lower.microsecond))
        partial_end = any((upper.hour, upper.minute, upper.second, upper.microsecond))
        if partial_start or partial_end:
            store = CanonicalStore(
                tuple(
                    row for row in store.rows
                    if (not partial_start or row.acquired_at.date() != lower.date() or row.acquired_at >= lower)
                    and (not partial_end or row.acquired_at.date() != upper.date() or row.acquired_at < upper)
                ),
                store.coverage,
                store.source,
                store.fetched_at,
                store.expires_at,
                store.cache_hit,
            )
        document = await asyncio.to_thread(build, query, store, body)
        if isinstance(document, StreamingResponse):
            return document
        if not frozen_request:
            remember_snapshot(query, store)
        now = clock.time()
        as_utc = lambda value: datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z") if value is not None else None
        metadata = document.setdefault("meta", {})
        selected_area = prepared_area(geometry)
        selected_filters = filters_from_query(query.get("filters") if isinstance(query.get("filters"), dict) else {})
        focused_day = body.get("options", {}).get("day") if isinstance(body.get("options"), dict) else None
        newest = max((row.acquired_at for row in store.rows if lower <= row.acquired_at < upper and (focused_day is None or row.acquired_at.date().isoformat() == focused_day) and observation_kept(row, selected_filters) and selected_area.contains(row.longitude, row.latitude)), default=None)
        metadata.update({
            "sourceGeneration": source_generation(store),
            "generatedAt": as_utc(now),
            "fetchedAt": as_utc(store.fetched_at),
            "expiresAt": as_utc(store.expires_at),
            "newestObservationAt": newest.isoformat().replace("+00:00", "Z") if newest is not None else None,
            "freshness": "unknown" if store.fetched_at is None else "fresh" if store.expires_at is not None and store.expires_at > now else "stale",
            "acquisitionCacheHit": store.cache_hit,
        })
        if store.source.startswith("Regional archive "):
            metadata["datasetVersion"] = store.source.removeprefix("Regional archive ")
            metadata["freshness"] = "archived"
        return document
    except SelectionInvalid as exc:
        return JSONResponse({"message": str(exc), "code": "selection-invalid"}, status_code=409)
    except RejectedQuery as exc:
        return JSONResponse({"message": str(exc)}, status_code=422)
    except RuntimeError as exc:
        return JSONResponse({"message": str(exc)}, status_code=502)


@app.post("/analysis/calendar")
async def analysis_calendar(request: Request):
    return await analysis_document(request, lambda query, store, _body: calendar_document(query, store))


@app.post("/analysis/overview")
async def analysis_overview(request: Request):
    return await analysis_document(request, lambda query, store, _body: overview_document(query, store))


@app.post("/analysis/time-series")
async def analysis_time_series(request: Request):
    return await analysis_document(request, lambda query, store, _body: time_series_document(query, store))


@app.post("/analysis/observations")
async def analysis_observations(request: Request):
    return await analysis_document(request, explorer_document)


@app.post("/analysis/observation")
async def analysis_observation(request: Request):
    return await analysis_document(request, lambda query, store, body: observation_document(query, store, body))


@app.post("/analysis/map-source")
async def analysis_map_source(request: Request):
    return await analysis_document(request, lambda query, store, body: map_source_document(query, store, body))


@app.post("/analysis/selections")
async def analysis_selection(request: Request):
    return await analysis_document(request, freeze_document)


@app.post("/analysis/observations/export")
async def analysis_observations_export(request: Request):
    return await analysis_document(request, export_document)


from scientific_routes import register_scientific_routes
from global_routes import register_global_routes

register_scientific_routes(app, analysis_document)
register_global_routes(app)
