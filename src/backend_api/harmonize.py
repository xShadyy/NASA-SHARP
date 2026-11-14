"""Harmonized daily burning activity for MODIS Aqua and VIIRS.

Each value is a count of 2 km equal-area cells on the afternoon orbit.
Aqua, Suomi NPP, NOAA-20, and NOAA-21 are kept. Terra is omitted because its
morning orbit has no VIIRS counterpart across the record. Several detections
in one cell count once, and several afternoon satellites on that cell still
count once.

On a day with stored VIIRS coverage the value is the VIIRS cell union. Aqua
is not added on top. On an earlier Aqua day the value is the Aqua cell count
times one scale: the median of daily VIIRS cells / Aqua cells on stored
overlap days for the same area and filters. The scale uses the whole stored
overlap, not only the dates in the request. Raw pixel counts are never added
across sensors.
"""

from __future__ import annotations

import csv
import math
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from statistics import median

METHOD_VERSION = "afternoon-active-cells-2km-1"
DATASET_VERSION = "local-canonical-1"
MIN_OVERLAP_DAYS = 14
CELL_SIZE_M = 2000.0
EARTH_RADIUS_M = 6371007.2

PLATFORM_IDS = {"T": "terra", "A": "aqua", "N": "suomi-npp", "N20": "noaa-20", "N21": "noaa-21"}
PLATFORM_CODES = {value: key for key, value in PLATFORM_IDS.items()}
VIIRS_IDS = frozenset({"suomi-npp", "noaa-20", "noaa-21"})
AFTERNOON_IDS = frozenset({"aqua", *VIIRS_IDS})
MISSION_START = {
    "terra": date(2000, 2, 24),
    "aqua": date(2002, 7, 4),
    "suomi-npp": date(2012, 1, 19),
    "noaa-20": date(2018, 1, 5),
    "noaa-21": date(2023, 1, 5),
}
CONFIDENCE_RANK = {"low": 0, "nominal": 30, "high": 80}


@dataclass(frozen=True)
class Detection:
    platform: str
    latitude: float
    longitude: float
    acquired_at: datetime
    frp_mw: float | None
    confidence_class: str | None
    confidence_pct: int | None
    day_night: str | None


@dataclass(frozen=True)
class Coverage:
    day: date
    platform: str
    state: str


@dataclass(frozen=True)
class Filters:
    platforms: frozenset[str]
    day_night: str
    modis_confidence_min: int
    viirs_confidence: frozenset[str]
    frp_min: float | None
    frp_max: float | None


@dataclass(frozen=True)
class CanonicalStore:
    rows: tuple[Detection, ...]
    coverage: tuple[Coverage, ...]
    source: str


@dataclass(frozen=True)
class ActivityDay:
    day: date
    count: float | None
    state: str
    coverage: str


@dataclass(frozen=True)
class ActivityResult:
    days: tuple[ActivityDay, ...]
    completeness: str
    coverage: str
    notes: tuple[str, ...]
    scale: float | None
    overlap_days: int
    scaled_error: float | None
    raw_pixel_error: float | None


def cell_id(longitude: float, latitude: float) -> tuple[int, int]:
    """Equal-area cylindrical cell. Longitude is radians times Earth radius."""
    x = EARTH_RADIUS_M * math.radians(longitude)
    y = EARTH_RADIUS_M * math.sin(math.radians(latitude))
    return math.floor(x / CELL_SIZE_M), math.floor(y / CELL_SIZE_M)


def _ring_closed(ring: list) -> list:
    if len(ring) >= 2 and ring[0] == ring[-1]:
        return ring[:-1]
    return ring


def _unwrap_ring_near(ring: list, longitude: float) -> list:
    points = _ring_closed(ring)
    if not points:
        return []
    previous = points[0][0] + round((longitude - points[0][0]) / 360) * 360
    unwrapped = [[previous, *points[0][1:]]]
    for point in points[1:]:
        current = point[0] + round((previous - point[0]) / 360) * 360
        unwrapped.append([current, *point[1:]])
        previous = current
    return unwrapped


def _on_segment(longitude: float, latitude: float, start: list, end: list) -> bool:
    cross = (longitude - start[0]) * (end[1] - start[1]) - (latitude - start[1]) * (end[0] - start[0])
    if abs(cross) > 1e-9:
        return False
    return (
        min(start[0], end[0]) - 1e-9 <= longitude <= max(start[0], end[0]) + 1e-9
        and min(start[1], end[1]) - 1e-9 <= latitude <= max(start[1], end[1]) + 1e-9
    )


def _crossings(longitude: float, latitude: float, ring: list) -> int:
    points = _ring_closed(ring)
    count = 0
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        if (start[1] > latitude) == (end[1] > latitude):
            continue
        intersect = start[0] + (latitude - start[1]) * (end[0] - start[0]) / (end[1] - start[1])
        if intersect > longitude:
            count += 1
    return count


def _polygon_contains(longitude: float, latitude: float, rings: list) -> bool:
    if len(rings[0]) < 4:
        return False
    shell = _unwrap_ring_near(rings[0], longitude)
    for index, start in enumerate(shell):
        if _on_segment(longitude, latitude, start, shell[(index + 1) % len(shell)]):
            return True
    if _crossings(longitude, latitude, shell) % 2 == 0:
        return False
    for hole in rings[1:]:
        if len(hole) < 4:
            continue
        opened = _unwrap_ring_near(hole, longitude)
        for index, start in enumerate(opened):
            if _on_segment(longitude, latitude, start, opened[(index + 1) % len(opened)]):
                return False
        if _crossings(longitude, latitude, opened) % 2 == 1:
            return False
    return True


def geometry_contains(longitude: float, latitude: float, geometry: dict) -> bool:
    if geometry.get("type") == "Polygon":
        return _polygon_contains(longitude, latitude, geometry["coordinates"])
    if geometry.get("type") == "MultiPolygon":
        return any(_polygon_contains(longitude, latitude, rings) for rings in geometry["coordinates"])
    raise ValueError("Analysis geometry must be a Polygon or MultiPolygon.")


def geometry_bbox(geometry: dict) -> tuple[float, float, float, float] | None:
    longitudes: list[float] = []
    latitudes: list[float] = []

    def walk(node) -> None:
        if isinstance(node, (list, tuple)) and node and isinstance(node[0], (int, float)):
            longitudes.append(float(node[0]))
            latitudes.append(float(node[1]))
            return
        if isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk(geometry.get("coordinates"))
    if not longitudes:
        return None
    return min(longitudes), min(latitudes), max(longitudes), max(latitudes)


