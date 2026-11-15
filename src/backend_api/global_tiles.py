
from __future__ import annotations

import base64
import binascii
import csv
import gzip
import hashlib
import io
import json
import math
import os
import threading
import time
from collections import OrderedDict
from contextlib import closing
from datetime import UTC, datetime, timedelta

from harmonize import CanonicalStore, Detection, RejectedQuery, observation_record
from observation_explorer import _number, _instant, freshness_metadata

SCHEMA = "global-squares-1"
MERCATOR_LIMIT = 85.0511287798066
MAX_TILE_FEATURES = 1024
MAX_TILE_CACHE_BYTES = 32 * 1024 * 1024
_CACHE = OrderedDict()
_COUNTS = OrderedDict()
_STORED_PERIODS = OrderedDict()
_CACHE_STATS = {"requests": 0, "hits": 0, "generated": 0}
_CACHE_LOCK = threading.RLock()
_BUILD_LOCKS = [threading.Lock() for _ in range(32)]


def cache_statistics():
    with _CACHE_LOCK:
        return {**_CACHE_STATS, "entries": len(_CACHE), "bytes": sum(len(v[0]) + len(v[1]) for v in _CACHE.values()), "scope": "current serving process"}


class SnapshotUnavailable(ValueError):
    pass


class IntervalUnavailable(RejectedQuery):
    def __init__(self, message, coverage):
        super().__init__(message)
        self.coverage = coverage


def utc(value):
    if isinstance(value, (float, int)):
        return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
    return value


def severity(power):
    return "unknown" if power is None or not math.isfinite(power) or power < 0 else "high" if power >= 50 else "moderate" if power >= 10 else "low"


def unpack_detection(payload):
    item = json.loads(payload)
    item["acquired_at"] = datetime.fromisoformat(item["acquired_at"].replace("Z", "+00:00"))
    return Detection(**item)


def published_freshness(manifest):
    states = tuple(manifest.get("sources", []))
    retrievals = [datetime.fromisoformat(state["retrievedAt"].replace("Z", "+00:00")).timestamp() for state in states if state.get("retrievedAt")]
    fetched = min(retrievals) if retrievals else None
    expires = fetched + int(os.environ.get("SHARP_GLOBAL_STALE_SECONDS", "3600")) if fetched is not None else None
    if any(state.get("status") != "ok" for state in states):
        expires = min(expires or time.time(), time.time())
    canonical = CanonicalStore((), (), "Published global FIRMS snapshot", fetched, expires, source_states=states)
    return {**freshness_metadata(canonical), "fetchedAt": utc(fetched), "expiresAt": utc(expires)}


def canonical_record(row, store):
    record = observation_record(row, store)
    
    
    record["productVersion"] = row.product_version
    record["processingTier"] = row.processing_tier
    if row.frp_mw is not None and (not math.isfinite(row.frp_mw) or row.frp_mw < 0):
        record["frpMw"] = None
    return record


def encode_group(snapshot, window, level, x, y, filters):
    body = json.dumps({"s": snapshot, "w": window, "l": level, "x": x, "y": y, "f": filters}, sort_keys=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")


def decode_group(value, snapshot, window):
    try:
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError()
        group = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if group["s"] != snapshot or group["w"] != window or not isinstance(group["f"], dict):
            raise ValueError()
        level, x, y = group["l"], group["x"], group["y"]
        if any(type(v) is not int for v in (level, x, y)) or not 0 <= level <= 26 or not 0 <= x < 2 ** level or not 0 <= y < 2 ** level:
            raise ValueError()
        return group
    except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error) as exc:
        raise RejectedQuery("This observation group belongs to another snapshot or has an invalid cell identity.") from exc


