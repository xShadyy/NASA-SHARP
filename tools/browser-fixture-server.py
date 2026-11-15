"""TEST ONLY: real local API backed by temporary, explicitly synthetic fixtures.

Run this instead of a production backend during browser integration checks.
No upstream acquisition is permitted. All databases disappear on shutdown.
"""
import argparse
import csv
import json
import math
import os
import sys
import tempfile
from collections import Counter
from contextlib import asynccontextmanager, closing
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend_api"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--building-manifest-count", type=int, default=0,
                        help="Test-only initial progress responses before serving stored observations")
    parser.add_argument("--manifest-failures", type=int, default=0,
                        help="Test-only initial failures to exercise the startup retry screen")
    parser.add_argument("--partial-global", action="store_true",
                        help="Test a useful partial dataset with one unavailable satellite")
    parser.add_argument("--individual-point-layout", action="store_true",
                        help="Spread test-only points across the existing fixture AOI for native pixel rendering checks")
    parser.add_argument("--global-database", type=Path,
                        help="Read global observations from this existing database in SQLite mode=ro; all other stores remain temporary")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="sharp-browser-test-") as directory:
        directory = Path(directory)
        os.environ.update(SHARP_GLOBAL_INGEST_ENABLED="0", SHARP_GLOBAL_RASTER_PREWARM_ENABLED="0", FIRMS_MAP_KEY="",
                          SHARP_GLOBAL_DB_PATH=str(directory / "global.sqlite"),
                          FIRMS_CACHE_PATH=str(directory / "requests.sqlite"),
                          SHARP_HISTORY_PATH=str(directory / "history.sqlite"))
        for name in ("MAP_KEY", "DATABASE_URL", "FIRE_DATA_CSV", "FIRE_COVERAGE_CSV", "SHARP_OUTLOOK_MODEL_PATH"):
            os.environ.pop(name, None)
        from harmonize import Detection, detection_id
        from historical_activity import import_archive
        from global_store import GlobalStore
        import httpx
        import uvicorn
        from fastapi import Request
        from fastapi.responses import JSONResponse

        anchor = datetime.now(UTC).replace(microsecond=0)
        store = GlobalStore()
        sources = {"aqua": "MODIS_NRT", "noaa-20": "VIIRS_NOAA20_NRT"}
        rows = [Detection("aqua" if i % 2 == 0 else "noaa-20",
                          12 + (i % 26 - 12) * .6 if args.individual_point_layout else 12 + (i % 26) * .0001,
                          18 + (i // 26 - 13) * .6 if args.individual_point_layout else 18 + (i // 26) * .0001,
                          anchor - timedelta(hours=1, seconds=i),
                          None if i % 7 == 0 else float(i % 100),
                          "nominal" if i % 2 else None, 75 if i % 2 == 0 else None,
                          None if i % 9 == 0 else "D" if i % 3 else "N", 1.1, 1.2,
                          1000 if i % 2 == 0 else 375, sources["aqua" if i % 2 == 0 else "noaa-20"],
                          "test-only-v1", "NRT", "nominal" if i % 2 else 75) for i in range(702)]
        for platform, source in sources.items():
            store.replace_source(source, [row for row in rows if row.platform == platform],
                                 anchor - timedelta(days=7), anchor, anchor.timestamp(),
                                 {"fixture": "synthetic browser test, never production"})
        expected_sources = list(sources.values()) + (["VIIRS_NOAA21_NRT"] if args.partial_global else [])
        published = store.publish(anchor, expected_sources, anchor.timestamp())
        initial_snapshot = published["snapshot"]
        # Test-only immutable membership used to decode the actual browser tile
        # responses. Production MVTs deliberately omit canonical metadata.
        with closing(store.connect()) as db:
            point_observations = [dict(row) for row in db.execute("""
                SELECT o.id, o.observation_id AS observationId, o.longitude, o.latitude
                FROM global_observations o
                JOIN global_snapshot_observations s ON s.row_id=o.id
                WHERE s.snapshot=? ORDER BY o.id
                """, (initial_snapshot,))]

        geometry = {"type": "Polygon", "coordinates": [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]]}
        detections = directory / "history.csv"
        coverage = directory / "coverage.csv"
        with detections.open("w", newline="", encoding="utf-8") as records_file, coverage.open("w", newline="", encoding="utf-8") as coverage_file:
            records = csv.writer(records_file)
            records.writerow(["platform_code", "latitude", "longitude", "acquired_at", "frp_mw", "confidence_class", "confidence_pct", "day_night", "source_product", "product_version", "processing_tier"])
            states = csv.writer(coverage_file)
            states.writerow(["date", "platform_code", "state"])
            day = date(2022, 1, 1)
            while day <= anchor.date():
                for platform in ("T", "A", "N", "N20", "N21"):
                    states.writerow([day.isoformat(), platform, "partial" if day == anchor.date() else "complete"])
                for platform in ("A", "N20"):
                    records.writerow([platform, 12, 18, f"{day}T10:00:00Z", 20 + day.day, "nominal" if platform == "N20" else "", 75 if platform == "A" else "", "D", "synthetic-history-product", "test-only-v1", "standard"])
                day += timedelta(days=1)
        manifest = import_archive(directory / "history.sqlite", detections, coverage,
            {"regionId": "synthetic-browser-fixture", "regionName": "Synthetic browser test region", "geometry": geometry,
             "datasetVersion": "synthetic-browser-history-v1", "sources": ["synthetic-browser-fixture"],
             "forecastPlatforms": ["noaa-20"]})

        counts = Counter()
        upstream_attempts = []
        async def reject_upstream(_transport, request):
            upstream_attempts.append({"host": request.url.host, "method": request.method})
            raise AssertionError("Browser fixture forbids upstream requests")
        httpx.AsyncHTTPTransport.handle_async_request = reject_upstream
        import app as api
        serving_global = store
        if args.global_database:
            from global_point_benchmark import ReadOnlyGlobalStore
            readonly_global = ReadOnlyGlobalStore(args.global_database)
            serving_global = readonly_global
            original_lifespan = api.app.router.lifespan_context
            @asynccontextmanager
            async def readonly_lifespan(application):
                async with original_lifespan(application):
                    application.state.global_store = readonly_global
                    yield
            api.app.router.lifespan_context = readonly_lifespan

        @api.app.middleware("http")
        async def record_request(request: Request, call_next):
            if not request.url.path.startswith("/test-fixture"):
                counts[f"{request.method} {request.url.path}"] += 1
            if (request.url.path == "/global/manifest"
                    and counts["GET /global/manifest"] <= args.manifest_failures):
                return JSONResponse({"message": "The test hotspot service is temporarily unavailable. Retry loading."},
                                    status_code=503, headers={"Cache-Control": "no-store"})
            if (request.url.path == "/global/manifest"
                    and counts["GET /global/manifest"] <= args.manifest_failures + args.building_manifest_count):
                return JSONResponse({"status": "building", "window": "24h", "snapshotId": None,
                    "count": None, "refreshing": True, "reason": "Fetching hotspots from the last 24 hours."},
                    headers={"Cache-Control": "no-store"})
            return await call_next(request)

        def details():
            return {"kind": "synthetic browser test only", "processId": os.getpid(),
                    "runId": os.environ.get("SHARP_TEST_FIXTURE_ID"), "snapshotId": initial_snapshot,
                    "globalStoreMode": "read-only existing" if args.global_database else "temporary synthetic",
                    "currentSnapshotId": store.current_manifest()["snapshot"], "anchor": anchor.isoformat(),
                    "observationCount": len(rows), "observationIds": [detection_id(rows[i]) for i in (0, 1, 650, 701)],
                    "pointObservations": point_observations,
                    "area": geometry, "historyGeneration": manifest["generation"],
                    "historyStart": "2022-01-01", "historyEndInclusive": anchor.date().isoformat(),
                    "requests": dict(counts), "upstreamAttempts": upstream_attempts, "storeMetrics": store.metrics()}

        @api.app.get("/test-fixture")
        async def test_fixture():
            return details()

        @api.app.post("/test-fixture/reset-metrics")
        async def reset_metrics():
            counts.clear()
            upstream_attempts.clear()
            return details()

        @api.app.get("/test-fixture/dense-region")
        async def dense_region(snapshot: str, zoom: int = 5):
            from global_tiles import GlobalPresentation
            if not 1 <= zoom <= 8:
                return JSONResponse({"message": "Test zoom must be 1–8"}, status_code=422)
            _manifest, _snapshot, source, clauses, parameters, _filters, _interval = GlobalPresentation(serving_global)._base(snapshot, "24h")
            scale = 2 ** zoom
            query = (f"SELECT CAST(o.mx*{scale} AS INTEGER) AS x, CAST(o.my*{scale} AS INTEGER) AS y,COUNT(*) AS n FROM "
                     + source + " WHERE " + " AND ".join(clauses)
                     + " GROUP BY x,y ORDER BY n DESC,x,y LIMIT 1")
            with closing(serving_global.connect()) as database:
                winner = database.execute(query, parameters).fetchone()
            if winner is None:
                return {"snapshotId": snapshot, "count": 0}
            longitude = (winner["x"] + .5) / scale * 360 - 180
            latitude = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (winner["y"] + .5) / scale))))
            return {"snapshotId": snapshot, "zoom": zoom, "x": winner["x"], "y": winner["y"],
                    "count": winner["n"], "center": [longitude, latitude]}

        @api.app.post("/test-fixture/expire-snapshot")
        async def expire_snapshot():
            old = store.current_manifest()["snapshot"]
            new_anchor = anchor + timedelta(seconds=2 + counts["fixture-publications"])
            counts["fixture-publications"] += 1
            fresh = store.publish(new_anchor, expected_sources, new_anchor.timestamp())
            with closing(store.connect()) as db, db:
                db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (old,))
                db.execute("DELETE FROM global_snapshot_partitions WHERE snapshot=?", (old,))
                db.execute("DELETE FROM global_snapshot_observations WHERE snapshot=?", (old,))
            return {"expiredSnapshotId": old, "replacementSnapshotId": fresh["snapshot"]}

        @api.app.post("/test-fixture/zero-observations")
        async def zero_observations():
            # A successfully retrieved empty reporting window is distinct from
            # an unavailable or still-loading dataset. Never touches production.
            empty_anchor = anchor + timedelta(seconds=5 + counts["fixture-publications"])
            counts["fixture-publications"] += 1
            for source in sources.values():
                store.replace_source(source, [], empty_anchor - timedelta(days=7),
                                     empty_anchor, empty_anchor.timestamp(),
                                     {"fixture": "successful-zero browser test, never production"})
            fresh = store.publish(empty_anchor, list(sources.values()), empty_anchor.timestamp())
            return {"snapshotId": fresh["snapshot"], "expectedCount": 0}

        @api.app.post("/test-fixture/shutdown")
        async def shutdown():
            server.should_exit = True
            return {"status": "stopping", "temporaryStores": "removed after shutdown"}

        server = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=args.port, log_level="warning"))
        print(json.dumps({key: value for key, value in details().items()
                          if key in ("kind", "processId", "snapshotId", "observationCount")}), flush=True)
        server.run()


if __name__ == "__main__":
    main()
