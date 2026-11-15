"""Regional historical summaries using the existing afternoon active-cell method.

No network acquisition occurs here. Explicit reporting-window coverage is required
at import. A complete reporting window is not cloud-free observation of every cell.
"""
from __future__ import annotations

import calendar
import csv
import hashlib
import json
import math
import os
import sqlite3
import threading
from collections import OrderedDict, defaultdict
from contextlib import closing
from dataclasses import asdict, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import median

from harmonize import (
    AFTERNOON_IDS, CELL_SIZE_M, EARTH_RADIUS_M, METHOD_VERSION,
    CanonicalStore, Coverage, Detection, Filters, RejectedQuery, cell_id, detection_from_row,
    filters_from_query, geometry_bbox, harmonized_daily_activity,
    load_coverage_csv, observation_kept, parse_utc_interval, prepared_area, _row_kept,
)

SCHEMA_VERSION = 1
MINIMUM_YEARS = 3
DEFAULT_FILTERS = Filters(AFTERNOON_IDS, "all", 0, frozenset({"low", "nominal", "high"}), None, None)
_CACHE = OrderedDict()
_LOCK = threading.Lock()


def geometry_key(geometry):
    return hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def day_range(start, end):
    """Unrestricted by the recent map's 31-day acquisition contract."""
    while start < end:
        yield start
        start += timedelta(days=1)


def _row_json(row):
    return {**asdict(row), "acquired_at": row.acquired_at.isoformat()}


