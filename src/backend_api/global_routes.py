"""Local immutable worldwide presentation endpoints. These never contact FIRMS."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from global_store import GlobalStore
from global_tiles import GlobalPresentation, SnapshotUnavailable, cache_statistics
from harmonize import RejectedQuery

LOG = logging.getLogger("sharp.global")


def register_global_routes(app):
    router = APIRouter()

    def service(request):
        stored = getattr(request.app.state, "global_store", None)
        if stored is None:
            stored = GlobalStore()
            request.app.state.global_store = stored
        return GlobalPresentation(stored)

    def failure(exc):
        return JSONResponse({"message": str(exc), "status": "unavailable"}, status_code=410 if isinstance(exc, SnapshotUnavailable) else 422)

    @router.get("/global/manifest")
    async def manifest(request: Request, window: str = "24h"):
        try:
            document = await asyncio.to_thread(service(request).manifest, window)
            payload = json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
            etag = '"' + hashlib.sha256(payload).hexdigest() + '"'
            headers = {"ETag": etag, "Cache-Control": "public,max-age=30,stale-while-revalidate=60"}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return Response(payload, media_type="application/json", headers=headers)
        except (ValueError, RejectedQuery) as exc:
            return failure(exc)

    @router.get("/global/tiles/{snapshot}/{window}/{z}/{x}/{y}.json")
    async def tile(request: Request, snapshot: str, window: str, z: int, x: int, y: int, filters: str = "{}"):
        try:
            if len(filters) > 2048:
                raise RejectedQuery("Display filter signature exceeds its bounded contract.")
            body, compressed, digest, metrics = await asyncio.to_thread(service(request).tile, snapshot, window, z, x, y, json.loads(filters))
            gzip_supported = "gzip" in request.headers.get("accept-encoding", "")
            headers = {"ETag": '"' + digest + ("-gz" if gzip_supported else "") + '"', "Cache-Control": "public,max-age=31536000,immutable", "Vary": "Accept-Encoding",
                       "X-Snapshot-Id": snapshot, "X-Observation-Count": str(metrics["observations"]), "X-Presentation-Schema": "global-squares-1"}
            if request.headers.get("if-none-match") == headers["ETag"]:
                return Response(status_code=304, headers=headers)
            if gzip_supported:
                headers["Content-Encoding"] = "gzip"; payload = compressed
            else:
                payload = body
            LOG.info("global_tile snapshot=%s tile=%s/%s/%s records=%s symbols=%s bytes=%s generation_ms=%.3f", snapshot, z, x, y, metrics["observations"], metrics["features"], len(payload), metrics["generationMs"])
            return Response(payload, media_type="application/geo+json", headers=headers)
        except (ValueError, RejectedQuery, TypeError) as exc:
            return failure(exc)

    async def body_scope(request):
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("snapshotId"), str) or len(body["snapshotId"]) > 128:
            raise RejectedQuery("A published global snapshot identity is required.")
        options = body.get("options", {})
        if not isinstance(options, dict):
            raise RejectedQuery("Observation options must be an object.")
        if body.get("observationId"):
            options = {**options, "observationId": body["observationId"]}
        return body, options

    @router.post("/global/observations")
    async def observations(request: Request):
        try:
            body, options = await body_scope(request)
            return await asyncio.to_thread(service(request).observations, body["snapshotId"], body.get("window", "24h"), body.get("aggregateId"), options, body.get("displayFilters"))
        except (ValueError, RejectedQuery, TypeError) as exc:
            return failure(exc)

    @router.get("/global/observation/{snapshot}/{observation_id}")
    async def observation(request: Request, snapshot: str, observation_id: str, window: str = "24h"):
        try:
            return await asyncio.to_thread(service(request).observations, snapshot, window, None, {"observationId": observation_id, "pageSize": 1})
        except (ValueError, RejectedQuery, TypeError) as exc:
            return failure(exc)

    @router.post("/global/observations/export")
    async def export(request: Request):
        try:
            body, options = await body_scope(request)
            format_name = body.get("format", "csv")
            stream, count = await asyncio.to_thread(service(request).export, body["snapshotId"], body.get("window", "24h"), body.get("aggregateId"), options, format_name, body.get("displayFilters"))
            return StreamingResponse(stream, media_type={"csv": "text/csv", "geojson": "application/geo+json", "json": "application/json"}[format_name], headers={"Content-Disposition": f'attachment; filename="sharp-global.{format_name}"', "X-Observation-Count": str(count), "X-Snapshot-Id": body["snapshotId"]})
        except (ValueError, RejectedQuery, TypeError) as exc:
            return failure(exc)

    @router.get("/global/status")
    async def status(request: Request):
        store = service(request).store
        governor = getattr(request.app.state, "quota", None)
        return {"manifest": await asyncio.to_thread(store.current_manifest), "metrics": await asyncio.to_thread(store.metrics), "tileCache": cache_statistics(),
                "quota": await asyncio.to_thread(governor.status) if governor is not None else None,
                "acquisitionPolicy": "Only the designated persisted-lease ingestion owner performs global refreshes. Map and popup requests read local immutable snapshots."}

    app.include_router(router)
