
import asyncio
from datetime import timedelta
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from historical_activity import history_document, method_evidence, recurrence_document, load_query_archive, supports_geometry
from historical_preparation import prepare_history, history_status
from weather_context import weather_context
from observation_explorer import cached_snapshot, SelectionInvalid, source_generation
from harmonize import filters_from_query, parse_utc_interval, prepared_area


def validate_query(body):
    if not isinstance(body, dict) or not isinstance(body.get("query"), dict):
        raise ValueError("An investigation query is required.")
    query = body["query"]
    if not isinstance(query.get("id"), str) or not query["id"] or query.get("processingMode") != "harmonized":
        raise ValueError("A harmonized investigation query identity is required.")
    if body.get("options") is not None and not isinstance(body["options"], dict):
        raise ValueError("Investigation options must be an object.")
    parse_utc_interval(query.get("interval"))
    filters_from_query(query.get("filters", {}))
    if not isinstance(query.get("aoi"), dict) or not isinstance(query["aoi"].get("geometry"), dict):
        raise ValueError("An investigation area is required.")
    prepared_area(query["aoi"]["geometry"])
    return query


async def cached_diagnostic(request, build):
    
    try:
        body = await request.json()
        query = validate_query(body)
        store = await asyncio.to_thread(stored_diagnostic_snapshot, query, body.get("options") or {}, history_root(request.app))
        return await asyncio.to_thread(build, query, store)
    except SelectionInvalid as exc:
        return JSONResponse({"message": str(exc), "code": exc.code, "action": exc.action, "recoverable": False}, status_code=409)
    except (ValueError, KeyError, TypeError) as exc:
        return JSONResponse({"message": str(exc)}, status_code=422)


def stored_diagnostic_snapshot(query, options, root=None):
    
    try:
        return cached_snapshot(query, options)
    except SelectionInvalid:
        if options.get("selectionToken") or options.get("observationIds"):
            raise
        manifest, store = load_query_archive(query, root=root)
        first, last = parse_utc_interval(query["interval"])
        days = [record.day for record in store.coverage] if store else []
        if (store is None or manifest is None or not days
                or not supports_geometry(manifest, query["aoi"]["geometry"])
                or not min(days) <= first < last <= max(days) + timedelta(days=1)):
            raise
        expected = options.get("sourceGeneration")
        if expected is not None and expected != source_generation(store):
            raise SelectionInvalid("The historical input generation changed. Refresh the investigation before mapping diagnostics.")
        return store


def history_root(app):
    storage = getattr(app.state, "global_store", None)
    return storage.path.parent / "history" if storage is not None else None


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
            options = body.get("options") or {}
            progress = await asyncio.to_thread(history_status, request.app, query)
            archive = await asyncio.to_thread(load_query_archive, query, history_root(request.app))
            result = await asyncio.to_thread(history_document, query, options, archive=archive)
            return {**result, "preparation": progress}
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/history/prepare")
    async def prepare(request: Request):
        try:
            body = await request.json()
            query = validate_query(body)
            return await prepare_history(request.app, query, body.get("options") or {})
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/history/status")
    async def preparation_status(request: Request):
        try:
            query = validate_query(await request.json())
            return await asyncio.to_thread(history_status, request.app, query)
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"message": str(exc)}, status_code=422)

    @router.post("/analysis/method")
    async def method(request: Request):
        return await cached_diagnostic(request, method_evidence)

    @router.post("/analysis/recurrence")
    async def recurrence(request: Request):
        return await cached_diagnostic(request, recurrence_document)

    app.include_router(router)