def _boxes_overlap(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> bool:
    return not (left[2] < right[0] or right[2] < left[0] or left[3] < right[1] or right[3] < left[1])


def _parse_acquired(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("acquired_at must include a UTC offset.")
    return parsed.astimezone(UTC)


def _optional_float(value: str | None) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    parsed = float(text)
    if not math.isfinite(parsed):
        raise ValueError("Non-finite numeric value.")
    return parsed


def _optional_int(value: str | None) -> int | None:
    text = (value or "").strip()
    if not text:
        return None
    parsed = int(text)
    if not 0 <= parsed <= 100:
        raise ValueError("confidence_pct must be from 0 to 100.")
    return parsed


def detection_from_row(row: dict[str, str | None]) -> Detection:
    platform = PLATFORM_IDS.get((row.get("platform_code") or "").strip().upper())
    if platform is None:
        raise ValueError("platform_code must be T, A, N, N20, or N21.")
    latitude = float(row["latitude"])
    longitude = float(row["longitude"])
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Detection coordinates are outside the valid range.")
    confidence = (row.get("confidence_class") or "").strip().lower() or None
    if confidence is not None and confidence not in CONFIDENCE_RANK:
        raise ValueError("confidence_class must be low, nominal, or high.")
    day_night = (row.get("day_night") or "").strip().upper() or None
    if day_night is not None and day_night not in {"D", "N"}:
        raise ValueError("day_night must be D or N.")
    return Detection(
        platform,
        latitude,
        longitude,
        _parse_acquired(row["acquired_at"]),
        _optional_float(row.get("frp_mw")),
        confidence,
        _optional_int(row.get("confidence_pct")),
        day_night,
    )


def _read_dicts(path: Path) -> list[dict[str, str | None]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path.name} has no header row.")
        return list(reader)


def coverage_from_rows(rows: tuple[Detection, ...] | list[Detection]) -> tuple[Coverage, ...]:
    seen: set[tuple[date, str]] = set()
    coverage: list[Coverage] = []
    for row in rows:
        key = (row.acquired_at.date(), row.platform)
        if key in seen:
            continue
        seen.add(key)
        coverage.append(Coverage(key[0], key[1], "complete"))
    return tuple(coverage)


def load_coverage_csv(path: Path) -> tuple[Coverage, ...]:
    records: list[Coverage] = []
    seen: dict[tuple[date, str], str] = {}
    for row in _read_dicts(path):
        platform = PLATFORM_IDS.get((row.get("platform_code") or "").strip().upper())
        state = (row.get("state") or "").strip().lower()
        if platform is None or state not in {"complete", "partial", "unknown"}:
            raise ValueError("Coverage rows need platform_code and state complete, partial, or unknown.")
        day = date.fromisoformat((row.get("date") or "").strip())
        key = (day, platform)
        if key in seen and seen[key] != state:
            raise ValueError(f"Conflicting coverage for {platform} on {day.isoformat()}.")
        seen[key] = state
        records.append(Coverage(day, platform, state))
    return tuple(records)


def load_detection_csv(path: Path) -> tuple[Detection, ...]:
    rows = []
    for line_number, row in enumerate(_read_dicts(path), start=2):
        try:
            rows.append(detection_from_row(row))
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"{path.name} row {line_number} is not a canonical detection: {exc}") from exc
    return tuple(rows)


def load_csv_store(detection_path: Path, coverage_path: Path | None = None) -> CanonicalStore:
    rows = load_detection_csv(detection_path)
    if coverage_path is None:
        coverage = coverage_from_rows(rows)
        source = f"Canonical CSV {detection_path.name}. Days with no row are unavailable."
    else:
        coverage = load_coverage_csv(coverage_path)
        source = f"Canonical CSV {detection_path.name} with coverage {coverage_path.name}."
    return CanonicalStore(rows, coverage, source)


def load_database_store(database_url: str, bbox: tuple[float, float, float, float] | None) -> CanonicalStore:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("DATABASE_URL is set, but psycopg is not installed.") from exc
    bounds = bbox or (-180.0, -90.0, 180.0, 90.0)
    query = """
        select platform_code, latitude, longitude, acquired_at, frp_mw,
               confidence_class, confidence_pct, day_night
        from fire_detection
        where longitude between %s and %s and latitude between %s and %s
    """
    try:
        with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
            cursor.execute(query, (bounds[0], bounds[2], bounds[1], bounds[3]))
            fetched = cursor.fetchall()
    except Exception as exc:
        raise RuntimeError("The canonical database could not be read.") from exc
    rows: list[Detection] = []
    for platform_code, latitude, longitude, acquired_at, frp_mw, confidence_class, confidence_pct, day_night in fetched:
        acquired = acquired_at if isinstance(acquired_at, datetime) else _parse_acquired(str(acquired_at))
        if acquired.tzinfo is None:
            acquired = acquired.replace(tzinfo=UTC)
        platform = PLATFORM_IDS.get(str(platform_code).strip().upper())
        if platform is None:
            continue
        rows.append(Detection(
            platform,
            float(latitude),
            float(longitude),
            acquired.astimezone(UTC),
            None if frp_mw is None else float(frp_mw),
            None if confidence_class is None else str(confidence_class).lower(),
            None if confidence_pct is None else int(confidence_pct),
            None if day_night is None else str(day_night).upper(),
        ))
    return CanonicalStore(
        tuple(rows),
        coverage_from_rows(rows),
        "fire_detection. A platform-day is covered when the table has any row for it inside the area bounds.",
    )


def store_from_environment(bbox: tuple[float, float, float, float] | None = None) -> CanonicalStore:
    csv_path = os.environ.get("FIRE_DATA_CSV", "").strip()
    if csv_path:
        path = Path(csv_path)
        if not path.is_file():
            raise ValueError("FIRE_DATA_CSV does not point at a readable file.")
        coverage_path = os.environ.get("FIRE_COVERAGE_CSV", "").strip()
        coverage = Path(coverage_path) if coverage_path else None
        if coverage is not None and not coverage.is_file():
            raise ValueError("FIRE_COVERAGE_CSV does not point at a readable file.")
        return load_csv_store(path, coverage)
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if database_url:
        return load_database_store(database_url, bbox)
    return CanonicalStore((), (), "No local canonical detections are loaded.")


def _modis_keeps(row: Detection, minimum: int) -> bool:
    if row.confidence_pct is not None:
        return row.confidence_pct >= minimum
    if row.confidence_class is None:
        return minimum == 0
    ceiling = {"low": 29, "nominal": 79, "high": 100}[row.confidence_class]
    return ceiling >= minimum


def _row_kept(row: Detection, filters: Filters) -> bool:
    if row.platform not in filters.platforms or row.platform not in AFTERNOON_IDS:
        return False
    if filters.day_night != "all" and row.day_night != {"day": "D", "night": "N"}[filters.day_night]:
        return False
    if filters.frp_min is not None or filters.frp_max is not None:
        if row.frp_mw is None:
            return False
        if filters.frp_min is not None and row.frp_mw < filters.frp_min:
            return False
        if filters.frp_max is not None and row.frp_mw > filters.frp_max:
            return False
    if row.platform == "aqua":
        return _modis_keeps(row, filters.modis_confidence_min)
    return row.confidence_class in filters.viirs_confidence


def _coverage_index(coverage: tuple[Coverage, ...]) -> dict[tuple[date, str], str]:
    index: dict[tuple[date, str], str] = {}
    for record in coverage:
        key = (record.day, record.platform)
        previous = index.get(key)
        if previous is not None and previous != record.state:
            raise ValueError(f"Conflicting coverage for {record.platform} on {record.day.isoformat()}.")
        index[key] = record.state
    return index


def _combined_state(day: date, platforms: frozenset[str], index: dict[tuple[date, str], str]) -> str | None:
    states = [index[(day, platform)] for platform in platforms if (day, platform) in index]
    if not states:
        return None
    if "partial" in states:
        return "partial"
    if "unknown" in states:
        return "unknown"
    return "complete"


def _overall(states: list[str]) -> str:
    unique = set(states)
    if unique <= {"complete"}:
        return "complete"
    if unique <= {"unavailable"}:
        return "unavailable"
    if unique <= {"unknown"}:
        return "unknown"
    return "partial"


def _mean_absolute(values: list[float]) -> float:
    return sum(abs(value) for value in values) / len(values)


def harmonized_daily_activity(
    rows: tuple[Detection, ...] | list[Detection],
    geometry: dict,
    start: date,
    end_exclusive: date,
    coverage: tuple[Coverage, ...] | list[Coverage],
    filters: Filters,
) -> ActivityResult:
    if end_exclusive <= start:
        raise ValueError("The activity interval must end after it starts.")
    area_box = geometry_bbox(geometry)
    if area_box is None:
        raise ValueError("Analysis geometry has no coordinates.")
    store_points = [(row.longitude, row.latitude) for row in rows]
    store_box = None
    if store_points:
        store_box = (
            min(point[0] for point in store_points),
            min(point[1] for point in store_points),
            max(point[0] for point in store_points),
            max(point[1] for point in store_points),
        )
    outside_extract = store_box is not None and not _boxes_overlap(area_box, store_box)
    selected_viirs = filters.platforms & VIIRS_IDS
    index = _coverage_index(tuple(coverage))
    aqua_cells: dict[date, set[tuple[int, int]]] = defaultdict(set)
    viirs_cells: dict[date, set[tuple[int, int]]] = defaultdict(set)
    aqua_pixels: dict[date, int] = defaultdict(int)
    for row in rows:
        if not _row_kept(row, filters) or not geometry_contains(row.longitude, row.latitude, geometry):
            continue
        day = row.acquired_at.astimezone(UTC).date()
        if row.platform == "aqua":
            aqua_cells[day].add(cell_id(row.longitude, row.latitude))
            aqua_pixels[day] += 1
        else:
            viirs_cells[day].add(cell_id(row.longitude, row.latitude))

    epoch_days = [day for (day, platform), _state in index.items() if platform in selected_viirs]
    epoch = min(epoch_days) if epoch_days else None
    ratios: list[float] = []
    scaled_gaps: list[float] = []
    raw_gaps: list[float] = []
    overlap_dates = sorted({day for (day, platform) in index if platform == "aqua" or platform in selected_viirs})
    for day in overlap_dates:
        aqua_state = index.get((day, "aqua")) if "aqua" in filters.platforms else None
        viirs_state = _combined_state(day, selected_viirs, index)
        if aqua_state != "complete" or viirs_state != "complete":
            continue
        aqua_count = len(aqua_cells.get(day, ()))
        viirs_count = len(viirs_cells.get(day, ()))
        if aqua_count == 0 or viirs_count == 0:
            continue
        ratios.append(viirs_count / aqua_count)
    scale = float(median(ratios)) if len(ratios) >= MIN_OVERLAP_DAYS else None
    if scale is not None:
        for day in overlap_dates:
            aqua_state = index.get((day, "aqua")) if "aqua" in filters.platforms else None
            viirs_state = _combined_state(day, selected_viirs, index)
            if aqua_state != "complete" or viirs_state != "complete":
                continue
            aqua_count = len(aqua_cells.get(day, ()))
            viirs_count = len(viirs_cells.get(day, ()))
            if aqua_count == 0 or viirs_count == 0:
                continue
            scaled_gaps.append(viirs_count - aqua_count * scale)
            raw_gaps.append(viirs_count - aqua_pixels.get(day, 0))
    scaled_error = _mean_absolute(scaled_gaps) if scaled_gaps else None
    raw_error = _mean_absolute(raw_gaps) if raw_gaps else None

    scale_note = (
        f"The overlap scale is {scale:.3f} VIIRS cells per Aqua cell, from {len(ratios)} stored days."
        if scale is not None
        else f"The stored overlap has {len(ratios)} days with both Aqua and VIIRS active cells. At least {MIN_OVERLAP_DAYS} are required before Aqua-era days can be scaled."
    )
    days: list[ActivityDay] = []
    cursor = start
    while cursor < end_exclusive:
        viirs_state = _combined_state(cursor, selected_viirs, index)
        aqua_state = index.get((cursor, "aqua")) if "aqua" in filters.platforms else None
        viirs_era = epoch is not None and cursor >= epoch
        if outside_extract:
            if viirs_state is not None or aqua_state is not None:
                count, state, text = 0, "partial", "The selected area is outside the bounding box of the stored detections."
            else:
                count, state, text = None, "unavailable", "No stored coverage for this UTC day, and the area is outside the stored detections."
        elif viirs_era:
            count, state, text = _viirs_day(viirs_state, len(viirs_cells.get(cursor, ())))
        elif scale is None:
            count = None
            state = "unavailable"
            text = scale_note
        else:
            count, state, text = _aqua_day(aqua_state, len(aqua_cells.get(cursor, ())), scale)
        days.append(ActivityDay(cursor, count, state, text))
        cursor += timedelta(days=1)

    notes = [
        "Values are harmonized 2 km afternoon active cells, not raw detections and not distinct fires.",
        "A zero means no active cell was returned. It is not proof that no fire occurred.",
        "Terra is excluded. Its morning orbit has no VIIRS match across the whole record.",
        "VIIRS-era days use the union of Suomi NPP, NOAA-20, and NOAA-21 cells selected in the query. Aqua cells on those days are not added.",
        "A regional extract does not prove what was observed outside the days and places that were stored.",
        "This area does not intersect the stored detections, so covered days are partial rather than a measured zero." if outside_extract else scale_note,
    ]
    if scaled_error is not None and raw_error is not None:
        comparison = "closer to" if scaled_error < raw_error else "not closer to"
        notes.append(
            f"On {len(ratios)} overlap days, scaled Aqua cells are {comparison} VIIRS cells "
            f"than raw Aqua pixel counts (mean absolute difference {scaled_error:.3f} versus {raw_error:.3f})."
        )
    covered = [day.day.isoformat() for day in days if day.state != "unavailable"]
    if covered:
        coverage_text = f"{store_from_label(coverage)} Covered result days run from {covered[0]} to {covered[-1]}."
    else:
        coverage_text = "No stored afternoon coverage produced a harmonized value for this request."
    return ActivityResult(tuple(days), _overall([day.state for day in days]), coverage_text, tuple(notes), scale, len(ratios), scaled_error, raw_error)


def store_from_label(coverage: tuple[Coverage, ...] | list[Coverage]) -> str:
    if not coverage:
        return "No coverage records are stored."
    return "Coverage follows the stored platform-days."


def _reported_count(state: str, count: float) -> tuple[float | None, str, str]:
    if state == "unknown" and count == 0:
        return None, "unknown", "Stored coverage for this UTC day is unknown, so an empty result is not reported as zero."
    text = {
        "complete": "Stored coverage includes this UTC day.",
        "partial": "Stored coverage for this UTC day is partial.",
        "unknown": "Stored coverage for this UTC day is unknown.",
    }[state]
    return count, state, text


def _viirs_day(state: str | None, cells: int) -> tuple[float | None, str, str]:
    if state is None:
        return None, "unavailable", "This day is in the VIIRS era, and no selected VIIRS coverage is stored. Aqua cells are not substituted."
    count, reported, text = _reported_count(state, float(cells))
    if reported == "complete" and cells == 0:
        text = "VIIRS coverage is stored and no afternoon active cell passed the filters."
    elif count is not None:
        text = f"VIIRS afternoon cell union. {text} Aqua detections on this day are not added."
    return count, reported, text


def _aqua_day(state: str | None, cells: int, scale: float | None) -> tuple[float | None, str, str]:
    if scale is None:
        return None, "unavailable", f"Aqua-era days stay unavailable until at least {MIN_OVERLAP_DAYS} overlap days can fit a scale."
    if state is None:
        return None, "unavailable", "No stored Aqua coverage for this UTC day."
    count, reported, text = _reported_count(state, round(cells * scale, 2))
    if reported == "complete" and cells == 0:
        text = "Aqua coverage is stored and no afternoon active cell passed the filters."
    elif count is not None:
        text = f"Aqua active cells multiplied by the overlap scale of {scale:.3f}. {text}"
    return count, reported, text


class RejectedQuery(ValueError):
    """The analysis request does not match the harmonized contract."""


COMPANION_NOTE = (
    "Returned detections are the FIRMS points that passed the area and native filters. "
    "The calendar remains the harmonized afternoon active-cell series and is not a sum of those points."
)


def evaluate_query(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> tuple[ActivityResult, Filters, date, date, str]:
    if not isinstance(query, dict) or not isinstance(query.get("id"), str) or not query["id"]:
        raise RejectedQuery("Analysis query identity is required.")
    if query.get("processingMode") != "harmonized":
        raise RejectedQuery("This analysis serves harmonized afternoon active cells. Raw counts are not accepted here.")
    geometry = query.get("aoi", {}).get("geometry") if isinstance(query.get("aoi"), dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise RejectedQuery("The analysis area is invalid.")
    resolution = query.get("resolution", "daily")
    if resolution not in {"daily", "weekly", "monthly"}:
        raise RejectedQuery("Choose a daily, weekly, or monthly resolution.")
    try:
        start, end = parse_utc_interval(query.get("interval"))
        filters = filters_from_query(query.get("filters") if isinstance(query.get("filters"), dict) else {})
        result = harmonized_daily_activity(store.rows, geometry, start, end, store.coverage, filters)
    except ValueError as exc:
        raise RejectedQuery(str(exc)) from exc
    updated = (updated_at or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    return result, filters, start, end, updated


def _meta(query_id: str, result: ActivityResult, updated: str, units: dict, completeness: str | None = None, coverage: str | None = None, extra_notes: tuple[str, ...] = ()) -> dict:
    return {
        "queryId": query_id,
        "mode": "live",
        "datasetVersion": DATASET_VERSION,
        "methodVersion": METHOD_VERSION,
        "processingTier": "harmonized-afternoon-cells",
        "completeness": completeness if completeness is not None else result.completeness,
        "coverage": coverage if coverage is not None else result.coverage,
        "updatedAt": updated,
        "units": units,
        "notes": [*result.notes, *extra_notes],
    }


def _metric(value, unit: str, definition: str, availability: str) -> dict:
    return {"value": value, "unit": unit, "definition": definition, "availability": availability}


def _options(body: dict | None) -> dict:
    if not isinstance(body, dict):
        return {}
    options = body.get("options")
    return options if isinstance(options, dict) else {}


def _focused_day(options: dict, start: date, end: date) -> date | None:
    if "day" not in options or options["day"] is None:
        return None
    try:
        focused = date.fromisoformat(str(options["day"])[:10])
    except ValueError as exc:
        raise RejectedQuery("The focused UTC day must be inside the applied analysis period.") from exc
    if focused < start or focused >= end:
        raise RejectedQuery("The focused UTC day must be inside the applied analysis period.")
    return focused


def _page(options: dict) -> tuple[int, int]:
    page = options.get("page", 1)
    page_size = options.get("pageSize", 10)
    if isinstance(page, bool) or not isinstance(page, int) or page < 1 or isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
        raise RejectedQuery("Use a positive page number and a page size from 1 to 100.")
    return page, page_size


def _bucket_start(day: date, resolution: str) -> date:
    if resolution == "weekly":
        return day - timedelta(days=day.weekday())
    if resolution == "monthly":
        return day.replace(day=1)
    return day


def _bucket_end(start: date, resolution: str) -> date:
    if resolution == "weekly":
        return start + timedelta(days=6)
    if resolution == "monthly":
        month = start.month + 1
        year = start.year + (month > 12)
        return date(year, 1 if month > 12 else month, 1) - timedelta(days=1)
    return start


def calendar_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, _filters, _start, _end, updated = evaluate_query(query, store, updated_at)
    return {
        "data": [
            {"date": day.day.isoformat(), "count": day.count, "state": day.state, "coverage": day.coverage}
            for day in result.days
        ],
        "meta": _meta(query["id"], result, updated, {"count": "harmonized active cells", "time": "UTC"}),
    }


def kept_detections(query: dict, store: CanonicalStore, filters: Filters, start: date, end: date, focused: date | None = None) -> list[Detection]:
    geometry = query.get("aoi", {}).get("geometry") if isinstance(query.get("aoi"), dict) else None
    if not isinstance(geometry, dict):
        return []
    rows = []
    for row in store.rows:
        day = row.acquired_at.astimezone(UTC).date()
        if day < start or day >= end or (focused is not None and day != focused):
            continue
        if not _row_kept(row, filters) or not geometry_contains(row.longitude, row.latitude, geometry):
            continue
        rows.append(row)
    rows.sort(key=lambda row: row.acquired_at, reverse=True)
    return rows


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def detection_id(row: Detection) -> str:
    return f"{row.platform}:{row.acquired_at.astimezone(UTC).strftime('%Y-%m-%dT%H:%MZ')}:{row.longitude:.5f}:{row.latitude:.5f}"


def observation_record(row: Detection, store: CanonicalStore) -> dict:
    modis = row.platform in {"terra", "aqua"}
    return {
        "id": detection_id(row),
        "acquiredAt": row.acquired_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "sensor": "MODIS" if modis else "VIIRS",
        "platform": row.platform,
        "longitude": row.longitude,
        "latitude": row.latitude,
        "dayNight": "day" if row.day_night == "D" else "night",
        "confidence": (
            {"kind": "numeric", "value": row.confidence_pct if row.confidence_pct is not None else 0, "unit": "native MODIS confidence (0–100)"}
            if modis
            else {"kind": "categorical", "value": row.confidence_class or "nominal"}
        ),
        "frpMw": row.frp_mw,
        "provenance": store.source,
        "productVersion": DATASET_VERSION,
        "processingTier": "firms-active-fire",
    }


def overview_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    rows = kept_detections(query, store, filters, start, end)
    availability = result.completeness
    blank = availability == "unavailable"
    by_day: dict[date, int] = defaultdict(int)
    for row in rows:
        by_day[row.acquired_at.astimezone(UTC).date()] += 1
    peak = min(by_day, key=lambda day: (-by_day[day], day.toordinal())) if by_day else None
    return {
        "data": {
            "detectionCount": _metric(None if blank else len(rows), "returned detections", "FIRMS active-fire records inside the area after the native filters. Not a count of distinct fires or harmonized cells.", availability),
            "daysWithDetections": _metric(None if blank else len(by_day), "UTC days", "UTC days in the applied interval with at least one returned detection.", availability),
            "peakDate": _metric(None if peak is None else peak.isoformat(), "UTC date", "Earliest UTC day tied for the most returned detections. Unavailable days are excluded.", availability),
            "medianFrp": _metric(None if blank else _median([row.frp_mw for row in rows if row.frp_mw is not None]), "MW", "Median fire radiative power of the returned detections that include FRP.", availability),
        },
        "meta": _meta(query["id"], result, updated, {"detectionCount": "returned detections", "frp": "MW", "time": "UTC"}, availability, result.coverage, (COMPANION_NOTE,)),
    }


def time_series_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    resolution = query.get("resolution", "daily")
    rows = kept_detections(query, store, filters, start, end)
    counts: dict[tuple[date, str], int] = defaultdict(int)
    for row in rows:
        day = row.acquired_at.astimezone(UTC).date()
        counts[(_bucket_start(day, resolution), row.platform)] += 1
    coverage = _coverage_index(store.coverage)
    groups: list[list[ActivityDay]] = []
    current: date | None = None
    for day in result.days:
        bucket = _bucket_start(day.day, resolution)
        if bucket != current:
            groups.append([day])
            current = bucket
        else:
            groups[-1].append(day)
    series = []
    for group in groups:
        first = group[0].day
        last = group[-1].day
        period_end = _bucket_end(_bucket_start(first, resolution), resolution)
        end_date = last if last < period_end else period_end
        for platform in sorted(filters.platforms):
            states = [coverage.get((day.day, platform), "unavailable") for day in group]
            state = _overall(states)
            series.append({
                "date": first.isoformat(),
                "endDate": end_date.isoformat(),
                "count": 0 if state == "unavailable" else counts.get((_bucket_start(first, resolution), platform), 0),
                "platform": platform,
                "state": state,
            })
    reported = [bucket["state"] for bucket in series]
    return {
        "data": series,
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, _overall(reported) if reported else "unavailable", result.coverage, (COMPANION_NOTE,)),
    }


def observations_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    options = _options(body)
    focused = _focused_day(options, start, end)
    page, page_size = _page(options)
    rows = [row for row in kept_detections(query, store, filters, start, end, focused) if row.day_night in {"D", "N"}]
    offset = (page - 1) * page_size
    coverage = result.coverage if focused is None else f"{focused.isoformat()} UTC. {result.coverage}"
    return {
        "data": {
            "rows": [observation_record(row, store) for row in rows[offset:offset + page_size]],
            "total": len(rows),
            "page": page,
            "pageSize": page_size,
        },
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "frp": "MW", "time": "UTC"}, result.completeness, coverage, (COMPANION_NOTE,)),
    }


def observation_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    wanted = body.get("id") if isinstance(body, dict) else None
    match = next((row for row in kept_detections(query, store, filters, start, end) if detection_id(row) == wanted and row.day_night in {"D", "N"}), None)
    return {
        "data": None if match is None else observation_record(match, store),
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, result.completeness, result.coverage, (COMPANION_NOTE,)),
    }