def import_archive(path: Path, detections: Path, coverage: Path, manifest: dict):
    """Atomically replace one configured regional extract; no inferred empty days."""
    for field in ("regionId", "regionName", "geometry", "datasetVersion", "sources"):
        if not manifest.get(field):
            raise ValueError(f"Historical manifest requires {field}.")
    prepared_area(manifest["geometry"])
    records = load_coverage_csv(coverage)
    if not records:
        raise ValueError("Explicit reporting-window coverage is required.")
    area = prepared_area(manifest["geometry"])
    coverage_keys = {(record.day, record.platform) for record in records}
    rows = []
    with detections.open(encoding="utf-8-sig", newline="") as handle:
        for item in csv.DictReader(handle):
            row = detection_from_row(item)
            row = replace(row, source_product=item.get("source_product") or None,
                          product_version=item.get("product_version") or None,
                          processing_tier=item.get("processing_tier") or None)
            if not area.contains(row.longitude, row.latitude):
                raise ValueError("An imported detection is outside the manifest region.")
            if (row.acquired_at.date(), row.platform) not in coverage_keys:
                raise ValueError("Every detection needs an explicit platform/day coverage record.")
            rows.append(row)
    payload = json.dumps([_row_json(row) for row in rows], sort_keys=True)
    stable_manifest = {k: v for k, v in manifest.items() if k not in {"generation", "importedAt"}}
    manifest = {**manifest, "schemaVersion": SCHEMA_VERSION, "methodVersion": METHOD_VERSION,
                "importedAt": datetime.now(UTC).isoformat(),
                "generation": hashlib.sha256((payload + json.dumps([asdict(x) for x in records], default=str) + json.dumps(stable_manifest, sort_keys=True)).encode()).hexdigest()}
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS detections (id INTEGER PRIMARY KEY, acquired TEXT, payload TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS detection_time ON detections(acquired)")
        db.execute("CREATE TABLE IF NOT EXISTS coverage (day TEXT, platform TEXT, state TEXT, PRIMARY KEY(day,platform))")
        db.execute("DELETE FROM detections")
        db.execute("DELETE FROM coverage")
        db.execute("INSERT OR REPLACE INTO metadata VALUES (1,?)", (json.dumps(manifest),))
        db.executemany("INSERT INTO detections(acquired,payload) VALUES (?,?)", [(r.acquired_at.isoformat(), json.dumps(_row_json(r))) for r in rows])
        db.executemany("INSERT OR REPLACE INTO coverage VALUES (?,?,?)", [(r.day.isoformat(), r.platform, r.state) for r in records])
    return {"observations": len(rows), "coverageRecords": len(records), **manifest}


def load_archive(path: Path | None = None):
    configured = str(path or os.environ.get("SHARP_HISTORY_PATH", "")).strip()
    if not configured or not Path(configured).is_file():
        return None, None
    file = Path(configured)
    key = (str(file.resolve()), file.stat().st_mtime_ns, file.stat().st_size)
    with _LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    with closing(sqlite3.connect(f"file:{file.as_posix()}?mode=ro", uri=True)) as db:
        manifest = json.loads(db.execute("SELECT payload FROM metadata WHERE id=1").fetchone()[0])
        if manifest.get("methodVersion") != METHOD_VERSION:
            raise ValueError("Historical archive method version is incompatible.")
        rows = []
        for payload, in db.execute("SELECT payload FROM detections ORDER BY acquired,id"):
            item = json.loads(payload)
            item["acquired_at"] = datetime.fromisoformat(item["acquired_at"])
            rows.append(Detection(**item))
        coverage = tuple(Coverage(date.fromisoformat(d), p, s) for d, p, s in db.execute("SELECT day,platform,state FROM coverage"))
    result = manifest, CanonicalStore(tuple(rows), coverage, f"Regional archive {manifest['datasetVersion']}")
    with _LOCK:
        _CACHE[key] = result
        while len(_CACHE) > 2:
            _CACHE.popitem(last=False)
    return result


def supports_geometry(manifest, geometry):
    if geometry_key(manifest["geometry"]) == geometry_key(geometry):
        return True
    # A rectangular import domain can safely provide coverage to any contained AOI.
    bounds = geometry_bbox(manifest["geometry"])
    rings = manifest["geometry"].get("coordinates", [])
    if manifest["geometry"].get("type") != "Polygon" or len(rings) != 1:
        return False
    corners = {(bounds[0], bounds[1]), (bounds[0], bounds[3]), (bounds[2], bounds[1]), (bounds[2], bounds[3])}
    if set(tuple(p) for p in rings[0]) != corners:
        return False
    selected = geometry_bbox(geometry)
    return selected is not None and bounds[0] <= selected[0] <= selected[2] <= bounds[2] and bounds[1] <= selected[1] <= selected[3] <= bounds[3]


def quantile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    position = (len(values) - 1) * fraction
    lo, hi = math.floor(position), math.ceil(position)
    return values[lo] + (values[hi] - values[lo]) * (position - lo)


def method_evidence(query, store):
    start, end = parse_utc_interval(query.get("interval"))
    filters = filters_from_query(query.get("filters", {}))
    geometry = query["aoi"]["geometry"]
    activity = harmonized_daily_activity(store.rows, geometry, start, end, store.coverage, filters)
    area = prepared_area(geometry)
    cells = defaultdict(lambda: {"aqua": set(), "viirs": set()})
    for row in store.rows:
        if not _row_kept(row, filters) or not area.contains(row.longitude, row.latitude):
            continue
        cells[row.acquired_at.date()]["aqua" if row.platform == "aqua" else "viirs"].add(cell_id(row.longitude, row.latitude))
    coverage_states = {(r.day, r.platform): r.state for r in store.coverage}
    overlap = []
    for day, counts in sorted(cells.items()):
        states = [coverage_states[(day, p)] for p in filters.platforms - {"aqua", "terra"} if (day, p) in coverage_states]
        if coverage_states.get((day, "aqua")) == "complete" and states and all(s == "complete" for s in states) and counts["aqua"] and counts["viirs"]:
            overlap.append({"date": day.isoformat(), "aquaCells": len(counts["aqua"]), "viirsCells": len(counts["viirs"]),
                            "scaledAquaCells": len(counts["aqua"]) * activity.scale if activity.scale is not None else None,
                            "commonCells": len(counts["aqua"] & counts["viirs"])})
    return {"queryId": query.get("id"), "methodVersion": METHOD_VERSION,
            "name": "Harmonized afternoon active cells", "gridSizeM": CELL_SIZE_M,
            "gridProjection": "Cylindrical equal-area, spherical radius 6371007.2 m",
            "platforms": sorted(filters.platforms & AFTERNOON_IDS), "terraExcluded": True,
            "calibrationPeriod": {"start": overlap[0]["date"], "end": overlap[-1]["date"]} if overlap else None,
            "usableOverlapDays": activity.overlap_days, "fittedScale": activity.scale,
            "agreement": {"kind": "calibration-fit", "meanAbsoluteDifferenceCells": activity.scaled_error,
                          "unit": "afternoon active cells", "rawPixelMeanAbsoluteDifference": activity.raw_pixel_error,
                          "rawComparisonDefinition": "Aqua raw observation count minus VIIRS cell count; descriptive cross-unit count gap, not physical error or independent validation"},
            "independentValidation": None, "overlap": overlap,
            "coverageRestriction": "Stored reporting windows do not establish cloud-free observation of every cell.",
            "notes": ["Calibration agreement is not held-out validation or actual fire detection accuracy.", *activity.notes]}


def history_document(query, options=None, now=None, archive=None):
    now = now or datetime.now(UTC)
    options = options or {}
    manifest, store = archive if archive is not None else load_archive()
    empty = {"queryId": query.get("id"), "methodVersion": METHOD_VERSION, "status": "unavailable", "unit": "active-cell-days", "months": [], "daily": [], "baseline": None, "comparison": None}
    if store is None:
        return {**empty, "reason": "No regional historical reporting dataset has been loaded."}
    geometry = query["aoi"]["geometry"]
    if not supports_geometry(manifest, geometry):
        return {**empty, "reason": "Historical coverage is unavailable for this region. Choose the imported region or an area inside its rectangular coverage domain.", "datasetVersion": manifest["datasetVersion"]}
    start, end = parse_utc_interval(query.get("interval"))
    if not store.coverage:
        return {**empty, "reason": "The regional dataset contains no reporting coverage."}
    first = min(r.day for r in store.coverage)
    last = max(r.day for r in store.coverage)
    full_start = date(min(first.year, start.year), 1, 1)
    full_end = min(date(max(last.year, end.year - int(end.month == 1 and end.day == 1)) + 1, 1, 1), now.date() + timedelta(days=1))
    filters = filters_from_query(query.get("filters", {}))
    result = harmonized_daily_activity(store.rows, geometry, full_start, full_end, store.coverage, filters)
    daily = {d.day: {"date": d.day.isoformat(), "value": d.count, "state": "partial" if d.day == now.date() and d.state == "complete" else d.state, "coverage": d.coverage} for d in result.days}
    grouped = defaultdict(list)
    for day, value in daily.items():
        grouped[(day.year, day.month)].append(value)
    months = []
    for (year, month), values in sorted(grouped.items()):
        expected = calendar.monthrange(year, month)[1]
        covered = sum(d["state"] == "complete" and d["value"] is not None for d in values)
        observed = sum(d["value"] for d in values if d["value"] is not None)
        complete = covered == expected
        months.append({"year": year, "month": month, "value": observed if complete else None,
                       "observedSum": observed if any(d["value"] is not None for d in values) else None,
                       "coveredDays": covered, "expectedDays": expected,
                       "state": "complete" if complete else "partial" if covered else "unavailable"})
    requested_years = options.get("baselineYears", sorted({r.day.year for r in store.coverage if r.day.year < start.year}))
    if not isinstance(requested_years, list) or len(requested_years) > 100 or any(not isinstance(y, int) or not 1900 <= y <= 2200 for y in requested_years):
        raise ValueError("baselineYears must contain at most 100 calendar years.")
    years = sorted(set(requested_years))
    minimum = max(MINIMUM_YEARS, int(options.get("minimumYears", MINIMUM_YEARS)))
    baseline_months = []
    for month in range(1, 13):
        # Exclude leap day from every seasonal comparison for equal exposure.
        included, excluded, values = [], [], []
        for year in years:
            days = [d for d in day_range(date(year, month, 1), date(year + (month == 12), month % 12 + 1, 1)) if (d.month, d.day) != (2, 29)]
            if all(d in daily and daily[d]["state"] == "complete" and daily[d]["value"] is not None for d in days):
                values.append(sum(daily[d]["value"] for d in days))
                included.append(year)
            else:
                excluded.append(year)
        enough = len(included) >= minimum
        baseline_months.append({"month": month, "median": median(values) if enough else None,
                                "q25": quantile(values, .25) if enough else None, "q75": quantile(values, .75) if enough else None,
                                "eligibleYears": included, "excludedYears": excluded})
    # Selected period is capped at completed UTC days; compare identical month/day exposure.
    lower = datetime.fromisoformat(query["interval"]["start"].replace("Z", "+00:00"))
    upper = datetime.fromisoformat(query["interval"]["endExclusive"].replace("Z", "+00:00"))
    completed_start = start + (timedelta(days=1) if lower.time() != datetime.min.time() else timedelta(0))
    effective_end = min(upper.date(), now.date())
    selected_days = [d for d in day_range(completed_start, effective_end) if (d.month, d.day) != (2, 29)]
    comparison = {"observedValue": None, "median": None, "difference": None, "eligibleYears": [], "excludedYears": [],
                  "coveredDays": 0, "expectedDays": len(selected_days), "endExclusive": effective_end.isoformat(),
                  "state": "unavailable", "partialPeriod": effective_end < end or completed_start != start}
    # A period of <= 1 calendar year maps each month/day once to each baseline year.
    if selected_days and len({(d.month, d.day) for d in selected_days}) == len(selected_days):
        covered = sum(d in daily and daily[d]["state"] == "complete" and daily[d]["value"] is not None for d in selected_days)
        comparison["coveredDays"] = covered
        values = []
        for year in years:
            shifted = [date(year + d.year - start.year, d.month, d.day) for d in selected_days]
            if set(shifted) & set(selected_days):
                comparison["excludedYears"].append(year)
            elif all(d in daily and daily[d]["state"] == "complete" and daily[d]["value"] is not None for d in shifted):
                comparison["eligibleYears"].append(year)
                values.append(sum(daily[d]["value"] for d in shifted))
            else:
                comparison["excludedYears"].append(year)
        if covered == len(selected_days):
            comparison["observedValue"] = sum(daily[d]["value"] for d in selected_days)
        if len(values) >= minimum and comparison["observedValue"] is not None:
            comparison.update(median=median(values), q25=quantile(values, .25), q75=quantile(values, .75),
                              difference=comparison["observedValue"] - median(values), state="available")
    return {"queryId": query.get("id"), "methodVersion": METHOD_VERSION,
            "datasetVersion": manifest["datasetVersion"], "sourceGeneration": manifest["generation"],
            "status": "available" if any(m["observedSum"] is not None for m in months) else "unavailable",
            "unit": "active-cell-days", "region": {"id": manifest["regionId"], "name": manifest["regionName"]},
            "sources": manifest["sources"], "importedAt": manifest["importedAt"],
            "coverage": {"start": first.isoformat(), "endInclusive": last.isoformat(), "reportingWindowOnly": True},
            "months": months, "daily": list(daily.values()),
            "baseline": {"years": years, "minimumYears": minimum, "requiredCoverage": "Every compared UTC day complete with a nonmissing harmonized value",
                         "statistic": "median", "typicalRange": "25th–75th percentile (linear interpolation)",
                         "leapDayPolicy": "29 February excluded from every comparison; retained in monthly observed totals",
                         "partialPeriodPolicy": "Compare equivalent completed UTC dates; no extrapolation",
                         "compatibility": METHOD_VERSION, "months": baseline_months},
            "comparison": comparison, "evidence": method_evidence(query, store)}


def cell_polygon(key, size=CELL_SIZE_M):
    x, y = key
    west, east = math.degrees(x * size / EARTH_RADIUS_M), math.degrees((x + 1) * size / EARTH_RADIUS_M)
    south = math.degrees(math.asin(max(-1, min(1, y * size / EARTH_RADIUS_M))))
    north = math.degrees(math.asin(max(-1, min(1, (y + 1) * size / EARTH_RADIUS_M))))
    return {"type": "Polygon", "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}


def recurrence_document(query, store):
    start, end = parse_utc_interval(query.get("interval"))
    lower = datetime.fromisoformat(query["interval"]["start"].replace("Z", "+00:00"))
    upper = datetime.fromisoformat(query["interval"]["endExclusive"].replace("Z", "+00:00"))
    filters = filters_from_query(query.get("filters", {}))
    area = prepared_area(query["aoi"]["geometry"])
    cells = defaultdict(list)
    for row in store.rows:
        if lower <= row.acquired_at < upper and observation_kept(row, filters) and area.contains(row.longitude, row.latitude):
            cells[cell_id(row.longitude, row.latitude)].append(row)
    if len(cells) > 20000:
        raise RejectedQuery("Recurrence exceeds 20,000 occupied 2 km cells. Choose a smaller area or interval.")
    covered = {r.day for r in store.coverage if r.platform in filters.platforms and r.state == "complete" and start <= r.day < end}
    features = []
    for key, rows in sorted(cells.items()):
        dates = sorted({r.acquired_at.date().isoformat() for r in rows})
        features.append({"type": "Feature", "id": f"recurrence:{key[0]}:{key[1]}", "geometry": cell_polygon(key),
                         "properties": {"id": f"recurrence:{key[0]}:{key[1]}", "distinctDates": len(dates), "dates": dates,
                                        "observationCount": len(rows), "firstAcquiredAt": min(r.acquired_at for r in rows).isoformat(),
                                        "latestAcquiredAt": max(r.acquired_at for r in rows).isoformat(), "coveredReportingDays": len(covered),
                                        "selectedDays": (end - start).days}})
    return {"queryId": query.get("id"), "type": "FeatureCollection", "features": features,
            "gridSizeM": CELL_SIZE_M, "unit": "distinct UTC dates with reported detections",
            "coverage": "Reporting-window completeness does not establish cell observation or continuous burning."}