def _filter_sql(options, _depth=0):
    
    if not isinstance(options, dict):
        raise RejectedQuery("Observation filters must be an object.")
    clauses, parameters = [], []
    if _depth > 8:
        raise RejectedQuery("Nested frozen filter scope exceeds the supported bound.")
    if 'all' in options:
        if not isinstance(options['all'], list) or len(options['all']) > 8:
            raise RejectedQuery("Frozen filter conjunction is invalid.")
        for condition in options['all']:
            nested, arguments = _filter_sql(condition, _depth+1)
            clauses.extend(nested); parameters.extend(arguments)
    if '__bounds' in options:
        bounds = options['__bounds']
        if not isinstance(bounds, list) or len(bounds) != 4 or any(not isinstance(v, (int,float)) or not math.isfinite(v) for v in bounds):
            raise RejectedQuery("Frozen spatial scope is invalid.")
        clauses.extend(['o.mx>=?', 'o.my>=?', 'o.mx<?', 'o.my<?']); parameters.extend(bounds)
    def add(sql, *values):
        clauses.append(sql); parameters.extend(values)
    hour = options.get("acquisitionHour")
    if hour is not None:
        if type(hour) is not int or not 0 <= hour <= 23:
            raise RejectedQuery("Acquisition hour must be an integer from 0 to 23 UTC.")
        add("CAST(strftime('%H',o.acquired,'unixepoch') AS INTEGER)=?", hour)
    for key in ("platform", "sensor", "source", "dayNight", "observationId", "search", "sort", "groupBy"):
        if options.get(key) is not None and not isinstance(options[key], str):
            raise RejectedQuery(f"{key} requires text.")
    modis = "o.platform IN ('aqua','terra')"
    for key, expression in (("platform", "o.platform"), ("observationId", "o.observation_id"), ("source", "json_extract(o.payload,'$.source_product')")):
        if options.get(key) not in (None, "", "all"):
            add(expression + "=?", options[key])
    sensor = options.get("sensor")
    if sensor not in (None, "", "all", "MODIS", "VIIRS"):
        raise RejectedQuery("Choose MODIS or VIIRS.")
    if sensor in ("MODIS", "VIIRS"):
        add(modis if sensor == "MODIS" else "NOT (" + modis + ")")
    daylight = options.get("dayNight")
    if daylight not in (None, "", "all", "day", "night", "unknown"):
        raise RejectedQuery("Choose day, night, or unknown metadata.")
    if daylight not in (None, "", "all"):
        native = "json_extract(o.payload,'$.day_night')"
        add(native + "=?", "D" if daylight == "day" else "N") if daylight != "unknown" else add(f"({native} IS NULL OR {native} NOT IN ('D','N'))")
    for name, op in (("frpMin", ">="), ("frpMax", "<="), ("frpMaxExclusive", "<")):
        value = _number(options, name)
        if value is not None: add("o.frp" + op + "?", value)
    if options.get("frpUnknown"):
        add("o.frp IS NULL")
    lower, upper = _number(options, "frpMin"), _number(options, "frpMax")
    if lower is not None and upper is not None and lower > upper:
        raise RejectedQuery("FRP minimum cannot exceed maximum.")
    for name, op in (("modisConfidenceMin", ">="), ("modisConfidenceMax", "<=")):
        value = _number(options, name)
        if value is not None:
            if value > 100: raise RejectedQuery("MODIS confidence uses the native 0–100 scale.")
            add(modis); add("json_extract(o.payload,'$.confidence_pct')" + op + "?", value)
    if options.get("modisConfidenceUnknown"):
        add(modis); add("json_extract(o.payload,'$.confidence_pct') IS NULL")
    if options.get("viirsConfidence") is not None:
        classes = options["viirsConfidence"]
        if not isinstance(classes, list) or not classes or any(c not in ("low", "nominal", "high", "unknown") for c in classes):
            raise RejectedQuery("Choose native VIIRS confidence classes.")
        add("NOT (" + modis + ")")
        add("COALESCE(json_extract(o.payload,'$.confidence_class'),'unknown') IN (" + ",".join("?" for _ in classes) + ")", *classes)
    start, end = _instant(options, "acquiredStart"), _instant(options, "acquiredEndExclusive")
    if start is not None and end is not None and start >= end:
        raise RejectedQuery("Acquisition start must precede the exclusive end.")
    if start: add("o.acquired>=?", start.timestamp())
    if end: add("o.acquired<?", end.timestamp())
    if options.get("day"):
        try: day = datetime.strptime(options["day"], "%Y-%m-%d").replace(tzinfo=UTC)
        except (ValueError, TypeError) as exc: raise RejectedQuery("Focused date must be a UTC calendar date.") from exc
        add("o.acquired>=? AND o.acquired<?", day.timestamp(), day.timestamp() + 86400)
    search = options.get("search", "").strip().casefold().replace("-", " ")
    if len(search) > 256: raise RejectedQuery("Search supports at most 256 characters.")
    if search:
        search = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        expression = "o.observation_id || ' ' || o.platform || ' ' || CASE WHEN " + modis + " THEN 'MODIS' ELSE 'VIIRS' END || ' ' || COALESCE(json_extract(o.payload,'$.source_product'),'')"
        add("LOWER(REPLACE(" + expression + ",'-',' ')) LIKE ? ESCAPE '\\'", "%" + search + "%")
    return clauses, parameters


