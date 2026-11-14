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
from contextlib import asynccontextmanager
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
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from cache import BatchCache
from dashboard_summary import DashboardSummary
from harmonize import (
    CanonicalStore,
    Coverage,
    Detection,
    RejectedQuery,
    calendar_document,
    capabilities_payload,
    geometry_bbox,
    geometry_contains,
    map_source_document,
    observation_document,
    observations_document,
    overview_document,
    parse_utc_interval,
    store_from_environment,
    time_series_document,
)
from query_time import query_window, timezone

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


class AreaHotspotsQuery(BaseModel):
    geometry: dict
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
    app.state.key = quote(key, safe="") if key else ""
    default_path = Path(tempfile.gettempdir()) / "firms-hotspots" / "cache.sqlite3"
    app.state.cache = await asyncio.to_thread(
        BatchCache, Path(os.getenv("FIRMS_CACHE_PATH", str(default_path)))
    )
    app.state.batch_locks = [asyncio.Lock() for _ in range(64)]
    async with httpx.AsyncClient(
        base_url=FIRMS_URL,
        timeout=httpx.Timeout(120, connect=10),
        limits=httpx.Limits(max_connections=8),
        follow_redirects=False,
    ) as client:
        app.state.firms = client
        app.state.slots = asyncio.Semaphore(8)
        yield
app = FastAPI(title="FIRMS Hotspots", lifespan=lifespan)

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


async def fetch_csv(app: FastAPI, path: str) -> str:
    try:
        async with app.state.slots, asyncio.timeout(150):
            async with app.state.firms.stream("GET", path) as response:
                if response.status_code in (401, 403):
                    raise FIRMSFailure("FIRMS rejected the map key or access.")
                if response.status_code == 429:
                    raise FIRMSFailure("FIRMS rate limit reached.")
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
                confidence = int(confidence)
                if not 0 <= confidence <= 100:
                    raise ValueError("Invalid MODIS confidence")
            elif confidence not in VIIRS_RANKS:
                raise ValueError("Invalid VIIRS confidence")

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
                    "confidence_scale": "0–100" if is_modis else "low/nominal/high",
                    "confidence_class": None if is_modis else VIIRS_CLASSES[confidence],
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
        text = await fetch_csv(app, f"/api/data_availability/csv/{app.state.key}/ALL")
        products = []
        allowed = {source.value for source in Source}
        for row in csv_rows(text, {"data_id", "min_date", "max_date"}):
            if row["data_id"] in allowed:
                products.append({
                    "source": row["data_id"],
                    "min_date": date.fromisoformat(row["min_date"]),
                    "max_date": date.fromisoformat(row["max_date"]),
                })
        return {"products": products}
    except FIRMSFailure as exc:
        raise HTTPException(502, str(exc)) from None
    except (csv.Error, TypeError, ValueError):
        raise HTTPException(502, "FIRMS returned malformed availability CSV.") from None


async def load_batch(app: FastAPI, product: Source, bounds: str, day: date, today: date):
    key = app.state.cache.key(product.value, bounds, day.isoformat())
    async with app.state.batch_locks[hash(key) % len(app.state.batch_locks)]:
        try:
            cached = await asyncio.to_thread(app.state.cache.get, key)
            if cached is not None:
                features, fetched = cached
                return features, fetched, True
        except (sqlite3.Error, ValueError, zlib.error):
            logging.warning("Could not read FIRMS cache; fetching from NASA.")

        path = f"/api/area/csv/{app.state.key}/{product.value}/{bounds}/1"
        if day != today or product.value.endswith("_SP"):
            path += f"/{day.isoformat()}"
        text = await fetch_csv(app, path)
        fetched = clock.time()
        features = await asyncio.to_thread(parse_features, text, product)
        # Keep a rolling-day request made across midnight out of the wrong cache entry.
        if any(feature["properties"]["acquired_at"][:10] != day.isoformat() for feature in features):
            raise FIRMSFailure("FIRMS returned data outside the requested UTC day; retry the query.")
        if day == today and datetime.fromtimestamp(fetched, UTC).date() != today:
            raise FIRMSFailure("The UTC day changed during retrieval; retry the query.")
        if product.value.endswith("_SP"):
            ttl = 7 * 86400
        elif day >= today - timedelta(days=1):
            ttl = 300
        else:
            ttl = 86400
        try:
            await asyncio.to_thread(app.state.cache.put, key, features, fetched, ttl)
        except sqlite3.Error:
            logging.warning("Could not write FIRMS cache; serving data from NASA.")
        return features, fetched, False