def map_source_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    focused = _focused_day(_options(body), start, end)
    rows = [row for row in kept_detections(query, store, filters, start, end, focused) if row.day_night in {"D", "N"}]
    features = []
    for row in rows:
        record = observation_record(row, store)
        features.append({
            "type": "Feature",
            "id": record["id"],
            "geometry": {"type": "Point", "coordinates": [row.longitude, row.latitude]},
            "properties": {**record, "observationId": record["id"], "queryId": query["id"]},
        })
    coverage = result.coverage if focused is None else f"{focused.isoformat()} UTC. {result.coverage}"
    return {
        "data": {
            "type": "geojson",
            "data": {"type": "FeatureCollection", "features": features},
            "attribution": "NASA FIRMS active-fire detections inside the applied area.",
        },
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, result.completeness, coverage, (COMPANION_NOTE,)),
    }


def capabilities_payload(store: CanonicalStore, today: date | None = None) -> dict:
    today = today or datetime.now(UTC).date()
    by_platform: dict[str, list[date]] = defaultdict(list)
    for record in store.coverage:
        by_platform[record.platform].append(record.day)
    for row in store.rows:
        by_platform[row.platform].append(row.acquired_at.date())
    platforms = []
    loaded_dates: list[date] = []
    for platform_id, label, sensor in (
        ("terra", "MODIS / Terra", "MODIS"),
        ("aqua", "MODIS / Aqua", "MODIS"),
        ("suomi-npp", "VIIRS / Suomi NPP", "VIIRS"),
        ("noaa-20", "VIIRS / NOAA-20", "VIIRS"),
        ("noaa-21", "VIIRS / NOAA-21", "VIIRS"),
    ):
        dates = by_platform.get(platform_id, [])
        start = min(dates) if dates else MISSION_START[platform_id]
        end = max(dates) if dates else start
        if dates:
            loaded_dates.extend(dates)
        confidence = (
            {"kind": "numeric", "min": 0, "max": 100, "unit": "native MODIS confidence (0–100)"}
            if sensor == "MODIS"
            else {"kind": "categorical", "values": ["low", "nominal", "high"]}
        )
        platforms.append({
            "id": platform_id,
            "label": label,
            "sensor": sensor,
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "confidence": confidence,
        })
    if loaded_dates:
        start_date, end_date = min(loaded_dates), max(loaded_dates)
        description = (
            f"{store.source} Loaded platform-days run from {start_date.isoformat()} to {end_date.isoformat()}. "
            "The harmonized calendar counts 2 km afternoon active cells. Terra is listed for provenance and is not part of the index."
        )
        box = geometry_bbox({"type": "MultiPoint", "coordinates": [[row.longitude, row.latitude] for row in store.rows]}) if store.rows else None
        if box is not None and box[0] == box[2]:
            box = (box[0] - 0.01, box[1], box[2] + 0.01, box[3])
        if box is not None and box[1] == box[3]:
            box = (box[0], box[1] - 0.01, box[2], box[3] + 0.01)
    else:
        start_date, end_date = MISSION_START["aqua"], today
        description = (
            f"{store.source} Every calendar day is unavailable until FIRE_DATA_CSV or DATABASE_URL provides canonical MODIS and VIIRS rows."
        )
        box = None
    if box is None:
        spatial = {"type": "Polygon", "coordinates": [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]]}
    else:
        spatial = {"type": "Polygon", "coordinates": [[
            [box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]],
        ]]}
    return {
        "platforms": platforms,
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "resolutions": ["daily", "weekly", "monthly"],
        "processingModes": ["harmonized"],
        "metrics": ["harmonizedActiveCells"],
        "filterSupport": {"dayNight": True, "frp": True},
        "seasonal": False,
        "anomalies": False,
        "summaries": False,
        "earlyWarning": False,
        "exportFormats": [],
        "spatialCoverage": spatial,
        "coverageDescription": description,
    }