class GlobalPresentation:
    def __init__(self, store):
        self.store = store

    def _counts(self, snapshot, window, source, interval_params):
        key = (str(self.store.path), snapshot, window, tuple(interval_params[:3]))
        with _CACHE_LOCK:
            remembered = _COUNTS.get(key)
            if remembered is not None:
                _COUNTS.move_to_end(key); return remembered
        with closing(self.store.connect()) as db:
            result = tuple(db.execute("SELECT COUNT(*),COALESCE(SUM(CASE WHEN o.latitude>? OR o.latitude<? THEN 1 ELSE 0 END),0) FROM " + source + " WHERE p.snapshot=? AND o.acquired>=? AND o.acquired<?", [MERCATOR_LIMIT, -MERCATOR_LIMIT, *interval_params[:3]]).fetchone())
        with _CACHE_LOCK:
            _COUNTS[key] = result
            while len(_COUNTS) > 256: _COUNTS.popitem(last=False)
        return result

    def _manifest(self, snapshot, window, custom_interval=False):
        if window not in ("24h", "48h", "7d"):
            raise RejectedQuery("Choose a published 24h, 48h, or 7d window.")
        try:
            manifest = self.store.snapshot_manifest(snapshot, window) if snapshot else self.store.current_manifest(window)
        except ValueError as exc:
            raise SnapshotUnavailable(str(exc)) from exc
        if not manifest or not (manifest.get("snapshotId") or manifest.get("snapshot")):
            raise SnapshotUnavailable("No global observation snapshot has been published yet.")
        if not custom_interval and manifest.get("status") in {"building", "unavailable"}:
            raise SnapshotUnavailable("Satellite observations for the selected interval are still loading or unavailable.")
        interval = manifest.get("interval") or manifest.get("windows", {}).get(window) or manifest
        start = interval.get("start") or interval.get("startUtc")
        end = interval.get("endExclusive") or interval.get("endUtcExclusive")
        if not start or not end:
            raise SnapshotUnavailable("The requested stored interval is unavailable or still building.")
        return manifest, start, end

    def _stored_interval(self, manifest, requested):
        if not isinstance(requested, dict):
            raise RejectedQuery("The investigation period requires UTC start and exclusive end timestamps.")
        lower, upper = _instant(requested, "start"), _instant(requested, "endExclusive")
        if lower is None or upper is None or lower >= upper:
            raise RejectedQuery("The investigation period requires a UTC start before its exclusive end.")
        if upper - lower > timedelta(days=31):
            raise RejectedQuery("Worldwide observation investigations support at most 31 selected days.")
        snapshot = manifest.get("snapshotId") or manifest["snapshot"]
        key = (str(self.store.path), snapshot)
        with _CACHE_LOCK:
            partitions = _STORED_PERIODS.get(key)
            if partitions is not None:
                _STORED_PERIODS.move_to_end(key)
        if partitions is None:
            with closing(self.store.connect()) as db:
                db.execute("BEGIN")
                if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                    raise SnapshotUnavailable("The observation snapshot expired; refresh the investigation.")
                partitions = tuple(dict(row) for row in db.execute(
                    "SELECT p.source,p.start,p.end,p.coverage FROM global_partition_versions p "
                    "JOIN global_snapshot_partitions s ON s.version=p.version WHERE s.snapshot=? ORDER BY p.source,p.start", (snapshot,)))
            with _CACHE_LOCK:
                _STORED_PERIODS[key] = partitions
                while len(_STORED_PERIODS) > 256:
                    _STORED_PERIODS.popitem(last=False)
        interval = {"start": utc(lower.timestamp()), "endExclusive": utc(upper.timestamp())}
        first = min((partition["start"] for partition in partitions), default=None)
        last = max((partition["end"] for partition in partitions), default=None)
        available = {"start": utc(first), "endExclusive": utc(last)} if first is not None else None
        sources = {state["source"] for state in manifest.get("sources", [])}
        sources.update(partition["source"] for partition in partitions)
        source_coverage = []
        for source in sorted(sources):
            segments = [partition for partition in partitions if partition["source"] == source]
            cursor = lower.timestamp()
            for segment in segments:
                if segment["coverage"] != "unknown" and segment["start"] <= cursor < segment["end"]:
                    cursor = max(cursor, segment["end"])
            source_coverage.append({"source": source, "complete": cursor >= upper.timestamp(),
                "intervals": [{"start": utc(segment["start"]), "endExclusive": utc(segment["end"]), "reportingCoverage": segment["coverage"]} for segment in segments]})
        coverage = {"requestedInterval": interval, "availableInterval": available,
                    "sources": source_coverage, "meaning": manifest.get("coverageMeaning"),
                    "complete": bool(source_coverage) and all(source["complete"] for source in source_coverage)}
        if first is None:
            raise IntervalUnavailable("No stored worldwide observations support this UTC period. Choose a date within the stored coverage.", coverage)
        first_day = datetime.fromtimestamp(first, UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        last_instant = datetime.fromtimestamp(last, UTC)
        last_day_end = last_instant.replace(hour=0, minute=0, second=0, microsecond=0)
        if last_instant != last_day_end:
            last_day_end += timedelta(days=1)
        
        
        if (lower < first_day or upper > last_day_end or
                not any(partition["start"] < upper.timestamp() and partition["end"] > lower.timestamp() for partition in partitions)):
            raise IntervalUnavailable(
                f"This period is outside stored worldwide coverage ({first_day.date().isoformat()} through {(last_day_end - timedelta(days=1)).date().isoformat()} UTC). Choose a covered date range.", coverage)
        complete = coverage["complete"] and all(state.get("status") == "ok" for state in manifest.get("sources", []))
        manifest = {**manifest, "interval": interval, "coverage": coverage,
                    "availableInterval": available, "status": "ready" if complete else "partial",
                    "completeness": "complete" if complete else "partial"}
        return manifest, interval["start"], interval["endExclusive"]

    def _base(self, snapshot, window, aggregate=None, display_filters=None, interval=None):
        manifest, start, end = self._manifest(snapshot, window, custom_interval=interval is not None)
        original_start, original_end = start, end
        if interval is not None:
            manifest, start, end = self._stored_interval(manifest, interval)
            if aggregate and (datetime.fromisoformat(start.replace("Z", "+00:00")) < datetime.fromisoformat(original_start.replace("Z", "+00:00")) or
                              datetime.fromisoformat(end.replace("Z", "+00:00")) > datetime.fromisoformat(original_end.replace("Z", "+00:00"))):
                raise IntervalUnavailable("This period exceeds the frozen observation group's interval. Return to the whole area before changing dates.", manifest["coverage"])
        snapshot = manifest.get("snapshotId") or manifest["snapshot"]
        clauses = ["p.snapshot=?", "o.acquired>=?", "o.acquired<?"]
        params = [snapshot, datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp(), datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp()]
        filters = display_filters or {}
        if aggregate:
            group = decode_group(aggregate, snapshot, window)
            filters = group["f"]
            scale = 2 ** group["l"]
            clauses.extend(["o.mx>=?", "o.mx<?", "o.my>=?", "o.my<?", "o.latitude>=?", "o.latitude<=?"])
            params.extend([group["x"] / scale, (group["x"] + 1) / scale, group["y"] / scale, (group["y"] + 1) / scale, -MERCATOR_LIMIT, MERCATOR_LIMIT])
        extra, arguments = _filter_sql(filters)
        clauses.extend(extra); params.extend(arguments)
        source = "global_observations o JOIN global_snapshot_observations p ON p.row_id=o.id"
        return manifest, snapshot, source, clauses, params, filters, {"start": start, "endExclusive": end}

    def manifest(self, window="24h"):
        from global_raster import RASTER_STYLE
        if window not in {"24h", "48h", "7d"}:
            raise RejectedQuery("Choose a supported 24h, 48h, or 7d interval.")
        current = self.store.current_manifest(window)
        progress = self.store.ingestion_status()
        if not current.get("snapshot"):
            return {**current, "snapshotId": None, "count": None}
        if current.get("status") in {"building", "unavailable"}:
            return {"status": "building" if progress["active"] else "unavailable", "window": window,
                    "reason": "Fetching satellite observations for the selected interval." if progress["active"] else "The selected interval has not finished loading.",
                    "snapshotId": None, "count": None, "refreshing": progress["active"], "refresh": progress}
        try: manifest, snapshot, source, clauses, params, _filters, interval = self._base(None, window)
        except SnapshotUnavailable as exc:
            return {"status": "unavailable", "window": window, "reason": str(exc), "snapshotId": None, "count": None}
        row = self._counts(snapshot, window, source, params)
        status = manifest.get("status", "partial")
        if manifest.get("stale") and status != "unavailable": status = "stale"
        return {**manifest, "snapshotId": snapshot, "window": window, "interval": interval, "status": status,
                "refreshing": progress["active"], "refresh": progress,
                "count": row[0], "polarCount": row[1] or 0, "presentationSchema": SCHEMA,
                "completeness": "complete" if manifest.get("status") == "ready" else "partial" if row[0] else "unavailable",
                "renderingExtent": [-180, -MERCATOR_LIMIT, 180, MERCATOR_LIMIT],
                "renderingNote": "Mercator square tiles cover ±85.0511°. Polar observations remain in canonical counts, inspection and exports.",
                "tiles": f"/firms-api/global/tiles/{snapshot}/{window}/{{z}}/{{x}}/{{y}}.json",
                "pointTiles": f"/firms-api/global/point-tiles/{snapshot}/{window}/{{z}}/{{x}}/{{y}}.pbf",
                "rasterTiles": f"/firms-api/global/raster/{snapshot}/{window}/{RASTER_STYLE}/{{z}}/{{x}}/{{y}}.png",
                "rasterTileSize": 512, "rasterMaxZoom": 18, "rasterStyle": RASTER_STYLE,
                "pointSourceLayer": "observations", "pointSchema": "global-observation-points-1",
                "pointExtent": 65536, "pointMaxZoom": 18, "pointBufferPixels": 8,
                "pointColorMeaning": "Each square is one reported satellite detection, colored by its valid reported FRP in MW.",
                "maxZoom": 18, "maxTileFeatures": MAX_TILE_FEATURES,
                "aggregateColorMeaning": "Maximum valid reported FRP in MW; counts are observation records, not fire incidents.",
                "supportedDisplayFilters": ["platform", "sensor", "source", "dayNight", "frpMin", "frpMax", "frpUnknown", "modisConfidenceMin", "viirsConfidence"]}

    def tile(self, snapshot, window, z, x, y, filters=None, aggregate=None):
        if any(type(v) is not int for v in (z, x, y)) or not 0 <= z <= 18 or not 0 <= x < 2 ** z or not 0 <= y < 2 ** z:
            raise RejectedQuery("Invalid global tile coordinates.")
        filters = filters or {}
        temporary_filters = filters
        manifest, snapshot, source, clauses, params, filters, interval = self._base(snapshot, window, aggregate=aggregate, display_filters=filters)
        if aggregate:
            frozen = decode_group(aggregate, snapshot, window)
            additional, values = _filter_sql(temporary_filters)
            clauses.extend(additional); params.extend(values)
            scale = 2 ** frozen['l']
            filters = {'all': [filters, temporary_filters], '__bounds': [frozen['x']/scale, frozen['y']/scale, (frozen['x']+1)/scale, (frozen['y']+1)/scale]}
        encoded = json.dumps(filters, sort_keys=True, separators=(",", ":"))
        cache_key = (snapshot, window, z, x, y, encoded, SCHEMA, aggregate)
        with _CACHE_LOCK:
            _CACHE_STATS["requests"] += 1
            cached = _CACHE.get(cache_key)
            if cached:
                _CACHE_STATS["hits"] += 1
                _CACHE.move_to_end(cache_key); return cached
        with _BUILD_LOCKS[hash(cache_key) % len(_BUILD_LOCKS)]:
            with _CACHE_LOCK:
                if cache_key in _CACHE:
                    _CACHE_STATS["hits"] += 1
                    return _CACHE[cache_key]
            started = time.perf_counter()
            scale = 2 ** z
            clauses.extend(["o.mx>=?", "o.mx<?", "o.my>=?", "o.my<?", "o.latitude>=?", "o.latitude<=?"])
            params.extend([x / scale, (x + 1) / scale, y / scale, (y + 1) / scale, -MERCATOR_LIMIT, MERCATOR_LIMIT])
            if z > 0:
                west, east = x / scale * 360 - 180, (x + 1) / scale * 360 - 180
                north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / scale))))
                south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / scale))))
                clauses.append("o.id IN (SELECT id FROM global_spatial WHERE max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=?)")
                
                if x == 0:
                    clauses[-1] = "(o.id IN (SELECT id FROM global_spatial WHERE max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=?) OR o.longitude=180)"
                params.extend([west, east, south, north])
            where = " FROM " + source + " WHERE " + " AND ".join(clauses)
            features = []
            canonical = CanonicalStore((), (), "Published global FIRMS snapshot " + snapshot)
            def point(row):
                detection = unpack_detection(row[0])
                record = canonical_record(detection, canonical)
                record.update(kind="observation", count=1, severity=severity(detection.frp_mw), snapshotId=snapshot, utcDay=detection.acquired_at.date().isoformat(), acquiredEpoch=detection.acquired_at.timestamp() * 1000)
                return {"type": "Feature", "id": record["id"], "geometry": {"type": "Point", "coordinates": [detection.longitude, detection.latitude]}, "properties": record}
            with closing(self.store.connect()) as db:
                count = db.execute("SELECT COUNT(*)" + where, params).fetchone()[0]
                if z >= 12 and count <= MAX_TILE_FEATURES:
                    features = [point(row) for row in db.execute("SELECT o.payload" + where + " ORDER BY o.observation_id", params)]
                else:
                    level = z + 4; n = 2 ** level
                    groups = db.execute(f"SELECT CAST(o.mx*{n} AS INTEGER) gx,CAST(o.my*{n} AS INTEGER) gy,COUNT(*),MAX(CASE WHEN o.frp>=0 THEN o.frp END),MIN(o.acquired),MAX(o.acquired),MIN(o.id)" + where + " GROUP BY gx,gy ORDER BY gx,gy", params)
                    for gx, gy, size, power, first, latest, row_id in groups:
                        if size == 1:
                            features.append(point(db.execute("SELECT payload FROM global_observations WHERE id=?", (row_id,)).fetchone())); continue
                        group = encode_group(snapshot, window, level, gx, gy, filters)
                        longitude = (gx + .5) / n * 360 - 180
                        latitude = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (gy + .5) / n))))
                        west, east = gx / n * 360 - 180, (gx + 1) / n * 360 - 180
                        north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / n))))
                        south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (gy + 1) / n))))
                        features.append({"type": "Feature", "id": group, "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                                         "properties": {"id": group, "aggregateId": group, "kind": "aggregate", "count": size, "frpMw": power, "severity": severity(power), "snapshotId": snapshot,
                                                        "earliestAcquiredAt": utc(first), "acquiredAt": utc(latest), "hierarchyLevel": level, "bbox": [west, south, east, north], "colorMeaning": "maximum reported FRP (MW)"}})
            if len(features) > MAX_TILE_FEATURES:
                raise RuntimeError("Global hierarchy exceeded its fixed presentation bound.")
            body = json.dumps({"type": "FeatureCollection", "features": features, "snapshotId": snapshot, "interval": interval,
                               "count": count, "schema": SCHEMA, "tile": [z, x, y]}, separators=(",", ":"), allow_nan=False).encode()
            compressed = gzip.compress(body, compresslevel=5, mtime=0)
            result = (body, compressed, hashlib.sha256(body).hexdigest(), {"generationMs": (time.perf_counter() - started) * 1000, "bytes": len(body), "gzipBytes": len(compressed), "observations": count, "features": len(features)})
            with _CACHE_LOCK:
                _CACHE_STATS["generated"] += 1
                _CACHE[cache_key] = result
                while len(_CACHE) > 256 or sum(len(v[0]) + len(v[1]) for v in _CACHE.values()) > MAX_TILE_CACHE_BYTES:
                    _CACHE.popitem(last=False)
            return result

    def _selection(self, snapshot, window, aggregate, options, display_filters=None, interval=None):
        manifest, snapshot, source, selected, selected_params, display_filters, interval = self._base(snapshot, window, aggregate, display_filters, interval)
        extra, arguments = _filter_sql(options)
        clauses, params = [*selected, *extra], [*selected_params, *arguments]
        grouping, sort = options.get("groupBy", "none"), options.get("sort", "newest")
        if grouping not in ("none", "date", "hour", "satellite") or sort not in ("newest", "oldest", "frp"):
            raise RejectedQuery("Choose a supported grouping and sort.")
        group = {"none": "'all'", "date": "strftime('%Y-%m-%d',o.acquired,'unixepoch')", "hour": "strftime('%Y-%m-%dT%H',o.acquired,'unixepoch')", "satellite": "o.platform"}[grouping]
        order = {"newest": "o.acquired DESC,o.observation_id ASC", "oldest": "o.acquired ASC,o.observation_id ASC", "frp": "o.frp IS NULL,o.frp DESC,o.observation_id ASC"}[sort]
        if grouping != "none": order = group + (" ASC," if grouping == "satellite" or sort == "oldest" else " DESC,") + order
        return manifest, snapshot, source, selected, selected_params, clauses, params, interval, group, grouping, order

    def observations(self, snapshot, window, aggregate=None, options=None, display_filters=None, interval=None):
        options = options or {}
        if options.get('sourceGeneration') not in (None, snapshot):
            raise SnapshotUnavailable('The requested observation generation changed. Refresh the investigation explicitly.')
        manifest, snapshot, source, selected, selected_params, clauses, params, interval, group, grouping, order = self._selection(snapshot, window, aggregate, options, display_filters, interval)
        page, size = options.get("page", 1), options.get("pageSize", 10)
        if type(page) is not int or type(size) is not int or page < 1 or not 1 <= size <= 100:
            raise RejectedQuery("Pages start at 1 and support 1–100 observations.")
        where = " FROM " + source + " WHERE " + " AND ".join(clauses)
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                raise SnapshotUnavailable("The observation snapshot expired; refresh the investigation.")
            whole_count = db.execute("SELECT COUNT(*) FROM " + source + " WHERE p.snapshot=? AND o.acquired>=? AND o.acquired<?", selected_params[:3]).fetchone()[0]
            selected_count = db.execute("SELECT COUNT(*) FROM " + source + " WHERE " + " AND ".join(selected), selected_params).fetchone()[0]
            count, first, latest, power, platforms = db.execute("SELECT COUNT(*),MIN(o.acquired),MAX(o.acquired),MAX(CASE WHEN o.frp>=0 THEN o.frp END),GROUP_CONCAT(DISTINCT o.platform)" + where, params).fetchone()
            canonical = CanonicalStore((), (), "Published global FIRMS snapshot " + snapshot)
            rows = [canonical_record(unpack_detection(payload), canonical) | {"groupKey": key} for payload, key in db.execute("SELECT o.payload," + group + where + " ORDER BY " + order + " LIMIT ? OFFSET ?", [*params, size, (page - 1) * size])]
            groups = []
            if grouping != "none":
                for key, members, first_group, latest_group in db.execute("SELECT " + group + ",COUNT(*),MIN(o.acquired),MAX(o.acquired)" + where + " GROUP BY " + group + " ORDER BY " + group, params):
                    label = key + " UTC" if grouping == "date" else datetime.strptime(key, "%Y-%m-%dT%H").strftime("%d %b %Y, %H:00–%H:59 UTC") if grouping == "hour" else key
                    groups.append({"key": key, "label": label, "count": members, "earliestAcquisition": utc(first_group), "latestAcquisition": utc(latest_group)})
            statistics, facets = self._analytics(db, canonical, where, params)
            daily_coverage = self._daily_coverage(db, snapshot, interval, options, manifest)
        freshness = published_freshness(manifest)
        return {"data": {"rows": rows, "total": count, "page": page, "pageSize": size, "groups": groups,
                          "summary": {"wholeAreaCount": whole_count, "selectedCount": selected_count, "matchingCount": count,
                                      "earliestAcquisition": utc(first), "latestAcquisition": utc(latest), "maxFrpMw": power, "platforms": platforms.split(",") if platforms else [],
                                      "statistics": statistics, "facets": facets, "dailyCoverage": daily_coverage}},
                "meta": {"sourceGeneration": snapshot, "snapshotId": snapshot, "interval": interval, "completeness": manifest.get("completeness", "partial"),
                         **freshness, "sources": manifest.get("sources", []), "aggregateId": aggregate,
                         "coverage": manifest.get("coverage"), "availableInterval": manifest.get("availableInterval"),
                         "selectionScope": "frozen-global-hierarchy-cell" if aggregate else "global-snapshot", "metric": "satellite observation records"}}

    @staticmethod
    def _analytics(db, canonical, where, params):
        
        count = db.execute("SELECT COUNT(o.frp)" + where + " AND o.frp>=0", params).fetchone()[0]
        middle = [item[0] for item in db.execute("SELECT o.frp" + where + " AND o.frp>=0 ORDER BY o.frp LIMIT ? OFFSET ?", [*params, 2 if count % 2 == 0 else 1, max(0, (count - 1)//2)])] if count else []
        def record(order, condition=""):
            item = db.execute("SELECT o.payload" + where + condition + " ORDER BY " + order + " LIMIT 1", params).fetchone()
            return canonical_record(unpack_detection(item[0]), canonical) if item else None
        cell_lon, cell_lat = "(CAST((o.longitude+180)/2 AS INTEGER)*2-180)", "(CAST((o.latitude+90)/2 AS INTEGER)*2-90)"
        top = [{"label": f"{lon}–{lon+2}°, {lat}–{lat+2}°", "longitude": lon+1, "latitude": lat+1, "count": n} for lon, lat, n in db.execute("SELECT " + cell_lon + "," + cell_lat + ",COUNT(*)" + where + " GROUP BY " + cell_lon + "," + cell_lat + " ORDER BY COUNT(*) DESC," + cell_lon + "," + cell_lat + " LIMIT 10", params)]
        stats = {"medianFrp": sum(middle)/len(middle) if middle else None, "frpReported": count,
                 "latest": record("o.acquired DESC,o.observation_id ASC"), "highestFrp": record("o.frp DESC,o.observation_id ASC", " AND o.frp>=0"), "topCells": top}
        expressions = {
            "daily": "strftime('%Y-%m-%d',o.acquired,'unixepoch')",
            "platform": "o.platform", "hour": "strftime('%Y-%m-%dT%H',o.acquired,'unixepoch')",
            "dayNight": "CASE json_extract(o.payload,'$.day_night') WHEN 'D' THEN 'day' WHEN 'N' THEN 'night' ELSE 'unknown' END",
            "frp": "CASE WHEN o.frp IS NULL OR o.frp<0 THEN 'unknown' WHEN o.frp<10 THEN '0-10' WHEN o.frp<50 THEN '10-50' WHEN o.frp<100 THEN '50-100' ELSE '100+' END",
            "confidence": "CASE WHEN o.platform IN ('aqua','terra') THEN CASE WHEN json_extract(o.payload,'$.confidence_pct') IS NULL THEN 'MODIS:unknown' WHEN json_extract(o.payload,'$.confidence_pct')<30 THEN 'MODIS:0-29' WHEN json_extract(o.payload,'$.confidence_pct')<80 THEN 'MODIS:30-79' ELSE 'MODIS:80-100' END ELSE 'VIIRS:'||COALESCE(json_extract(o.payload,'$.confidence_class'),'unknown') END",
        }
        facets = {}
        for kind, expression in expressions.items():
            values = []
            for key, n in db.execute("SELECT " + expression + ",COUNT(*)" + where + " GROUP BY " + expression + " ORDER BY " + expression, params):
                label = key
                if kind == "daily": options = {"day": key}
                elif kind == "platform": options = {"platform": key}
                elif kind == "hour":
                    beginning = datetime.strptime(key, "%Y-%m-%dT%H").replace(tzinfo=UTC)
                    from datetime import timedelta
                    options = {"acquiredStart": utc(beginning.timestamp()), "acquiredEndExclusive": utc((beginning+timedelta(hours=1)).timestamp())}
                    label = beginning.strftime("%d %b %Y, %H:00–%H:59 UTC")
                elif kind == "dayNight": options = {"dayNight": key}
                elif kind == "frp":
                    options = {"frpUnknown": True} if key == "unknown" else {"frpMin": 100} if key == "100+" else {"frpMin": int(key.split('-')[0]), "frpMaxExclusive": int(key.split('-')[1])}
                    label = key + (" MW" if key != "unknown" else " FRP")
                else:
                    sensor, native = key.split(':')
                    options = {"viirsConfidence": [native]} if sensor == "VIIRS" else {"modisConfidenceUnknown": True} if native == "unknown" else {"modisConfidenceMin": int(native.split('-')[0]), "modisConfidenceMax": int(native.split('-')[1])}
                    label = key.replace(':', ' ')
                values.append({"key": key, "label": label, "count": n, "options": options})
            facets[kind] = values
        return stats, facets

    @staticmethod
    def _daily_coverage(db, snapshot, interval, options, manifest):
        from datetime import timedelta
        lower, upper = (datetime.fromisoformat(interval[name].replace('Z','+00:00')) for name in ('start','endExclusive'))
        sources = {state['source'] for state in manifest.get('sources', [])}
        mapping = {'terra': 'MODIS_NRT', 'aqua': 'MODIS_NRT', 'noaa-20': 'VIIRS_NOAA20_NRT', 'noaa-21': 'VIIRS_NOAA21_NRT', 'suomi-npp': 'VIIRS_SNPP_NRT'}
        if options.get('platform') in mapping: sources &= {mapping[options['platform']]}
        if options.get('sensor') == 'MODIS' or options.get('modisConfidenceMin') is not None or options.get('modisConfidenceUnknown'): sources &= {'MODIS_NRT'}
        if options.get('sensor') == 'VIIRS' or options.get('viirsConfidence'): sources -= {'MODIS_NRT'}
        partitions = [dict(p) for p in db.execute('SELECT p.* FROM global_partition_versions p JOIN global_snapshot_partitions s ON s.version=p.version WHERE s.snapshot=?', (snapshot,))]
        result = {}; day = lower.replace(hour=0,minute=0,second=0,microsecond=0)
        while day < upper:
            start, end = max(day, lower).timestamp(), min(day+timedelta(days=1),upper).timestamp()
            covered = [p for p in partitions if p['source'] in sources and p['day'] == day.date().isoformat()]
            complete = bool(sources) and all(any(p['source']==source and p['start']<=start and p['end']>=end and p['coverage']!='unknown' for p in covered) for source in sources)
            result[day.date().isoformat()] = 'complete' if complete else 'partial' if covered else 'unavailable'
            day += timedelta(days=1)
        return result

    def export(self, snapshot, window, aggregate=None, options=None, format_name="csv", display_filters=None, investigation=None, interval=None):
        if format_name not in ("csv", "geojson", "json"):
            raise RejectedQuery("Choose CSV, GeoJSON, or reproducibility JSON.")
        options = options or {}
        if options.get('sourceGeneration') not in (None, snapshot):
            raise SnapshotUnavailable('The requested observation generation changed. Refresh the investigation explicitly.')
        manifest, snapshot, source, _selected, _selected_params, clauses, params, interval, _group, _grouping, order = self._selection(snapshot, window, aggregate, options, display_filters, interval)
        where = " FROM " + source + " WHERE " + " AND ".join(clauses)
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                raise SnapshotUnavailable("The observation snapshot expired; refresh the investigation.")
            count, latest = db.execute("SELECT COUNT(*),MAX(o.acquired)" + where, params).fetchone()
        metadata = {"schemaVersion": SCHEMA, "snapshotId": snapshot, "window": window, "interval": interval, "aggregateId": aggregate,
                    "observationFilters": options, "matchingCount": count, "sources": manifest.get("sources", []), "retrievedAt": manifest.get("retrievedAt"),
                    "completeness": manifest.get("completeness"), "partitionGenerations": manifest.get("partitions", []),
                    "coverage": manifest.get("coverage"), "availableInterval": manifest.get("availableInterval"),
                    "latestAcquisition": utc(latest), "datasetLatestAcquisition": manifest.get("latestAcquisition"), "publishedAt": manifest.get("publishedAt"),
                    "metric": "satellite observations, not fire incidents", "canonicalCoordinates": True}
        metadata.update(published_freshness(manifest))
        if isinstance(investigation, dict):
            selection = investigation.get('selection')
            metadata['investigation'] = {**investigation, 'selection': {key: value for key, value in selection.items() if key != 'observationIds'} if isinstance(selection, dict) else selection}
        canonical = CanonicalStore((), (), "Published global FIRMS snapshot " + snapshot)
        def stream():
            fields = ["id", "acquiredAt", "sensor", "platform", "longitude", "latitude", "dayNight", "frpMw", "confidenceKind", "confidenceValue", "confidenceNativeValue", "confidenceUnit", "scanKm", "trackKm", "nominalResolutionM", "sourceProduct", "productVersion", "processingTier", "snapshotId", "retrievedAt", "window", "startUtc", "endUtcExclusive", "aggregateId", "matchingCount", "observationFiltersJson", "completeness"]
            buffer = io.StringIO(newline=""); writer = csv.DictWriter(buffer, fields, extrasaction="ignore")
            if format_name == "csv":
                writer.writeheader(); yield buffer.getvalue()
            else: yield '{"type":"FeatureCollection","features":[' if format_name == "geojson" else '{"observations":['
            with closing(self.store.connect()) as db:
                db.execute("BEGIN")
                if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                    raise SnapshotUnavailable("The observation snapshot expired before export; refresh the investigation.")
                for index, (payload,) in enumerate(db.execute("SELECT o.payload" + where + " ORDER BY " + order, params)):
                    record = canonical_record(unpack_detection(payload), canonical)
                    if format_name == "csv":
                        record.update(confidenceKind=record["confidence"]["kind"], confidenceValue=record["confidence"]["value"], confidenceNativeValue=record["confidence"].get("nativeValue"), confidenceUnit=record["confidence"].get("unit"), snapshotId=snapshot, retrievedAt=manifest.get("retrievedAt"),
                                      window=window, startUtc=interval["start"], endUtcExclusive=interval["endExclusive"], aggregateId=aggregate, matchingCount=count,
                                      observationFiltersJson=json.dumps(options, separators=(",", ":")), completeness=manifest.get("completeness"))
                        for key, value in record.items():
                            if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")): record[key] = "'" + value
                        buffer.seek(0); buffer.truncate(); writer.writerow(record); yield buffer.getvalue()
                    else:
                        if index: yield ","
                        if format_name == "geojson": record = {"type": "Feature", "id": record["id"], "geometry": {"type": "Point", "coordinates": [record["longitude"], record["latitude"]]}, "properties": record}
                        yield json.dumps(record, separators=(",", ":"), allow_nan=False)
            if format_name != "csv": yield '],"reproducibility":' + json.dumps(metadata, separators=(",", ":"), allow_nan=False) + "}"
        return stream(), count