def filter_features(
    batches, lower, upper, zone, daynight, modis_min, viirs_min, geometry=None
):
    features = []
    for batch in batches:
        for feature in batch:
            props = feature["properties"]
            acquired = datetime.fromisoformat(props["acquired_at"])
            if not lower <= acquired < upper:
                continue
            if geometry and not geometry_contains(
                *feature["geometry"]["coordinates"], geometry
            ):
                continue
            if daynight != "all" and props["daynight"] != {"day": "D", "night": "N"}[daynight]:
                continue
            confidence = props["confidence"]
            if props["sensor"] == "MODIS" and confidence < modis_min:
                continue
            if props["sensor"] == "VIIRS" and VIIRS_RANKS[confidence] < VIIRS_RANKS[viirs_min]:
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
    require_firms_key(request)
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

    async def load_product(product: Source):
        batches = []
        fetched_at = []
        cache_hits = 0
        failures = []
        product_summary = DashboardSummary() if summary else None

        async def load_summary_day(day: date):
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
            if len(batch_keys) == 1:
                try:
                    cached_summary = await asyncio.to_thread(
                        request.app.state.cache.get_summary, summary_key, batch_keys[0]
                    )
                    if cached_summary is not None:
                        summary_json, fetched = cached_summary
                        try:
                            daily_summary = DashboardSummary.from_cache(summary_json)
                            return day, daily_summary, [fetched], 1, None
                        except (KeyError, TypeError, ValueError):
                            logging.warning("Could not read dashboard summary cache; recalculating.")
                except sqlite3.Error:
                    logging.warning("Could not read dashboard summary cache; recalculating.")

            features = []
            fetched_values = []
            cache_hits_for_day = 0
            for bounds in area_bounds:
                try:
                    batch, fetched, batch_cached = await load_batch(
                        request.app, product, bounds, day, today
                    )
                except FIRMSFailure as exc:
                    return day, None, None, 0, str(exc)
                features.extend(batch)
                fetched_values.append(fetched)
                cache_hits_for_day += batch_cached
            daily_summary = DashboardSummary()
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
            if len(batch_keys) == 1:
                try:
                    await asyncio.to_thread(
                        request.app.state.cache.put_summary,
                        summary_key,
                        batch_keys[0],
                        daily_summary.to_cache(),
                        min(fetched_values),
                    )
                except sqlite3.Error:
                    logging.warning("Could not write dashboard summary cache; serving calculated data.")
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
        combined_summary = DashboardSummary()
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


@app.get("/capabilities")
def analysis_capabilities():
    try:
        store = store_from_environment()
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=422)
    except RuntimeError as exc:
        return JSONResponse({"message": str(exc)}, status_code=502)
    return capabilities_payload(store)


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


