
from __future__ import annotations

import hashlib
import json
import math
import os
from collections import OrderedDict, defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from harmonize import EARTH_RADIUS_M, METHOD_VERSION, geometry_bbox, prepared_area, geometry_supports_area
from historical_activity import cell_polygon, day_range, load_archive, supports_geometry

TARGET = "Probability of at least one reported satellite hotspot detection in a grid cell during the next 24 hours"
GRID_M = 10000
SUPPORT_POLICY = "whole-10km-cells-contained-in-registered-domain-v1"
FEATURES = ["intercept", "activity_48h_ago", "prior_7_available_days_rate", "supported_neighbor_activity_48h_ago", "season_sine", "season_cosine", "supported_neighbor_fraction"]
PROMOTION = {"minimumTestExamples": 500, "minimumTestPositives": 20, "minimumTestNegatives": 100,
             "minimumBrierSkill": .02, "minimumPrAucPrevalenceRatio": 1.2, "maximumCalibrationError": .05}
_SERVING_CACHE = OrderedDict()


def grid_key(lon, lat):
    return (math.floor(EARTH_RADIUS_M * math.radians(lon) / GRID_M),
            math.floor(EARTH_RADIUS_M * math.sin(math.radians(lat)) / GRID_M))


def domain_cells(geometry):
    bounds = geometry_bbox(geometry)
    left, bottom = grid_key(bounds[0], bounds[1])
    right, top = grid_key(bounds[2], bounds[3])
    if (right - left + 1) * (top - bottom + 1) > 5000:
        raise ValueError("Outlook training domain exceeds 5,000 candidate 10 km cells. Import a smaller regional dataset.")
    area = prepared_area(geometry)
    cells = []
    for x in range(left, right + 1):
        for y in range(bottom, top + 1):
            lon = math.degrees((x + .5) * GRID_M / EARTH_RADIUS_M)
            lat = math.degrees(math.asin(max(-1, min(1, (y + .5) * GRID_M / EARTH_RADIUS_M))))
            if area.contains(lon, lat) and geometry_supports_area(geometry, cell_polygon((x, y), GRID_M)):
                cells.append((x, y))
    return cells


def reporting_data(manifest, store):
    platforms = set(manifest.get("forecastPlatforms", []))
    if not platforms:
        raise ValueError("Set forecastPlatforms in the regional manifest to define a stable reporting configuration.")
    states = {(r.day, r.platform): r.state for r in store.coverage}
    days = sorted({r.day for r in store.coverage})
    complete = {day for day in days if all(states.get((day, p)) == "complete" for p in platforms)}
    activity = defaultdict(set)
    for row in store.rows:
        if row.platform in platforms:
            activity[row.acquired_at.date()].add(grid_key(row.longitude, row.latitude))
    return complete, activity