def filters_from_query(payload: dict) -> Filters:
    platforms = payload.get("platforms")
    if not isinstance(platforms, list) or not platforms or not all(isinstance(item, str) for item in platforms):
        raise ValueError("Select at least one platform.")
    unknown = sorted(set(platforms) - set(PLATFORM_CODES))
    if unknown:
        raise ValueError("A selected platform is not part of the canonical archive.")
    day_night = payload.get("dayNight", "all")
    if day_night not in {"all", "day", "night"}:
        raise ValueError("Choose a valid day/night filter.")
    minimum = payload.get("modisConfidenceMin", 0)
    if not isinstance(minimum, int) or isinstance(minimum, bool) or not 0 <= minimum <= 100:
        raise ValueError("MODIS confidence must be a native value from 0 to 100.")
    viirs = payload.get("viirsConfidence", ["low", "nominal", "high"])
    if not isinstance(viirs, list) or any(item not in CONFIDENCE_RANK for item in viirs):
        raise ValueError("Choose native VIIRS confidence categories.")
    if any(platform in VIIRS_IDS for platform in platforms) and not viirs:
        raise ValueError("Select at least one native VIIRS confidence category.")
    frp_min = payload.get("frpMin")
    frp_max = payload.get("frpMax")
    for name, value in (("frpMin", frp_min), ("frpMax", frp_max)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0):
            raise ValueError(f"{name} must be a non-negative number of MW.")
    if frp_min is not None and frp_max is not None and frp_min > frp_max:
        raise ValueError("Minimum FRP cannot exceed maximum FRP.")
    return Filters(frozenset(platforms), day_night, minimum, frozenset(viirs), None if frp_min is None else float(frp_min), None if frp_max is None else float(frp_max))


