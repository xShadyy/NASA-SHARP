"""Complete canonical observation queries, bounded frozen membership and exports.

Observation options are deliberately separate from the harmonized query filters.
Tokens retain canonical membership, never a temporary map cluster identifier.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import secrets
import threading
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi.responses import StreamingResponse

from harmonize import (
    CanonicalStore, Detection, RejectedQuery, DATASET_VERSION, METHOD_VERSION,
    COMPANION_NOTE, _focused_day, _meta, _options, _page,
    detection_id, evaluate_query, kept_detections, observation_record,
    observation_coverage_states, _overall,
)

MAX_SELECTION_IDS = 100_000
MAX_SELECTION_BATCH = 2_000
MAX_SELECTIONS = 16
MAX_RETAINED_MEMBERS = 200_000
SELECTION_TTL = 1800
_lock = threading.RLock()
_generations: OrderedDict = OrderedDict()
_selections: OrderedDict = OrderedDict()
_snapshots: OrderedDict = OrderedDict()


class SelectionInvalid(RejectedQuery):
    """A frozen investigation needs an explicit refresh from the map."""


def scope_key(query: dict) -> str:
    return hashlib.sha256(json.dumps({key: query.get(key) for key in
        ("aoi", "interval", "filters", "processingMode")}, sort_keys=True,
        separators=(",", ":")).encode()).hexdigest()


def source_generation(store: CanonicalStore) -> str:
    """Changes include canonical metadata and coverage, but not cache-read time."""
    key = (id(store.rows), id(store.coverage), store.source)
    with _lock:
        remembered = _generations.get(key)
        if remembered is not None:
            _generations.move_to_end(key)
            return remembered[0]
    digest = hashlib.sha256(store.source.encode())
    for row in store.rows:
        digest.update(repr(row).encode())
    for record in store.coverage:
        digest.update(repr(record).encode())
    generation = digest.hexdigest()
    with _lock:
        # Retaining tuples prevents Python object ID reuse.
        _generations[key] = (generation, store.rows, store.coverage)
        while len(_generations) > 4:
            _generations.popitem(last=False)
    return generation


def remember_snapshot(query: dict, store: CanonicalStore) -> None:
    """Map/summary work makes its existing source available without acquisition."""
    generation = source_generation(store)
    with _lock:
        key = scope_key(query)
        _snapshots[key] = (generation, store, time.monotonic())
        _snapshots.move_to_end(key)
        while len(_snapshots) > 4 or sum(len(item[1].rows) for item in _snapshots.values()) > 200_000:
            _snapshots.popitem(last=False)


def has_snapshot(query: dict) -> bool:
    with _lock:
        return scope_key(query) in _snapshots


def cached_snapshot(query: dict, options: dict) -> CanonicalStore:
    """Never acquire FIRMS observations from a popup or frozen investigation."""
    with _lock:
        snapshot = _snapshots.get(scope_key(query))
        token = options.get("selectionToken")
        selection = _selection(query, token) if token else None
        if selection is not None:
            if snapshot is not None and snapshot[0] != selection.generation:
                raise SelectionInvalid("The observation source changed. Refresh the selected group from the map.")
            return selection.store
        if snapshot is None or time.monotonic() - snapshot[2] > SELECTION_TTL:
            raise SelectionInvalid("The map observation source is no longer cached. Refresh the map before selecting this group.")
        expected = options.get("sourceGeneration")
        if expected is not None and expected != snapshot[0]:
            raise SelectionInvalid("The observation source changed. Refresh the selected group from the map.")
        return snapshot[1]


@dataclass
class FrozenSelection:
    scope: str
    generation: str
    ids: frozenset[str]
    store: CanonicalStore
    created: float


def _selection(query: dict, token: str) -> FrozenSelection:
    if not isinstance(token, str) or not token or len(token) > 128:
        raise SelectionInvalid("The selected group token is invalid. Select the group again on the map.")
    with _lock:
        selection = _selections.get(token)
        if selection is None or time.monotonic() - selection.created > SELECTION_TTL:
            _selections.pop(token, None)
            raise SelectionInvalid("The selected group expired. Select it again on the map.")
        if selection.scope != scope_key(query):
            raise SelectionInvalid("This selected group belongs to a different region or interval. Return to the whole area or select the group again.")
        _selections.move_to_end(token)
        return selection


def freeze_document(query: dict, store: CanonicalStore, body: dict) -> dict:
    options = _options(body)
    ids = options.get("observationIds")
    if not isinstance(ids, list) or not ids or len(ids) > MAX_SELECTION_BATCH or any(not isinstance(value, str) or len(value) > 128 for value in ids):
        raise RejectedQuery(f"Send 1–{MAX_SELECTION_BATCH:,} canonical observation IDs per membership batch.")
    result, filters, start, end, updated = evaluate_query(query, store)
    available = {detection_id(row) for row in kept_detections(query, store, filters, start, end)}
    if not set(ids) <= available:
        raise SelectionInvalid("Some selected observations are absent from this source. Refresh the selected group.")
    generation = source_generation(store)
    if options.get("sourceGeneration") not in (None, generation):
        raise SelectionInvalid("The observation source changed. Refresh the selected group from the map.")
    token = options.get("selectionToken") or secrets.token_urlsafe(24)
    with _lock:
        old = _selection(query, token) if options.get("selectionToken") else None
        if old is not None and old.generation != generation:
            raise SelectionInvalid("The observation source changed. Refresh the selected group from the map.")
        members = frozenset(ids) | (old.ids if old else frozenset())
        if len(members) > MAX_SELECTION_IDS:
            raise RejectedQuery(f"Frozen groups support at most {MAX_SELECTION_IDS:,} observations; no records were truncated.")
        _selections[token] = FrozenSelection(scope_key(query), generation, members, store, time.monotonic())
        _selections.move_to_end(token)
        while (len(_selections) > MAX_SELECTIONS
            or sum(len(item.ids) for item in _selections.values()) > MAX_RETAINED_MEMBERS
            or sum(len(item.rows) for item in {id(value.store): value.store for value in _selections.values()}.values()) > MAX_RETAINED_MEMBERS):
            _selections.popitem(last=False)
    return {"data": {"selectionToken": token, "total": len(members), "sourceGeneration": generation},
        "meta": _meta(query["id"], result, updated, {"time": "UTC"})}


def _number(options: dict, name: str) -> float | None:
    value = options.get(name)
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise RejectedQuery(f"{name} requires a finite non-negative native value.")
    return float(value)


def _instant(options: dict, name: str) -> datetime | None:
    value = options.get(name)
    if value in (None, ""):
        return None
    try:
        instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if instant.tzinfo is None or instant.utcoffset().total_seconds() != 0:
            raise ValueError()
        return instant
    except ValueError as exc:
        raise RejectedQuery(f"{name} requires a UTC timestamp.") from exc


def _matching(rows: list[Detection], store: CanonicalStore, options: dict) -> list[Detection]:
    search = options.get("search", "")
    if not isinstance(search, str) or len(search) > 256:
        raise RejectedQuery("Search must be text with at most 256 characters.")
    search = search.casefold().strip().replace("-", " ")
    frp_min, frp_max = _number(options, "frpMin"), _number(options, "frpMax")
    frp_end = _number(options, "frpMaxExclusive")
    confidence_min, confidence_max = _number(options, "modisConfidenceMin"), _number(options, "modisConfidenceMax")
    for lower, upper in ((frp_min, frp_max), (confidence_min, confidence_max)):
        if lower is not None and upper is not None and lower > upper:
            raise RejectedQuery("A filter minimum cannot exceed its maximum.")
    if any(value is not None and value > 100 for value in (confidence_min, confidence_max)):
        raise RejectedQuery("MODIS confidence uses its native 0–100 scale.")
    lower, upper = _instant(options, "acquiredStart"), _instant(options, "acquiredEndExclusive")
    if lower is not None and upper is not None and lower >= upper:
        raise RejectedQuery("Acquisition start must be before its exclusive end.")
    viirs = options.get("viirsConfidence")
    if viirs is not None and (not isinstance(viirs, list) or any(not isinstance(value, str) or value not in {"low", "nominal", "high", "unknown"} for value in viirs)):
        raise RejectedQuery("Select native VIIRS confidence categories.")
    for name in ("dayNight", "sensor", "platform", "source", "observationId", "sort", "groupBy"):
        if options.get(name) is not None and not isinstance(options[name], str):
            raise RejectedQuery(f"{name} requires a text value.")
    day_night = options.get("dayNight")
    if day_night not in {None, "", "all", "day", "night", "unknown"}:
        raise RejectedQuery("Select day, night, or unknown metadata.")
    sensor = options.get("sensor")
    if sensor not in {None, "", "all", "MODIS", "VIIRS"}:
        raise RejectedQuery("Select MODIS or VIIRS.")
    matched = []
    for row in rows:
        if options.get("observationId") and options["observationId"] != detection_id(row):
            continue
        modis = row.platform in {"terra", "aqua"}
        if options.get("platform") not in (None, "", "all", row.platform):
            continue
        if sensor not in (None, "", "all", "MODIS" if modis else "VIIRS"):
            continue
        if options.get("source") not in (None, "", "all", row.source_product, store.source):
            continue
        if day_night not in (None, "", "all", "day" if row.day_night == "D" else "night" if row.day_night == "N" else "unknown"):
            continue
        if lower is not None and row.acquired_at < lower or upper is not None and row.acquired_at >= upper:
            continue
        if options.get("frpUnknown") and row.frp_mw is not None:
            continue
        if frp_min is not None and (row.frp_mw is None or row.frp_mw < frp_min):
            continue
        if frp_max is not None and (row.frp_mw is None or row.frp_mw > frp_max):
            continue
        if frp_end is not None and (row.frp_mw is None or row.frp_mw >= frp_end):
            continue
        # Selecting a native confidence condition selects that sensor explicitly.
        if confidence_min is not None or confidence_max is not None or options.get("modisConfidenceUnknown"):
            if not modis:
                continue
            if options.get("modisConfidenceUnknown") and row.confidence_pct is not None:
                continue
            if confidence_min is not None and (row.confidence_pct is None or row.confidence_pct < confidence_min):
                continue
            if confidence_max is not None and (row.confidence_pct is None or row.confidence_pct > confidence_max):
                continue
        if viirs is not None and (modis or (row.confidence_class or "unknown") not in viirs):
            continue
        if search and not any(search in value.casefold().replace("-", " ") for value in
            (detection_id(row), row.platform, "MODIS" if modis else "VIIRS", row.source_product or store.source)):
            continue
        matched.append(row)
    return matched


def _facets(rows: list[Detection]) -> dict:
    counts: dict[str, dict] = {name: {} for name in ("daily", "platform", "frp", "confidence", "hour", "dayNight")}
    def add(name, key, label, options):
        bucket = counts[name].setdefault(key, {"key": key, "label": label, "count": 0, "options": options})
        bucket["count"] += 1
    for row in rows:
        acquired = row.acquired_at.astimezone(UTC)
        day = acquired.date().isoformat()
        add("daily", day, day + " UTC", {"day": day})
        add("platform", row.platform, row.platform, {"platform": row.platform})
        hour = acquired.replace(minute=0, second=0, microsecond=0)
        hour_key, hour_label = _group(row, "hour")
        add("hour", hour_key, hour_label, {"acquiredStart": hour.isoformat().replace("+00:00", "Z"), "acquiredEndExclusive": (hour + timedelta(hours=1)).isoformat().replace("+00:00", "Z")})
        daylight = "day" if row.day_night == "D" else "night" if row.day_night == "N" else "unknown"
        add("dayNight", daylight, daylight.title(), {"dayNight": daylight})
        if row.frp_mw is None:
            add("frp", "unknown", "Unknown FRP", {"frpUnknown": True})
        else:
            if row.frp_mw < 10:
                key, label, options = "0-10", "0–<10 MW", {"frpMin": 0, "frpMaxExclusive": 10}
            elif row.frp_mw < 50:
                key, label, options = "10-50", "10–<50 MW", {"frpMin": 10, "frpMaxExclusive": 50}
            elif row.frp_mw < 100:
                key, label, options = "50-100", "50–<100 MW", {"frpMin": 50, "frpMaxExclusive": 100}
            else:
                key, label, options = "100+", "≥100 MW", {"frpMin": 100}
            add("frp", key, label, options)
        if row.platform in {"terra", "aqua"}:
            if row.confidence_pct is None:
                add("confidence", "modis-unknown", "MODIS unknown", {"modisConfidenceUnknown": True})
            else:
                lower, upper = (0, 29) if row.confidence_pct < 30 else (30, 79) if row.confidence_pct < 80 else (80, 100)
                add("confidence", f"modis-{lower}-{upper}", f"MODIS {lower}–{upper}", {"modisConfidenceMin": lower, "modisConfidenceMax": upper})
        else:
            native = row.confidence_class or "unknown"
            add("confidence", "viirs-" + native, "VIIRS " + native, {"viirsConfidence": [native]})
    return {name: list(buckets.values()) for name, buckets in counts.items()}


def _group(row: Detection, grouping: str) -> tuple[str, str]:
    acquired = row.acquired_at.astimezone(UTC)
    if grouping == "date":
        key = acquired.date().isoformat()
        return key, f"{key} UTC"
    if grouping == "hour":
        key = acquired.strftime("%Y-%m-%dT%H")
        return key, acquired.strftime("%d %b %Y, %H:00–%H:59 UTC")
    if grouping == "satellite":
        return row.platform, row.platform
    return "all", "All observations"


def query_rows(query: dict, store: CanonicalStore, body: dict | None = None):
    result, filters, start, end, updated = evaluate_query(query, store)
    options = _options(body)
    focused = _focused_day(options, start, end)
    rows = kept_detections(query, store, filters, start, end)
    whole_count = len(rows)
    token = options.get("selectionToken")
    if token:
        selected = _selection(query, token)
        if selected.generation != source_generation(store):
            raise SelectionInvalid("The observation source changed. Refresh the selected group from the map.")
        rows = [row for row in rows if detection_id(row) in selected.ids]
    selected_count = len(rows)
    if focused is not None:
        rows = [row for row in rows if row.acquired_at.astimezone(UTC).date() == focused]
    rows = _matching(rows, store, options)
    sort = options.get("sort", "newest")
    grouping = options.get("groupBy", "none")
    if sort not in {"newest", "oldest", "frp"} or grouping not in {"none", "date", "hour", "satellite"}:
        raise RejectedQuery("Choose a supported global sort and grouping.")
    def sort_key(row):
        if sort == "frp":
            return (row.frp_mw is None, -(row.frp_mw or 0), detection_id(row))
        return ((-1 if sort == "newest" else 1) * row.acquired_at.timestamp(), detection_id(row))
    rows.sort(key=sort_key)
    if grouping != "none":
        # Group the full result before taking a page. Each group keeps global sort.
        rows.sort(key=lambda row: _group(row, grouping)[0], reverse=grouping != "satellite" and sort != "oldest")
    groups = defaultdict(list)
    if grouping != "none":
        for row in rows:
            groups[_group(row, grouping)].append(row)
    group_summary = [{"key": key, "label": label, "count": len(members),
        "earliestAcquisition": min(row.acquired_at for row in members).isoformat().replace("+00:00", "Z"),
        "latestAcquisition": max(row.acquired_at for row in members).isoformat().replace("+00:00", "Z")}
        for (key, label), members in groups.items()]
    times = [row.acquired_at for row in rows]
    powers = [row.frp_mw for row in rows if row.frp_mw is not None]
    summary = {"wholeAreaCount": whole_count, "selectedCount": selected_count, "matchingCount": len(rows),
        "earliestAcquisition": min(times).isoformat().replace("+00:00", "Z") if times else None,
        "latestAcquisition": max(times).isoformat().replace("+00:00", "Z") if times else None,
        "platforms": sorted({row.platform for row in rows}), "maxFrpMw": max(powers) if powers else None,
        "facets": _facets(rows)}
    reporting = observation_coverage_states(store, filters, start, end)
    meta = {**_meta(query["id"], result, updated, {"count": "satellite observations", "frp": "MW", "time": "UTC"},
        completeness=reporting.get(focused, "unavailable") if focused else _overall(list(reporting.values())), extra_notes=(COMPANION_NOTE,)),
        "sourceGeneration": source_generation(store), "source": store.source,
        "fetchedAt": datetime.fromtimestamp(store.fetched_at, UTC).isoformat().replace("+00:00", "Z") if store.fetched_at else None,
        "selectionToken": token, "selectionExpiresInSeconds": SELECTION_TTL if token else None,
        "generatedAt": updated, "newestObservationAt": summary["latestAcquisition"],
        "expiresAt": datetime.fromtimestamp(store.expires_at, UTC).isoformat().replace("+00:00", "Z") if store.expires_at else None,
        "freshness": "archived" if store.source.startswith("Regional archive ") else "unknown" if store.fetched_at is None else "fresh" if store.expires_at is not None and store.expires_at > time.time() else "stale"}
    if store.source.startswith("Regional archive "):
        meta["datasetVersion"] = store.source.removeprefix("Regional archive ")
    return rows, summary, group_summary, meta


def observations_document(query: dict, store: CanonicalStore, body: dict | None = None) -> dict:
    options = _options(body)
    page, page_size = _page({"pageSize": 25, **options})
    rows, summary, groups, meta = query_rows(query, store, body)
    offset = (page - 1) * page_size
    grouping = options.get("groupBy", "none")
    return {"data": {"rows": [{**observation_record(row, store),
        "groupKey": _group(row, grouping)[0]} for row in rows[offset:offset + page_size]],
        "total": len(rows), "page": page, "pageSize": page_size, "summary": summary, "groups": groups}, "meta": meta}


def export_document(query: dict, store: CanonicalStore, body: dict) -> StreamingResponse:
    rows, summary, _groups, meta = query_rows(query, store, body)
    format_name = body.get("format", "json")
    if format_name not in {"csv", "geojson", "json"}:
        raise RejectedQuery("Choose CSV, GeoJSON, or reproducibility JSON.")
    reproducibility = {"schemaVersion": "sharp-investigation-1", "query": query,
        "observationOptions": _options(body), "matchingCount": len(rows), "summary": summary,
        "meta": meta, "datasetVersion": meta["datasetVersion"], "methodVersion": METHOD_VERSION,
        "sources": sorted({row.source_product or store.source for row in rows}),
        "processingVersions": sorted({row.product_version for row in rows if row.product_version}),
        "processingTiers": sorted({row.processing_tier for row in rows if row.processing_tier})}
    investigation = body.get("investigation")
    if isinstance(investigation, dict):
        area = investigation.get("area")
        reproducibility["area"] = {"id": area.get("id"), "name": area.get("name"), "geometry": query["aoi"]["geometry"]} if isinstance(area, dict) else {"geometry": query["aoi"]["geometry"]}
        reproducibility["metric"] = "harmonizedActiveCells"
        reproducibility["selectionScope"] = "frozen-observation-group" if _options(body).get("selectionToken") else "whole-area"
    def stream():
        if format_name == "csv":
            fields = ["id", "acquiredAt", "sensor", "platform", "longitude", "latitude", "dayNight", "confidenceKind", "confidenceValue", "confidenceUnit", "frpMw", "scanKm", "trackKm", "nominalResolutionM", "sourceProduct", "provenance", "productVersion", "processingTier", "queryId", "sourceGeneration", "areaId", "areaName", "queryStartUtc", "queryEndExclusiveUtc", "methodVersion", "selectionToken", "observationFiltersJson", "completeness", "fetchedAt"]
            buffer = io.StringIO(newline="")
            writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            yield buffer.getvalue()
            for row in rows:
                record = observation_record(row, store)
                confidence = record["confidence"]
                record.update(confidenceKind=confidence["kind"], confidenceValue=confidence["value"], confidenceUnit=confidence.get("unit"), queryId=query["id"], sourceGeneration=meta["sourceGeneration"])
                record.update(areaId=reproducibility.get("area", {}).get("id"), areaName=reproducibility.get("area", {}).get("name"), queryStartUtc=query["interval"]["start"], queryEndExclusiveUtc=query["interval"]["endExclusive"], methodVersion=METHOD_VERSION, selectionToken=_options(body).get("selectionToken"), observationFiltersJson=json.dumps(_options(body), separators=(",", ":")), completeness=meta.get("completeness"), fetchedAt=meta.get("fetchedAt"))
                # Prevent a source/product string from becoming a spreadsheet formula.
                for key, value in record.items():
                    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
                        record[key] = "'" + value
                buffer.seek(0)
                buffer.truncate()
                writer.writerow(record)
                yield buffer.getvalue()
            return
        if format_name == "geojson":
            yield '{"type":"FeatureCollection","features":['
        else:
            yield '{"observations":['
        for index, row in enumerate(rows):
            record = observation_record(row, store)
            if index:
                yield ","
            if format_name == "geojson":
                record = {"type": "Feature", "id": record["id"], "geometry": {"type": "Point", "coordinates": [row.longitude, row.latitude]}, "properties": record}
            yield json.dumps(record, separators=(",", ":"), allow_nan=False)
        yield '],"reproducibility":' + json.dumps(reproducibility, separators=(",", ":"), allow_nan=False) + "}"
    media = {"csv": "text/csv", "geojson": "application/geo+json", "json": "application/json"}[format_name]
    return StreamingResponse(stream(), media_type=media, headers={
        "Content-Disposition": f'attachment; filename="sharp-observations.{format_name}"',
        "X-Observation-Count": str(len(rows)), "X-Source-Generation": meta["sourceGeneration"],
    })