def feature_values(day, cell, complete, activity, supported_cells=None):
    
    
    latest = day - timedelta(days=2)
    window = [latest - timedelta(days=i) for i in range(7)]
    if any(d not in complete for d in window):
        return None
    x, y = cell
    neighbors = [(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
    if supported_cells is not None:
        neighbors = [c for c in neighbors if c in supported_cells]
    phase = 2 * math.pi * ((day - date(day.year, 1, 1)).days / 365.2425)
    return [1., float(cell in activity[latest]), sum(cell in activity[d] for d in window) / 7,
            sum(c in activity[latest] for c in neighbors) / len(neighbors) if neighbors else 0.,
            math.sin(phase), math.cos(phase), len(neighbors) / 8]


def sigmoid(value):
    return 1 / (1 + math.exp(-max(-30, min(30, value))))


def dot(weights, features):
    return sum(a * b for a, b in zip(weights, features))


def fit_logistic(samples, iterations=150, regularization=.01):
    if not samples:
        raise ValueError("The chronological training partition has no usable examples.")
    prevalence = sum(label for _day, _cell, _x, label in samples) / len(samples)
    if prevalence in (0, 1):
        raise ValueError("Training requires both reported-detection and no-report labels.")
    weights = [math.log(prevalence / (1 - prevalence)), *([0.] * (len(FEATURES) - 1))]
    for _ in range(iterations):
        gradient = [0.] * len(weights)
        for _day, _cell, features, label in samples:
            error = sigmoid(dot(weights, features)) - label
            for i, value in enumerate(features):
                gradient[i] += error * value
        for i in range(len(weights)):
            weights[i] -= .5 * (gradient[i] / len(samples) + (regularization * weights[i] if i else 0))
    return weights


def fit_calibration(scores, labels):
    
    intercept, slope = 0., 1.
    for _ in range(200):
        di = ds = 0.
        for score, label in zip(scores, labels):
            logit = math.log(max(1e-8, score) / max(1e-8, 1 - score))
            error = sigmoid(intercept + slope * logit) - label
            di += error
            ds += error * logit
        intercept -= .1 * di / len(labels)
        slope -= .1 * ds / len(labels)
    return [intercept, max(0., slope)]


def calibrated(score, calibration):
    return sigmoid(calibration[0] + calibration[1] * math.log(max(1e-8, score) / max(1e-8, 1 - score)))


def metrics(labels, scores, issue_dates=None):
    n = len(labels)
    if not n:
        return {"examples": 0, "positives": 0, "negatives": 0, "prevalence": None, "prAuc": None, "brier": None, "calibrationError": None, "reliability": [], "highestRankedArea": None}
    positives = sum(labels)
    ranked = [(score, label) for _index, score, label in sorted(
        ((i, score, label) for i, (score, label) in enumerate(zip(scores, labels))),
        key=lambda item: (-item[1], item[0]))]
    
    seen = true = 0
    ap = 0.
    cursor = 0
    while cursor < n:
        stop = cursor + 1
        while stop < n and ranked[stop][0] == ranked[cursor][0]:
            stop += 1
        batch_positive = sum(label for _score, label in ranked[cursor:stop])
        seen += stop - cursor
        true += batch_positive
        ap += (batch_positive / positives) * (true / seen) if positives else 0
        cursor = stop
    bins = []
    error = 0.
    for i in range(10):
        pairs = [(s, y) for s, y in zip(scores, labels) if min(9, int(s * 10)) == i]
        if not pairs:
            continue
        predicted = sum(s for s, _y in pairs) / len(pairs)
        observed = sum(y for _s, y in pairs) / len(pairs)
        error += len(pairs) / n * abs(predicted - observed)
        bins.append({"lower": i / 10, "upper": (i + 1) / 10, "count": len(pairs), "predicted": predicted, "observed": observed})
    if issue_dates is not None:
        
        
        by_issue = defaultdict(list)
        for index, (issue, score, label) in enumerate(zip(issue_dates, scores, labels)):
            by_issue[issue].append((index, score, label))
        top = [(score, label) for pairs in by_issue.values()
               for _index, score, label in sorted(pairs, key=lambda item: (-item[1], item[0]))[:max(1, math.ceil(len(pairs) * .05))]]
        ranking_scope = "Top area selected independently at each UTC issue"
        issue_count = len(by_issue)
    else:
        top = ranked[:max(1, math.ceil(n * .05))]
        ranking_scope = "Pooled examples (diagnostic only)"
        issue_count = 1
    return {"examples": n, "positives": positives, "negatives": n - positives, "prevalence": positives / n,
            "prAuc": ap if positives else None, "brier": sum((s - y) ** 2 for s, y in zip(scores, labels)) / n,
            "calibrationError": error, "reliability": bins,
            "highestRankedArea": {"requestedFraction": .05, "actualSelectedFraction": len(top) / n,
                                  "scope": ranking_scope, "meanSelectedAreaKm2": len(top) / issue_count * (GRID_M / 1000) ** 2,
                                  "examples": len(top), "precision": sum(y for _s, y in top) / len(top),
                                  "positiveRecall": sum(y for _s, y in top) / positives if positives else None}}


def baseline_tables(samples):
    seasonal = defaultdict(lambda: [0, 0])
    persistence = defaultdict(lambda: [0, 0])
    total = sum(y for _d, _c, _x, y in samples) / len(samples)
    for day, cell, features, label in samples:
        seasonal[(cell, day.month)][0] += label
        seasonal[(cell, day.month)][1] += 1
        persistence[int(features[1])][0] += label
        persistence[int(features[1])][1] += 1
    smooth = lambda value: (value[0] + 10 * total) / (value[1] + 10)
    return {"seasonal": {f"{c[0]}:{c[1]}:{m}": smooth(v) for (c, m), v in seasonal.items()},
            "persistence": {str(k): smooth(v) for k, v in persistence.items()}, "prevalence": total}


def baseline_scores(table, samples, kind):
    if kind == "seasonal":
        return [table["seasonal"].get(f"{c[0]}:{c[1]}:{d.month}", table["prevalence"]) for d, c, _x, _y in samples]
    return [table["persistence"].get(str(int(x[1])), table["prevalence"]) for _d, _c, x, _y in samples]


def train_archive(archive, output: Path, iterations=150):
    manifest, store = archive
    complete, activity = reporting_data(manifest, store)
    cells = domain_cells(manifest["geometry"])
    supported_cells = frozenset(cells)
    days = sorted(day for day in complete if day < datetime.now(UTC).date())
    if len(days) < 120 or not cells:
        raise ValueError("Offline training requires at least 120 complete regional reporting days and a nonempty grid.")
    if len(days) * len(cells) > 300000:
        raise ValueError("Training exceeds 300,000 cell/day examples. Configure a smaller regional dataset.")
    train_end, calibration_end = days[int(len(days) * .6)], days[int(len(days) * .8)]
    partitions = {"train": [], "calibration": [], "test": []}
    for day in days:
        
        part = "train" if day < train_end else "calibration" if train_end + timedelta(days=2) <= day < calibration_end else "test" if day >= calibration_end + timedelta(days=2) else None
        if part is None:
            continue
        for cell in cells:
            features = feature_values(day, cell, complete, activity, supported_cells)
            if features is not None:
                partitions[part].append((day, cell, features, int(cell in activity[day])))
    train, calibration, test = (partitions[p] for p in ("train", "calibration", "test"))
    if not calibration or not test or len({y for _d, _c, _x, y in calibration}) < 2:
        raise ValueError("Calibration and test need usable reporting windows; calibration requires both labels.")
    weights = fit_logistic(train, iterations)
    platt = fit_calibration([sigmoid(dot(weights, x)) for _d, _c, x, _y in calibration], [y for _d, _c, _x, y in calibration])
    tables = baseline_tables(train)
    
    cal_labels = [y for _d, _c, _x, y in calibration]
    baseline = min(("seasonal", "persistence"), key=lambda kind: metrics(cal_labels, baseline_scores(tables, calibration, kind))["brier"])
    labels = [y for _d, _c, _x, y in test]
    issue_dates = [d for d, _c, _x, _y in test]
    evaluated = metrics(labels, [calibrated(sigmoid(dot(weights, x)), platt) for _d, _c, x, _y in test], issue_dates)
    baselines = {kind: metrics(labels, baseline_scores(tables, test, kind), issue_dates) for kind in ("seasonal", "persistence")}
    baseline_brier = baselines[baseline]["brier"]
    skill = 1 - evaluated["brier"] / baseline_brier if baseline_brier else None
    criteria = {"testExamples": evaluated["examples"] >= PROMOTION["minimumTestExamples"],
                "testPositives": evaluated["positives"] >= PROMOTION["minimumTestPositives"],
                "testNegatives": evaluated["negatives"] >= PROMOTION["minimumTestNegatives"],
                "brierSkill": skill is not None and skill >= PROMOTION["minimumBrierSkill"],
                "prAuc": evaluated["prAuc"] is not None and evaluated["prAuc"] >= evaluated["prevalence"] * PROMOTION["minimumPrAucPrevalenceRatio"],
                "calibration": evaluated["calibrationError"] <= PROMOTION["maximumCalibrationError"]}
    partition_meta = {name: {"start": samples[0][0].isoformat(), "endInclusive": samples[-1][0].isoformat(), "examples": len(samples),
                             "positives": sum(y for _d, _c, _x, y in samples)} for name, samples in partitions.items()}
    artifact = {"schemaVersion": 1, "target": TARGET, "horizonHours": 24, "gridSizeM": GRID_M,
                "methodVersion": METHOD_VERSION, "datasetVersion": manifest["datasetVersion"], "trainingInputGeneration": manifest["generation"],
                "geometry": manifest["geometry"], "regionId": manifest["regionId"], "forecastPlatforms": manifest["forecastPlatforms"],
                "trainedAt": datetime.now(UTC).isoformat(), "features": FEATURES, "weights": weights, "calibration": platt,
                "supportPolicy": SUPPORT_POLICY,
                "publicationLatencyHours": 24, "partitions": partition_meta, "partitionGapDays": 2,
                "regularization": .01, "iterations": iterations, "sampling": "All domain cells; no negative sampling or class weighting",
                "promotionCriteria": PROMOTION, "promotionChecks": criteria, "promoted": all(criteria.values()),
                "evaluation": {"kind": "retrospective chronological holdout", "model": evaluated, "baselines": baselines,
                               "chosenBaseline": baseline, "brierSkill": skill, "spatialHoldout": None,
                               "limitations": ["Availability timestamps absent; conservative 24-hour publication assumption.",
                                               "Reporting-window labels describe reports, not absence of fire.",
                                               "No held-out geographic domain; use only within the training region.",
                                               "No weather or fuel features; history-only model."]}}
    version_fields = {k: v for k, v in artifact.items() if k != "trainedAt"}
    artifact["modelVersion"] = "reported-hotspot-logistic-" + hashlib.sha256(json.dumps(version_fields, sort_keys=True).encode()).hexdigest()[:16]
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    temporary.replace(output)
    return artifact


def outlook_document(query, now=None, archive=None, model_path=None):
    now = now or datetime.now(UTC)
    manifest, store = archive if archive is not None else load_archive()
    base = {"queryId": query.get("id"), "state": "unavailable", "target": TARGET, "horizonHours": 24,
            "gridSizeM": GRID_M, "effectiveInputResolution": "10 km aggregation of satellite reports; no weather inputs",
            "features": {"type": "FeatureCollection", "features": []}, "evaluation": None, "modelVersion": None,
            "supportPolicy": SUPPORT_POLICY}
    start = datetime.fromisoformat(query["interval"]["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(query["interval"]["endExclusive"].replace("Z", "+00:00"))
    if not start.date() <= now.date() < end.date() + (timedelta(days=1) if end.time() != datetime.min.time() else timedelta(0)):
        return {**base, "reason": "A current outlook is unavailable for a historical interval. No hindcast product is configured."}
    if store is None:
        return {**base, "reason": "No regional historical reporting dataset has been loaded."}
    geometry = query["aoi"]["geometry"]
    if not supports_geometry(manifest, geometry):
        return {**base, "reason": "This region is outside the configured outlook domain."}
    issue = datetime.combine(now.date(), datetime.min.time(), UTC)
    base.update(issueTime=issue.isoformat(), validStart=issue.isoformat(), validEnd=(issue + timedelta(days=1)).isoformat(),
                inputGeneration=manifest["generation"], datasetVersion=manifest["datasetVersion"],
                domain=manifest["geometry"])
    artifact = None
    configured = str(model_path or os.environ.get("SHARP_OUTLOOK_MODEL_PATH", "")).strip()
    if configured and Path(configured).is_file():
        artifact = json.loads(Path(configured).read_text(encoding="utf-8"))
        if artifact.get("methodVersion") != METHOD_VERSION or artifact.get("datasetVersion") != manifest["datasetVersion"] or artifact.get("geometry") != manifest["geometry"] or artifact.get("forecastPlatforms") != manifest.get("forecastPlatforms"):
            artifact = None
    query_identity = hashlib.sha256(json.dumps(query, sort_keys=True).encode()).hexdigest()
    model_generation = hashlib.sha256(json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if artifact else None
    cache_key = (artifact.get("modelVersion") if artifact else None, model_generation, issue.isoformat(), base["validEnd"], manifest["generation"], query_identity, SUPPORT_POLICY)
    if cache_key in _SERVING_CACHE:
        cached = _SERVING_CACHE[cache_key]
        if now < datetime.fromisoformat(cached["validEnd"]):
            return cached
        _SERVING_CACHE.pop(cache_key, None)
    try:
        complete, activity = reporting_data(manifest, store)
        cells = domain_cells(manifest["geometry"])
    except ValueError as exc:
        return {**base, "reason": str(exc)}
    latest = max(complete, default=None)
    base["inputFreshness"] = {"latestCompleteReportingDay": latest.isoformat() if latest else None,
                              "assumedPublicationLatencyHours": 24}
    if latest is None or latest < now.date() - timedelta(days=2):
        return {**base, "reason": "Regional reporting data are too old for the next 24 hours."}
    promoted = bool(artifact and artifact.get("supportPolicy") == SUPPORT_POLICY and artifact.get("features") == FEATURES and artifact.get("promoted") and all(artifact.get("promotionChecks", {}).values()) and artifact.get("promotionChecks"))
    
    
    if promoted and now.date().isoformat() <= artifact["partitions"]["test"]["endInclusive"]:
        promoted = False
    area = prepared_area(geometry)
    supported_cells = frozenset(cells)
    features = []
    for cell in cells:
        polygon = cell_polygon(cell, GRID_M)
        points = polygon["coordinates"][0]
        lon = (points[0][0] + points[2][0]) / 2
        lat = (points[0][1] + points[2][1]) / 2
        if not area.contains(lon, lat) or not geometry_supports_area(geometry, polygon):
            continue
        values = feature_values(now.date(), cell, complete, activity, supported_cells)
        if values is None:
            continue  
        historical_days = [d for d in complete if now.date() - timedelta(days=32) <= d <= now.date() - timedelta(days=2)]
        property_values = {"id": f"outlook:{cell[0]}:{cell[1]}", "historicalReportedDates": sum(cell in activity[d] for d in historical_days),
                           "historicalCoveredDays": len(historical_days), "recentActivityRate": values[2],
                           "features": dict(zip(FEATURES, values)), "probability": None}
        if promoted:
            property_values["probability"] = calibrated(sigmoid(dot(artifact["weights"], values)), artifact["calibration"])
        features.append({"type": "Feature", "id": property_values["id"], "geometry": polygon, "properties": property_values})
    result = {**base, "state": "experimental-forecast" if promoted and features else "historical-activity" if features else "unavailable",
              "reason": "Evaluated history-only reported-detection model." if promoted else "Forecast validation is insufficient. Showing recent reported activity counts only.",
              "features": {"type": "FeatureCollection", "features": features},
              "modelVersion": artifact.get("modelVersion") if artifact else None,
              "evaluation": artifact.get("evaluation") if artifact else None,
              "promotionChecks": artifact.get("promotionChecks") if artifact else None}
    _SERVING_CACHE[cache_key] = result
    while len(_SERVING_CACHE) > 16:
        _SERVING_CACHE.popitem(last=False)
    return result