def parse_utc_interval(interval: dict) -> tuple[date, date]:
    if not isinstance(interval, dict):
        raise ValueError("Analysis requires a UTC interval.")
    try:
        start = datetime.fromisoformat(str(interval.get("start", "")).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(interval.get("endExclusive", "")).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.") from exc
    if start.tzinfo is None or end.tzinfo is None or start.utcoffset() != timedelta(0) or end.utcoffset() != timedelta(0):
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.")
    if start.timetz().replace(tzinfo=None) != time.min or end.timetz().replace(tzinfo=None) != time.min or end <= start:
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.")
    if (end.date() - start.date()).days > 366 * 100:
        raise ValueError("Choose a period shorter than 100 years.")
    return start.date(), end.date()
"""Harmonized daily burning activity for MODIS Aqua and VIIRS.

Each value is a count of 2 km equal-area cells on the afternoon orbit.
Aqua, Suomi NPP, NOAA-20, and NOAA-21 are kept. Terra is omitted because its
morning orbit has no VIIRS counterpart across the record. Several detections
in one cell count once, and several afternoon satellites on that cell still
count once.

On a day with stored VIIRS coverage the value is the VIIRS cell union. Aqua
is not added on top. On an earlier Aqua day the value is the Aqua cell count
times one scale: the median of daily VIIRS cells / Aqua cells on stored
overlap days for the same area and filters. The scale uses the whole stored
overlap, not only the dates in the request. Raw pixel counts are never added
across sensors.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import threading
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from statistics import median

METHOD_VERSION = "afternoon-active-cells-2km-1"
DATASET_VERSION = "local-canonical-1"
MIN_OVERLAP_DAYS = 14
CELL_SIZE_M = 2000.0
EARTH_RADIUS_M = 6371007.2

PLATFORM_IDS = {"T": "terra", "A": "aqua", "N": "suomi-npp", "N20": "noaa-20", "N21": "noaa-21"}
PLATFORM_CODES = {value: key for key, value in PLATFORM_IDS.items()}
VIIRS_IDS = frozenset({"suomi-npp", "noaa-20", "noaa-21"})
AFTERNOON_IDS = frozenset({"aqua", *VIIRS_IDS})
MISSION_START = {
    "terra": date(2000, 2, 24),
    "aqua": date(2002, 7, 4),
    "suomi-npp": date(2012, 1, 19),
    "noaa-20": date(2018, 1, 5),
    "noaa-21": date(2023, 1, 5),
}
CONFIDENCE_RANK = {"low": 0, "nominal": 30, "high": 80}
EDGE_TOLERANCE = 1e-9
MAX_RING_BANDS = 4096
MAX_REMEMBERED_POINTS = 200_000
MAX_PREPARED_AREAS = 4


@dataclass(frozen=True)
class Detection:
    platform: str
    latitude: float
    longitude: float
    acquired_at: datetime
    frp_mw: float | None
    confidence_class: str | None
    confidence_pct: int | None
    day_night: str | None


@dataclass(frozen=True)
class Coverage:
    day: date
    platform: str
    state: str


@dataclass(frozen=True)
class Filters:
    platforms: frozenset[str]
    day_night: str
    modis_confidence_min: int
    viirs_confidence: frozenset[str]
    frp_min: float | None
    frp_max: float | None


@dataclass(frozen=True)
class CanonicalStore:
    rows: tuple[Detection, ...]
    coverage: tuple[Coverage, ...]
    source: str


@dataclass(frozen=True)
class ActivityDay:
    day: date
    count: float | None
    state: str
    coverage: str


@dataclass(frozen=True)
class ActivityResult:
    days: tuple[ActivityDay, ...]
    completeness: str
    coverage: str
    notes: tuple[str, ...]
    scale: float | None
    overlap_days: int
    scaled_error: float | None
    raw_pixel_error: float | None


def cell_id(longitude: float, latitude: float) -> tuple[int, int]:
    """Equal-area cylindrical cell. Longitude is radians times Earth radius."""
    x = EARTH_RADIUS_M * math.radians(longitude)
    y = EARTH_RADIUS_M * math.sin(math.radians(latitude))
    return math.floor(x / CELL_SIZE_M), math.floor(y / CELL_SIZE_M)


def _ring_closed(ring: list) -> list:
    if len(ring) >= 2 and ring[0] == ring[-1]:
        return ring[:-1]
    return ring


class _RingIndex:
    """Ring edges grouped into latitude bands.

    A country boundary has tens of thousands of edges. A point is tested only
    against the edges whose latitude range reaches its own latitude.
    """

    __slots__ = ("south", "north", "height", "bands")

    def __init__(self, ring: list) -> None:
        points = [(float(point[0]), float(point[1])) for point in _ring_closed(ring)]
        edges = [(*start, *points[(index + 1) % len(points)]) for index, start in enumerate(points)]
        self.south = min(point[1] for point in points)
        self.north = max(point[1] for point in points)
        count = max(1, min(MAX_RING_BANDS, len(edges) // 4))
        self.height = (self.north - self.south) / count or 1.0
        self.bands: list[list[tuple[float, float, float, float]]] = [[] for _ in range(count)]
        for edge in edges:
            first = self._band(min(edge[1], edge[3]) - EDGE_TOLERANCE)
            last = self._band(max(edge[1], edge[3]) + EDGE_TOLERANCE)
            for band in range(first, last + 1):
                self.bands[band].append(edge)

    def _band(self, latitude: float) -> int:
        return max(0, min(len(self.bands) - 1, int((latitude - self.south) / self.height)))

    def locate(self, longitude: float, latitude: float) -> int:
        """Return 1 inside the ring, 0 on it, and -1 outside."""
        if latitude < self.south - EDGE_TOLERANCE or latitude > self.north + EDGE_TOLERANCE:
            return -1
        inside = False
        for start_x, start_y, end_x, end_y in self.bands[self._band(latitude)]:
            cross = (longitude - start_x) * (end_y - start_y) - (latitude - start_y) * (end_x - start_x)
            if (
                abs(cross) <= EDGE_TOLERANCE
                and min(start_x, end_x) - EDGE_TOLERANCE <= longitude <= max(start_x, end_x) + EDGE_TOLERANCE
                and min(start_y, end_y) - EDGE_TOLERANCE <= latitude <= max(start_y, end_y) + EDGE_TOLERANCE
            ):
                return 0
            if (start_y > latitude) != (end_y > latitude):
                if start_x + (latitude - start_y) * (end_x - start_x) / (end_y - start_y) > longitude:
                    inside = not inside
        return 1 if inside else -1


class PreparedArea:
    """Point-in-area test for one analysis geometry.

    A point on the outer boundary is inside. A point in a hole, or on a hole's
    edge, is outside. Answers are remembered because every analysis endpoint
    asks about the same detections.
    """

    __slots__ = ("polygons", "known")

    def __init__(self, geometry: dict) -> None:
        if geometry.get("type") == "Polygon":
            groups = [geometry["coordinates"]]
        elif geometry.get("type") == "MultiPolygon":
            groups = geometry["coordinates"]
        else:
            raise ValueError("Analysis geometry must be a Polygon or MultiPolygon.")
        self.polygons = [
            (_RingIndex(rings[0]), [_RingIndex(hole) for hole in rings[1:] if len(hole) >= 4])
            for rings in groups
            if rings and len(rings[0]) >= 4
        ]
        self.known: dict[tuple[float, float], bool] = {}

    def contains(self, longitude: float, latitude: float) -> bool:
        point = (longitude, latitude)
        known = self.known.get(point)
        if known is None:
            known = any(_polygon_contains(longitude, latitude, shell, holes) for shell, holes in self.polygons)
            if len(self.known) < MAX_REMEMBERED_POINTS:
                self.known[point] = known
        return known


def _polygon_contains(longitude: float, latitude: float, shell: _RingIndex, holes: list[_RingIndex]) -> bool:
    place = shell.locate(longitude, latitude)
    if place <= 0:
        return place == 0
    return all(hole.locate(longitude, latitude) < 0 for hole in holes)


_PREPARED_AREAS: OrderedDict[str, PreparedArea] = OrderedDict()
_PREPARED_LOCK = threading.Lock()


def prepared_area(geometry: dict) -> PreparedArea:
    """Reuse one index per geometry across requests and threads."""
    shape = json.dumps([geometry.get("type"), geometry.get("coordinates")], separators=(",", ":"))
    key = hashlib.sha256(shape.encode()).hexdigest()
    with _PREPARED_LOCK:
        area = _PREPARED_AREAS.get(key)
        if area is None:
            area = _PREPARED_AREAS[key] = PreparedArea(geometry)
            while len(_PREPARED_AREAS) > MAX_PREPARED_AREAS:
                _PREPARED_AREAS.popitem(last=False)
        else:
            _PREPARED_AREAS.move_to_end(key)
        return area


def geometry_bbox(geometry: dict) -> tuple[float, float, float, float] | None:
    longitudes: list[float] = []
    latitudes: list[float] = []

    def walk(node) -> None:
        if isinstance(node, (list, tuple)) and node and isinstance(node[0], (int, float)):
            longitudes.append(float(node[0]))
            latitudes.append(float(node[1]))
            return
        if isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk(geometry.get("coordinates"))
    if not longitudes:
        return None
    return min(longitudes), min(latitudes), max(longitudes), max(latitudes)


def _boxes_overlap(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> bool:
    return not (left[2] < right[0] or right[2] < left[0] or left[3] < right[1] or right[3] < left[1])


def _parse_acquired(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("acquired_at must include a UTC offset.")
    return parsed.astimezone(UTC)


def _optional_float(value: str | None) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    parsed = float(text)
    if not math.isfinite(parsed):
        raise ValueError("Non-finite numeric value.")
    return parsed


def _optional_int(value: str | None) -> int | None:
    text = (value or "").strip()
    if not text:
        return None
    parsed = int(text)
    if not 0 <= parsed <= 100:
        raise ValueError("confidence_pct must be from 0 to 100.")
    return parsed


def detection_from_row(row: dict[str, str | None]) -> Detection:
    platform = PLATFORM_IDS.get((row.get("platform_code") or "").strip().upper())
    if platform is None:
        raise ValueError("platform_code must be T, A, N, N20, or N21.")
    latitude = float(row["latitude"])
    longitude = float(row["longitude"])
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Detection coordinates are outside the valid range.")
    confidence = (row.get("confidence_class") or "").strip().lower() or None
    if confidence is not None and confidence not in CONFIDENCE_RANK:
        raise ValueError("confidence_class must be low, nominal, or high.")
    day_night = (row.get("day_night") or "").strip().upper() or None
    if day_night is not None and day_night not in {"D", "N"}:
        raise ValueError("day_night must be D or N.")
    return Detection(
        platform,
        latitude,
        longitude,
        _parse_acquired(row["acquired_at"]),
        _optional_float(row.get("frp_mw")),
        confidence,
        _optional_int(row.get("confidence_pct")),
        day_night,
    )


def _read_dicts(path: Path) -> list[dict[str, str | None]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path.name} has no header row.")
        return list(reader)


def coverage_from_rows(rows: tuple[Detection, ...] | list[Detection]) -> tuple[Coverage, ...]:
    seen: set[tuple[date, str]] = set()
    coverage: list[Coverage] = []
    for row in rows:
        key = (row.acquired_at.date(), row.platform)
        if key in seen:
            continue
        seen.add(key)
        coverage.append(Coverage(key[0], key[1], "complete"))
    return tuple(coverage)


def load_coverage_csv(path: Path) -> tuple[Coverage, ...]:
    records: list[Coverage] = []
    seen: dict[tuple[date, str], str] = {}
    for row in _read_dicts(path):
        platform = PLATFORM_IDS.get((row.get("platform_code") or "").strip().upper())
        state = (row.get("state") or "").strip().lower()
        if platform is None or state not in {"complete", "partial", "unknown"}:
            raise ValueError("Coverage rows need platform_code and state complete, partial, or unknown.")
        day = date.fromisoformat((row.get("date") or "").strip())
        key = (day, platform)
        if key in seen and seen[key] != state:
            raise ValueError(f"Conflicting coverage for {platform} on {day.isoformat()}.")
        seen[key] = state
        records.append(Coverage(day, platform, state))
    return tuple(records)


def load_detection_csv(path: Path) -> tuple[Detection, ...]:
    rows = []
    for line_number, row in enumerate(_read_dicts(path), start=2):
        try:
            rows.append(detection_from_row(row))
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"{path.name} row {line_number} is not a canonical detection: {exc}") from exc
    return tuple(rows)


def load_csv_store(detection_path: Path, coverage_path: Path | None = None) -> CanonicalStore:
    rows = load_detection_csv(detection_path)
    if coverage_path is None:
        coverage = coverage_from_rows(rows)
        source = f"Canonical CSV {detection_path.name}. Days with no row are unavailable."
    else:
        coverage = load_coverage_csv(coverage_path)
        source = f"Canonical CSV {detection_path.name} with coverage {coverage_path.name}."
    return CanonicalStore(rows, coverage, source)


def load_database_store(database_url: str, bbox: tuple[float, float, float, float] | None) -> CanonicalStore:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("DATABASE_URL is set, but psycopg is not installed.") from exc
    bounds = bbox or (-180.0, -90.0, 180.0, 90.0)
    query = """
        select platform_code, latitude, longitude, acquired_at, frp_mw,
               confidence_class, confidence_pct, day_night
        from fire_detection
        where longitude between %s and %s and latitude between %s and %s
    """
    try:
        with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
            cursor.execute(query, (bounds[0], bounds[2], bounds[1], bounds[3]))
            fetched = cursor.fetchall()
    except Exception as exc:
        raise RuntimeError("The canonical database could not be read.") from exc
    rows: list[Detection] = []
    for platform_code, latitude, longitude, acquired_at, frp_mw, confidence_class, confidence_pct, day_night in fetched:
        acquired = acquired_at if isinstance(acquired_at, datetime) else _parse_acquired(str(acquired_at))
        if acquired.tzinfo is None:
            acquired = acquired.replace(tzinfo=UTC)
        platform = PLATFORM_IDS.get(str(platform_code).strip().upper())
        if platform is None:
            continue
        rows.append(Detection(
            platform,
            float(latitude),
            float(longitude),
            acquired.astimezone(UTC),
            None if frp_mw is None else float(frp_mw),
            None if confidence_class is None else str(confidence_class).lower(),
            None if confidence_pct is None else int(confidence_pct),
            None if day_night is None else str(day_night).upper(),
        ))
    return CanonicalStore(
        tuple(rows),
        coverage_from_rows(rows),
        "fire_detection. A platform-day is covered when the table has any row for it inside the area bounds.",
    )


def store_from_environment(bbox: tuple[float, float, float, float] | None = None) -> CanonicalStore:
    csv_path = os.environ.get("FIRE_DATA_CSV", "").strip()
    if csv_path:
        path = Path(csv_path)
        if not path.is_file():
            raise ValueError("FIRE_DATA_CSV does not point at a readable file.")
        coverage_path = os.environ.get("FIRE_COVERAGE_CSV", "").strip()
        coverage = Path(coverage_path) if coverage_path else None
        if coverage is not None and not coverage.is_file():
            raise ValueError("FIRE_COVERAGE_CSV does not point at a readable file.")
        return load_csv_store(path, coverage)
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if database_url:
        return load_database_store(database_url, bbox)
    return CanonicalStore((), (), "No local canonical detections are loaded.")


def _modis_keeps(row: Detection, minimum: int) -> bool:
    if row.confidence_pct is not None:
        return row.confidence_pct >= minimum
    if row.confidence_class is None:
        return minimum == 0
    ceiling = {"low": 29, "nominal": 79, "high": 100}[row.confidence_class]
    return ceiling >= minimum


def _row_kept(row: Detection, filters: Filters) -> bool:
    if row.platform not in filters.platforms or row.platform not in AFTERNOON_IDS:
        return False
    if filters.day_night != "all" and row.day_night != {"day": "D", "night": "N"}[filters.day_night]:
        return False
    if filters.frp_min is not None or filters.frp_max is not None:
        if row.frp_mw is None:
            return False
        if filters.frp_min is not None and row.frp_mw < filters.frp_min:
            return False
        if filters.frp_max is not None and row.frp_mw > filters.frp_max:
            return False
    if row.platform == "aqua":
        return _modis_keeps(row, filters.modis_confidence_min)
    return row.confidence_class in filters.viirs_confidence


def _coverage_index(coverage: tuple[Coverage, ...]) -> dict[tuple[date, str], str]:
    index: dict[tuple[date, str], str] = {}
    for record in coverage:
        key = (record.day, record.platform)
        previous = index.get(key)
        if previous is not None and previous != record.state:
            raise ValueError(f"Conflicting coverage for {record.platform} on {record.day.isoformat()}.")
        index[key] = record.state
    return index


def _combined_state(day: date, platforms: frozenset[str], index: dict[tuple[date, str], str]) -> str | None:
    states = [index[(day, platform)] for platform in platforms if (day, platform) in index]
    if not states:
        return None
    if "partial" in states:
        return "partial"
    if "unknown" in states:
        return "unknown"
    return "complete"


def _overall(states: list[str]) -> str:
    unique = set(states)
    if unique <= {"complete"}:
        return "complete"
    if unique <= {"unavailable"}:
        return "unavailable"
    if unique <= {"unknown"}:
        return "unknown"
    return "partial"


def _mean_absolute(values: list[float]) -> float:
    return sum(abs(value) for value in values) / len(values)


def harmonized_daily_activity(
    rows: tuple[Detection, ...] | list[Detection],
    geometry: dict,
    start: date,
    end_exclusive: date,
    coverage: tuple[Coverage, ...] | list[Coverage],
    filters: Filters,
) -> ActivityResult:
    if end_exclusive <= start:
        raise ValueError("The activity interval must end after it starts.")
    area_box = geometry_bbox(geometry)
    if area_box is None:
        raise ValueError("Analysis geometry has no coordinates.")
    store_points = [(row.longitude, row.latitude) for row in rows]
    store_box = None
    if store_points:
        store_box = (
            min(point[0] for point in store_points),
            min(point[1] for point in store_points),
            max(point[0] for point in store_points),
            max(point[1] for point in store_points),
        )
    outside_extract = store_box is not None and not _boxes_overlap(area_box, store_box)
    selected_viirs = filters.platforms & VIIRS_IDS
    index = _coverage_index(tuple(coverage))
    aqua_cells: dict[date, set[tuple[int, int]]] = defaultdict(set)
    viirs_cells: dict[date, set[tuple[int, int]]] = defaultdict(set)
    aqua_pixels: dict[date, int] = defaultdict(int)
    area = prepared_area(geometry)
    for row in rows:
        if not _row_kept(row, filters) or not area.contains(row.longitude, row.latitude):
            continue
        day = row.acquired_at.astimezone(UTC).date()
        if row.platform == "aqua":
            aqua_cells[day].add(cell_id(row.longitude, row.latitude))
            aqua_pixels[day] += 1
        else:
            viirs_cells[day].add(cell_id(row.longitude, row.latitude))

    epoch_days = [day for (day, platform), _state in index.items() if platform in selected_viirs]
    epoch = min(epoch_days) if epoch_days else None
    ratios: list[float] = []
    scaled_gaps: list[float] = []
    raw_gaps: list[float] = []
    overlap_dates = sorted({day for (day, platform) in index if platform == "aqua" or platform in selected_viirs})
    for day in overlap_dates:
        aqua_state = index.get((day, "aqua")) if "aqua" in filters.platforms else None
        viirs_state = _combined_state(day, selected_viirs, index)
        if aqua_state != "complete" or viirs_state != "complete":
            continue
        aqua_count = len(aqua_cells.get(day, ()))
        viirs_count = len(viirs_cells.get(day, ()))
        if aqua_count == 0 or viirs_count == 0:
            continue
        ratios.append(viirs_count / aqua_count)
    scale = float(median(ratios)) if len(ratios) >= MIN_OVERLAP_DAYS else None
    if scale is not None:
        for day in overlap_dates:
            aqua_state = index.get((day, "aqua")) if "aqua" in filters.platforms else None
            viirs_state = _combined_state(day, selected_viirs, index)
            if aqua_state != "complete" or viirs_state != "complete":
                continue
            aqua_count = len(aqua_cells.get(day, ()))
            viirs_count = len(viirs_cells.get(day, ()))
            if aqua_count == 0 or viirs_count == 0:
                continue
            scaled_gaps.append(viirs_count - aqua_count * scale)
            raw_gaps.append(viirs_count - aqua_pixels.get(day, 0))
    scaled_error = _mean_absolute(scaled_gaps) if scaled_gaps else None
    raw_error = _mean_absolute(raw_gaps) if raw_gaps else None

    scale_note = (
        f"The overlap scale is {scale:.3f} VIIRS cells per Aqua cell, from {len(ratios)} stored days."
        if scale is not None
        else f"The stored overlap has {len(ratios)} days with both Aqua and VIIRS active cells. At least {MIN_OVERLAP_DAYS} are required before Aqua-era days can be scaled."
    )
    days: list[ActivityDay] = []
    cursor = start
    while cursor < end_exclusive:
        viirs_state = _combined_state(cursor, selected_viirs, index)
        aqua_state = index.get((cursor, "aqua")) if "aqua" in filters.platforms else None
        viirs_era = epoch is not None and cursor >= epoch
        if outside_extract:
            if viirs_state is not None or aqua_state is not None:
                count, state, text = 0, "partial", "The selected area is outside the bounding box of the stored detections."
            else:
                count, state, text = None, "unavailable", "No stored coverage for this UTC day, and the area is outside the stored detections."
        elif viirs_era:
            count, state, text = _viirs_day(viirs_state, len(viirs_cells.get(cursor, ())))
        elif scale is None:
            count = None
            state = "unavailable"
            text = scale_note
        else:
            count, state, text = _aqua_day(aqua_state, len(aqua_cells.get(cursor, ())), scale)
        days.append(ActivityDay(cursor, count, state, text))
        cursor += timedelta(days=1)

    notes = [
        "Values are harmonized 2 km afternoon active cells, not raw detections and not distinct fires.",
        "A zero means no active cell was returned. It is not proof that no fire occurred.",
        "Terra is excluded. Its morning orbit has no VIIRS match across the whole record.",
        "VIIRS-era days use the union of Suomi NPP, NOAA-20, and NOAA-21 cells selected in the query. Aqua cells on those days are not added.",
        "A regional extract does not prove what was observed outside the days and places that were stored.",
        "This area does not intersect the stored detections, so covered days are partial rather than a measured zero." if outside_extract else scale_note,
    ]
    if scaled_error is not None and raw_error is not None:
        comparison = "closer to" if scaled_error < raw_error else "not closer to"
        notes.append(
            f"On {len(ratios)} overlap days, scaled Aqua cells are {comparison} VIIRS cells "
            f"than raw Aqua pixel counts (mean absolute difference {scaled_error:.3f} versus {raw_error:.3f})."
        )
    covered = [day.day.isoformat() for day in days if day.state != "unavailable"]
    if covered:
        coverage_text = f"{store_from_label(coverage)} Covered result days run from {covered[0]} to {covered[-1]}."
    else:
        coverage_text = "No stored afternoon coverage produced a harmonized value for this request."
    return ActivityResult(tuple(days), _overall([day.state for day in days]), coverage_text, tuple(notes), scale, len(ratios), scaled_error, raw_error)


def store_from_label(coverage: tuple[Coverage, ...] | list[Coverage]) -> str:
    if not coverage:
        return "No coverage records are stored."
    return "Coverage follows the stored platform-days."


def _reported_count(state: str, count: float) -> tuple[float | None, str, str]:
    if state == "unknown" and count == 0:
        return None, "unknown", "Stored coverage for this UTC day is unknown, so an empty result is not reported as zero."
    text = {
        "complete": "Stored coverage includes this UTC day.",
        "partial": "Stored coverage for this UTC day is partial.",
        "unknown": "Stored coverage for this UTC day is unknown.",
    }[state]
    return count, state, text


def _viirs_day(state: str | None, cells: int) -> tuple[float | None, str, str]:
    if state is None:
        return None, "unavailable", "This day is in the VIIRS era, and no selected VIIRS coverage is stored. Aqua cells are not substituted."
    count, reported, text = _reported_count(state, float(cells))
    if reported == "complete" and cells == 0:
        text = "VIIRS coverage is stored and no afternoon active cell passed the filters."
    elif count is not None:
        text = f"VIIRS afternoon cell union. {text} Aqua detections on this day are not added."
    return count, reported, text


def _aqua_day(state: str | None, cells: int, scale: float | None) -> tuple[float | None, str, str]:
    if scale is None:
        return None, "unavailable", f"Aqua-era days stay unavailable until at least {MIN_OVERLAP_DAYS} overlap days can fit a scale."
    if state is None:
        return None, "unavailable", "No stored Aqua coverage for this UTC day."
    count, reported, text = _reported_count(state, round(cells * scale, 2))
    if reported == "complete" and cells == 0:
        text = "Aqua coverage is stored and no afternoon active cell passed the filters."
    elif count is not None:
        text = f"Aqua active cells multiplied by the overlap scale of {scale:.3f}. {text}"
    return count, reported, text


class RejectedQuery(ValueError):
    """The analysis request does not match the harmonized contract."""


COMPANION_NOTE = (
    "Returned detections are the FIRMS points that passed the area and native filters. "
    "The calendar remains the harmonized afternoon active-cell series and is not a sum of those points."
)


def evaluate_query(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> tuple[ActivityResult, Filters, date, date, str]:
    if not isinstance(query, dict) or not isinstance(query.get("id"), str) or not query["id"]:
        raise RejectedQuery("Analysis query identity is required.")
    if query.get("processingMode") != "harmonized":
        raise RejectedQuery("This analysis serves harmonized afternoon active cells. Raw counts are not accepted here.")
    geometry = query.get("aoi", {}).get("geometry") if isinstance(query.get("aoi"), dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise RejectedQuery("The analysis area is invalid.")
    resolution = query.get("resolution", "daily")
    if resolution not in {"daily", "weekly", "monthly"}:
        raise RejectedQuery("Choose a daily, weekly, or monthly resolution.")
    try:
        start, end = parse_utc_interval(query.get("interval"))
        filters = filters_from_query(query.get("filters") if isinstance(query.get("filters"), dict) else {})
        result = harmonized_daily_activity(store.rows, geometry, start, end, store.coverage, filters)
    except ValueError as exc:
        raise RejectedQuery(str(exc)) from exc
    updated = (updated_at or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    return result, filters, start, end, updated


def _meta(query_id: str, result: ActivityResult, updated: str, units: dict, completeness: str | None = None, coverage: str | None = None, extra_notes: tuple[str, ...] = ()) -> dict:
    return {
        "queryId": query_id,
        "mode": "live",
        "datasetVersion": DATASET_VERSION,
        "methodVersion": METHOD_VERSION,
        "processingTier": "harmonized-afternoon-cells",
        "completeness": completeness if completeness is not None else result.completeness,
        "coverage": coverage if coverage is not None else result.coverage,
        "updatedAt": updated,
        "units": units,
        "notes": [*result.notes, *extra_notes],
    }


def _metric(value, unit: str, definition: str, availability: str) -> dict:
    return {"value": value, "unit": unit, "definition": definition, "availability": availability}


def _options(body: dict | None) -> dict:
    if not isinstance(body, dict):
        return {}
    options = body.get("options")
    return options if isinstance(options, dict) else {}


def _focused_day(options: dict, start: date, end: date) -> date | None:
    if "day" not in options or options["day"] is None:
        return None
    try:
        focused = date.fromisoformat(str(options["day"])[:10])
    except ValueError as exc:
        raise RejectedQuery("The focused UTC day must be inside the applied analysis period.") from exc
    if focused < start or focused >= end:
        raise RejectedQuery("The focused UTC day must be inside the applied analysis period.")
    return focused


def _page(options: dict) -> tuple[int, int]:
    page = options.get("page", 1)
    page_size = options.get("pageSize", 10)
    if isinstance(page, bool) or not isinstance(page, int) or page < 1 or isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
        raise RejectedQuery("Use a positive page number and a page size from 1 to 100.")
    return page, page_size


def _bucket_start(day: date, resolution: str) -> date:
    if resolution == "weekly":
        return day - timedelta(days=day.weekday())
    if resolution == "monthly":
        return day.replace(day=1)
    return day


def _bucket_end(start: date, resolution: str) -> date:
    if resolution == "weekly":
        return start + timedelta(days=6)
    if resolution == "monthly":
        month = start.month + 1
        year = start.year + (month > 12)
        return date(year, 1 if month > 12 else month, 1) - timedelta(days=1)
    return start


def calendar_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, _filters, _start, _end, updated = evaluate_query(query, store, updated_at)
    return {
        "data": [
            {"date": day.day.isoformat(), "count": day.count, "state": day.state, "coverage": day.coverage}
            for day in result.days
        ],
        "meta": _meta(query["id"], result, updated, {"count": "harmonized active cells", "time": "UTC"}),
    }


def kept_detections(query: dict, store: CanonicalStore, filters: Filters, start: date, end: date, focused: date | None = None) -> list[Detection]:
    geometry = query.get("aoi", {}).get("geometry") if isinstance(query.get("aoi"), dict) else None
    if not isinstance(geometry, dict):
        return []
    rows = []
    area = prepared_area(geometry)
    for row in store.rows:
        day = row.acquired_at.astimezone(UTC).date()
        if day < start or day >= end or (focused is not None and day != focused):
            continue
        if not _row_kept(row, filters) or not area.contains(row.longitude, row.latitude):
            continue
        rows.append(row)
    rows.sort(key=lambda row: row.acquired_at, reverse=True)
    return rows


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def detection_id(row: Detection) -> str:
    return f"{row.platform}:{row.acquired_at.astimezone(UTC).strftime('%Y-%m-%dT%H:%MZ')}:{row.longitude:.5f}:{row.latitude:.5f}"


def observation_record(row: Detection, store: CanonicalStore) -> dict:
    modis = row.platform in {"terra", "aqua"}
    return {
        "id": detection_id(row),
        "acquiredAt": row.acquired_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "sensor": "MODIS" if modis else "VIIRS",
        "platform": row.platform,
        "longitude": row.longitude,
        "latitude": row.latitude,
        "dayNight": "day" if row.day_night == "D" else "night",
        "confidence": (
            {"kind": "numeric", "value": row.confidence_pct if row.confidence_pct is not None else 0, "unit": "native MODIS confidence (0–100)"}
            if modis
            else {"kind": "categorical", "value": row.confidence_class or "nominal"}
        ),
        "frpMw": row.frp_mw,
        "provenance": store.source,
        "productVersion": DATASET_VERSION,
        "processingTier": "firms-active-fire",
    }


def overview_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    rows = kept_detections(query, store, filters, start, end)
    availability = result.completeness
    blank = availability == "unavailable"
    by_day: dict[date, int] = defaultdict(int)
    for row in rows:
        by_day[row.acquired_at.astimezone(UTC).date()] += 1
    peak = min(by_day, key=lambda day: (-by_day[day], day.toordinal())) if by_day else None
    return {
        "data": {
            "detectionCount": _metric(None if blank else len(rows), "returned detections", "FIRMS active-fire records inside the area after the native filters. Not a count of distinct fires or harmonized cells.", availability),
            "daysWithDetections": _metric(None if blank else len(by_day), "UTC days", "UTC days in the applied interval with at least one returned detection.", availability),
            "peakDate": _metric(None if peak is None else peak.isoformat(), "UTC date", "Earliest UTC day tied for the most returned detections. Unavailable days are excluded.", availability),
            "medianFrp": _metric(None if blank else _median([row.frp_mw for row in rows if row.frp_mw is not None]), "MW", "Median fire radiative power of the returned detections that include FRP.", availability),
        },
        "meta": _meta(query["id"], result, updated, {"detectionCount": "returned detections", "frp": "MW", "time": "UTC"}, availability, result.coverage, (COMPANION_NOTE,)),
    }


def time_series_document(query: dict, store: CanonicalStore, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    resolution = query.get("resolution", "daily")
    rows = kept_detections(query, store, filters, start, end)
    counts: dict[tuple[date, str], int] = defaultdict(int)
    for row in rows:
        day = row.acquired_at.astimezone(UTC).date()
        counts[(_bucket_start(day, resolution), row.platform)] += 1
    coverage = _coverage_index(store.coverage)
    groups: list[list[ActivityDay]] = []
    current: date | None = None
    for day in result.days:
        bucket = _bucket_start(day.day, resolution)
        if bucket != current:
            groups.append([day])
            current = bucket
        else:
            groups[-1].append(day)
    series = []
    for group in groups:
        first = group[0].day
        last = group[-1].day
        period_end = _bucket_end(_bucket_start(first, resolution), resolution)
        end_date = last if last < period_end else period_end
        for platform in sorted(filters.platforms):
            states = [coverage.get((day.day, platform), "unavailable") for day in group]
            state = _overall(states)
            series.append({
                "date": first.isoformat(),
                "endDate": end_date.isoformat(),
                "count": 0 if state == "unavailable" else counts.get((_bucket_start(first, resolution), platform), 0),
                "platform": platform,
                "state": state,
            })
    reported = [bucket["state"] for bucket in series]
    return {
        "data": series,
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, _overall(reported) if reported else "unavailable", result.coverage, (COMPANION_NOTE,)),
    }


def observations_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    options = _options(body)
    focused = _focused_day(options, start, end)
    page, page_size = _page(options)
    rows = [row for row in kept_detections(query, store, filters, start, end, focused) if row.day_night in {"D", "N"}]
    offset = (page - 1) * page_size
    coverage = result.coverage if focused is None else f"{focused.isoformat()} UTC. {result.coverage}"
    return {
        "data": {
            "rows": [observation_record(row, store) for row in rows[offset:offset + page_size]],
            "total": len(rows),
            "page": page,
            "pageSize": page_size,
        },
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "frp": "MW", "time": "UTC"}, result.completeness, coverage, (COMPANION_NOTE,)),
    }


def observation_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    wanted = body.get("id") if isinstance(body, dict) else None
    match = next((row for row in kept_detections(query, store, filters, start, end) if detection_id(row) == wanted and row.day_night in {"D", "N"}), None)
    return {
        "data": None if match is None else observation_record(match, store),
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, result.completeness, result.coverage, (COMPANION_NOTE,)),
    }


def map_source_document(query: dict, store: CanonicalStore, body: dict | None = None, updated_at: datetime | None = None) -> dict:
    result, filters, start, end, updated = evaluate_query(query, store, updated_at)
    focused = _focused_day(_options(body), start, end)
    rows = [row for row in kept_detections(query, store, filters, start, end, focused) if row.day_night in {"D", "N"}]
    features = []
    for row in rows:
        record = observation_record(row, store)
        features.append({
            "type": "Feature",
            "id": record["id"],
            "geometry": {"type": "Point", "coordinates": [row.longitude, row.latitude]},
            "properties": {**record, "observationId": record["id"], "queryId": query["id"]},
        })
    coverage = result.coverage if focused is None else f"{focused.isoformat()} UTC. {result.coverage}"
    return {
        "data": {
            "type": "geojson",
            "data": {"type": "FeatureCollection", "features": features},
            "attribution": "NASA FIRMS active-fire detections inside the applied area.",
        },
        "meta": _meta(query["id"], result, updated, {"count": "returned detections", "time": "UTC"}, result.completeness, coverage, (COMPANION_NOTE,)),
    }


def capabilities_payload(store: CanonicalStore, today: date | None = None) -> dict:
    today = today or datetime.now(UTC).date()
    by_platform: dict[str, list[date]] = defaultdict(list)
    for record in store.coverage:
        by_platform[record.platform].append(record.day)
    for row in store.rows:
        by_platform[row.platform].append(row.acquired_at.date())
    platforms = []
    loaded_dates: list[date] = []
    for platform_id, label, sensor in (
        ("terra", "MODIS / Terra", "MODIS"),
        ("aqua", "MODIS / Aqua", "MODIS"),
        ("suomi-npp", "VIIRS / Suomi NPP", "VIIRS"),
        ("noaa-20", "VIIRS / NOAA-20", "VIIRS"),
        ("noaa-21", "VIIRS / NOAA-21", "VIIRS"),
    ):
        dates = by_platform.get(platform_id, [])
        start = min(dates) if dates else MISSION_START[platform_id]
        end = max(dates) if dates else start
        if dates:
            loaded_dates.extend(dates)
        confidence = (
            {"kind": "numeric", "min": 0, "max": 100, "unit": "native MODIS confidence (0–100)"}
            if sensor == "MODIS"
            else {"kind": "categorical", "values": ["low", "nominal", "high"]}
        )
        platforms.append({
            "id": platform_id,
            "label": label,
            "sensor": sensor,
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "confidence": confidence,
        })
    if loaded_dates:
        start_date, end_date = min(loaded_dates), max(loaded_dates)
        description = (
            f"{store.source} Loaded platform-days run from {start_date.isoformat()} to {end_date.isoformat()}. "
            "The harmonized calendar counts 2 km afternoon active cells. Terra is listed for provenance and is not part of the index."
        )
        box = geometry_bbox({"type": "MultiPoint", "coordinates": [[row.longitude, row.latitude] for row in store.rows]}) if store.rows else None
        if box is not None and box[0] == box[2]:
            box = (box[0] - 0.01, box[1], box[2] + 0.01, box[3])
        if box is not None and box[1] == box[3]:
            box = (box[0], box[1] - 0.01, box[2], box[3] + 0.01)
    else:
        start_date, end_date = MISSION_START["aqua"], today
        description = (
            f"{store.source} Every calendar day is unavailable until FIRE_DATA_CSV or DATABASE_URL provides canonical MODIS and VIIRS rows."
        )
        box = None
    if box is None:
        spatial = {"type": "Polygon", "coordinates": [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]]}
    else:
        spatial = {"type": "Polygon", "coordinates": [[
            [box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]],
        ]]}
    return {
        "platforms": platforms,
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "resolutions": ["daily", "weekly", "monthly"],
        "processingModes": ["harmonized"],
        "metrics": ["harmonizedActiveCells"],
        "filterSupport": {"dayNight": True, "frp": True},
        "seasonal": False,
        "anomalies": False,
        "summaries": False,
        "earlyWarning": False,
        "exportFormats": [],
        "spatialCoverage": spatial,
        "coverageDescription": description,
    }


def filters_from_query(payload: dict) -> Filters:
    platforms = payload.get("platforms")
    if not isinstance(platforms, list) or not platforms or not all(isinstance(item, str) for item in platforms):
        raise ValueError("Select at least one platform.")
    unknown = sorted(set(platforms) - set(PLATFORM_CODES))
    if unknown:
        raise ValueError("A selected platform is not part of the canonical archive.")
    day_night = payload.get("dayNight", "all")
    if day_night not in {"all", "day", "night"}:
        raise ValueError("Choose a valid day/night filter.")
    minimum = payload.get("modisConfidenceMin", 0)
    if not isinstance(minimum, int) or isinstance(minimum, bool) or not 0 <= minimum <= 100:
        raise ValueError("MODIS confidence must be a native value from 0 to 100.")
    viirs = payload.get("viirsConfidence", ["low", "nominal", "high"])
    if not isinstance(viirs, list) or any(item not in CONFIDENCE_RANK for item in viirs):
        raise ValueError("Choose native VIIRS confidence categories.")
    if any(platform in VIIRS_IDS for platform in platforms) and not viirs:
        raise ValueError("Select at least one native VIIRS confidence category.")
    frp_min = payload.get("frpMin")
    frp_max = payload.get("frpMax")
    for name, value in (("frpMin", frp_min), ("frpMax", frp_max)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0):
            raise ValueError(f"{name} must be a non-negative number of MW.")
    if frp_min is not None and frp_max is not None and frp_min > frp_max:
        raise ValueError("Minimum FRP cannot exceed maximum FRP.")
    return Filters(frozenset(platforms), day_night, minimum, frozenset(viirs), None if frp_min is None else float(frp_min), None if frp_max is None else float(frp_max))


def parse_utc_interval(interval: dict) -> tuple[date, date]:
    if not isinstance(interval, dict):
        raise ValueError("Analysis requires a UTC interval.")
    try:
        start = datetime.fromisoformat(str(interval.get("start", "")).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(interval.get("endExclusive", "")).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.") from exc
    if start.tzinfo is None or end.tzinfo is None or start.utcoffset() != timedelta(0) or end.utcoffset() != timedelta(0):
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.")
    if start.timetz().replace(tzinfo=None) != time.min or end.timetz().replace(tzinfo=None) != time.min or end <= start:
        raise ValueError("Analysis requires UTC midnight, start-inclusive/end-exclusive dates.")
    if (end.date() - start.date()).days > 366 * 100:
        raise ValueError("Choose a period shorter than 100 years.")
    return start.date(), end.date()
