"""Scientific routes; recent diagnostics reuse the existing acquisition boundary."""
import asyncio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from historical_activity import history_document, method_evidence, recurrence_document
from activity_outlook import outlook_document
from weather_context import weather_context
from observation_explorer import cached_snapshot, SelectionInvalid
from harmonize import filters_from_query, parse_utc_interval, prepared_area


def selected_interval_outlook(query, previous):
    """Real stored recurrence is a diagnostic fallback, never a forecast probability."""
    try:
        store = cached_snapshot(query, {})
    except SelectionInvalid:
        return previous
    recurrence = recurrence_document(query, store)
    if not recurrence["features"]:
        return {**previous, "reason": "No reported detections are stored for the selected interval; a forecast is unavailable."}
    features = []
    for feature in recurrence["features"]:
        properties = feature["properties"]
        features.append({**feature, "properties": {**properties,
            "historicalReportedDates": properties["distinctDates"],
            "historicalCoveredDays": properties["coveredReportingDays"],
            "probability": None}})
    return {**previous, "state": "historical-activity", "horizonHours": None,
            "target": "Reported detections within the selected UTC interval",
            "reason": "Showing stored observation recurrence. Forecast validation or inputs are unavailable; no future probabilities are shown.",
            "gridSizeM": recurrence["gridSizeM"], "effectiveInputResolution": "2 km equal-area aggregation of reported satellite observations",
            "validStart": query["interval"]["start"], "validEnd": query["interval"]["endExclusive"],
            "issueTime": None, "features": {"type": "FeatureCollection", "features": features}}


def validate_query(body):
    if not isinstance(body, dict) or not isinstance(body.get("query"), dict):
        raise ValueError("An investigation query is required.")
    query = body["query"]
    if not isinstance(query.get("id"), str) or not query["id"] or query.get("processingMode") != "harmonized":
        raise ValueError("A harmonized investigation query identity is required.")
    parse_utc_interval(query.get("interval"))
    filters_from_query(query.get("filters", {}))
    if not isinstance(query.get("aoi"), dict) or not isinstance(query["aoi"].get("geometry"), dict):
        raise ValueError("An investigation area is required.")
    prepared_area(query["aoi"]["geometry"])
    return query


async def cached_diagnostic(request, build):
    """Overlay controls and method inspection never trigger observation acquisition."""
    try:
        body = await request.json()
        query = validate_query(body)
        store = cached_snapshot(query, body.get("options") or {})
        return await asyncio.to_thread(build, query, store)
    except SelectionInvalid as exc:
        return JSONResponse({"message": str(exc)}, status_code=409)
    except (ValueError, KeyError, TypeError) as exc:
        return JSONResponse({"message": str(exc)}, status_code=422)


def register_scientific_routes(app, analysis_document):
    router = APIRouter()

    @router.get("/analysis/weather-context")
    async def weather():
        try:
            return weather_context()
        except ValueError as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/history")
    async def history(request: Request):
        try:
            body = await request.json()
            query = validate_query(body)
            return await asyncio.to_thread(history_document, query, body.get("options"))
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/outlook")
    async def outlook(request: Request):
        try:
            body = await request.json()
            query = validate_query(body)
            result = await asyncio.to_thread(outlook_document, query)
            if result["state"] == "unavailable":
                result = await asyncio.to_thread(selected_interval_outlook, query, result)
            return result
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/method")
    async def method(request: Request):
        return await cached_diagnostic(request, method_evidence)

    @router.post("/analysis/recurrence")
    async def recurrence(request: Request):
        return await cached_diagnostic(request, recurrence_document)

    app.include_router(router)