async def firms_canonical_store(app: FastAPI, query: dict, bbox: tuple[float, float, float, float]) -> CanonicalStore:
    try:
        start, end = parse_utc_interval(query.get("interval"))
    except ValueError as exc:
        raise RejectedQuery(str(exc)) from exc
    if (end - start).days > LIVE_ANALYSIS_DAYS:
        raise RejectedQuery("Live FIRMS analysis accepts at most 31 UTC days. Narrow the date range.")
    requested = query.get("filters", {}).get("platforms") if isinstance(query.get("filters"), dict) else None
    selected = [item for item in requested if item in PLATFORM_PRODUCTS] if isinstance(requested, list) else []
    if not selected:
        selected = ["aqua", "suomi-npp", "noaa-20", "noaa-21"]
    windows = await product_windows(app)
    bounds = ",".join(format(Decimal(str(value)), "f") for value in bbox)
    jobs: list[tuple[Source | None, date, int, tuple[str, ...]]] = []
    seen: set[tuple[str | None, date, int]] = set()
    for platform in selected:
        cursor = start
        while cursor < end:
            product = product_on(platform, cursor, windows)
            span = 1
            while span < 5 and cursor + timedelta(days=span) < end and product_on(platform, cursor + timedelta(days=span), windows) == product:
                span += 1
            identity = (None if product is None else product.value, cursor, span)
            if identity not in seen:
                seen.add(identity)
                covered = tuple(
                    item for item in selected
                    if product is not None and product.value in PLATFORM_PRODUCTS[item]
                )
                jobs.append((product, cursor, span, covered))
            cursor += timedelta(days=span)

    async def run(product: Source | None, cursor: date, span: int, covered: tuple[str, ...]):
        days = [cursor + timedelta(days=offset) for offset in range(span) if cursor + timedelta(days=offset) < end]
        if product is None:
            return [], [], None
        path = f"/api/area/csv/{app.state.key}/{product.value}/{bounds}/{span}/{cursor.isoformat()}"
        try:
            text = await fetch_csv(app, path)
            features = await asyncio.to_thread(parse_features, text, product)
        except FIRMSFailure as exc:
            return [], [Coverage(day, item, "partial") for day in days for item in covered], str(exc)
        return features, [Coverage(day, item, "complete") for day in days for item in covered], None

    loaded = await asyncio.gather(*(run(*job) for job in jobs))
    features = [feature for batch, _, _ in loaded for feature in batch]
    coverage = [record for _, records, _ in loaded for record in records]
    errors = [error for _, _, error in loaded if error]
    rows = []
    for feature in features:
        try:
            row = feature_to_detection(feature)
        except (TypeError, ValueError):
            continue
        if row is not None and start <= row.acquired_at.astimezone(UTC).date() < end:
            rows.append(row)
    if jobs and errors and not rows and all(record.state != "complete" for record in coverage):
        raise RuntimeError(errors[0])
    return CanonicalStore(
        tuple(rows),
        tuple(coverage),
        "NASA FIRMS area API for this bounding box. Points are kept only when they fall inside the analysis polygon.",
    )


_FIRMS_STORES: dict[tuple, CanonicalStore] = {}
_FIRMS_TASKS: dict[tuple, asyncio.Task] = {}


def firms_store_key(query: dict, bbox: tuple[float, float, float, float]) -> tuple:
    interval = query.get("interval") if isinstance(query.get("interval"), dict) else {}
    filters = query.get("filters") if isinstance(query.get("filters"), dict) else {}
    platforms = filters.get("platforms") if isinstance(filters.get("platforms"), list) else []
    viirs = filters.get("viirsConfidence") if isinstance(filters.get("viirsConfidence"), list) else []
    return (
        tuple(round(float(value), 4) for value in bbox),
        str(interval.get("start")),
        str(interval.get("endExclusive")),
        tuple(sorted(item for item in platforms if isinstance(item, str))),
        str(filters.get("dayNight")),
        filters.get("modisConfidenceMin"),
        tuple(sorted(item for item in viirs if isinstance(item, str))),
        filters.get("frpMin"),
        filters.get("frpMax"),
    )


async def shared_firms_store(app: FastAPI, query: dict, bbox: tuple[float, float, float, float]) -> CanonicalStore:
    key = firms_store_key(query, bbox)
    ready = _FIRMS_STORES.get(key)
    if ready is not None:
        return ready
    task = _FIRMS_TASKS.get(key)
    if task is None:
        task = asyncio.create_task(firms_canonical_store(app, query, bbox))
        _FIRMS_TASKS[key] = task
    try:
        store = await task
    except Exception:
        _FIRMS_TASKS.pop(key, None)
        raise
    _FIRMS_STORES[key] = store
    _FIRMS_TASKS.pop(key, None)
    while len(_FIRMS_STORES) > 4:
        _FIRMS_STORES.pop(next(iter(_FIRMS_STORES)))
    return store


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
        store = store_from_environment(bbox)
        if request.app.state.key and not store.rows and not store.coverage and isinstance(bbox, tuple):
            store = await shared_firms_store(request.app, query, bbox)
        return await asyncio.to_thread(build, query, store, body)
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
    return await analysis_document(request, lambda query, store, body: observations_document(query, store, body))


@app.post("/analysis/observation")
async def analysis_observation(request: Request):
    return await analysis_document(request, lambda query, store, body: observation_document(query, store, body))


@app.post("/analysis/map-source")
async def analysis_map_source(request: Request):
    return await analysis_document(request, lambda query, store, body: map_source_document(query, store, body))
