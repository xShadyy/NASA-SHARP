
import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from global_ingestion import BULK_24H_SOURCES, BULK_SOURCES, download_source, refresh_global, run_owner, warm_retained_raster
from global_store import GlobalStore
from global_tiles import GlobalPresentation, SnapshotUnavailable
from global_routes import register_global_routes

ANCHOR = datetime(2026, 11, 15, 13, tzinfo=UTC)
HEADER = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,scan,track,version\n"


def csv(source, hours=(1,)):
    satellite, confidence = ("Aqua", "75") if source == "MODIS_NRT" else ("NOAA-21" if source == "VIIRS_NOAA21_NRT" else "NOAA-20", "nominal")
    return HEADER + "".join(f"52,12,{(ANCHOR-timedelta(hours=hour)).date()},{(ANCHOR-timedelta(hours=hour)).strftime('%H%M')},{satellite},{confidence},12,D,1.2,1.1,NRT\n" for hour in hours)


class GlobalStartupTests(unittest.TestCase):
    def setUp(self):
        configuration = patch.dict(os.environ, {"SHARP_GLOBAL_RASTER_PREWARM_ENABLED": "1", "SHARP_GLOBAL_REFRESH_SECONDS": "3600"})
        configuration.start()
        self.addCleanup(configuration.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = GlobalStore(Path(self.directory.name) / "global.sqlite")
        self.service = GlobalPresentation(self.store)

    def test_bootstrap_shows_first_satellite_before_other_downloads_and_pins_membership(self):
        async def exercise():
            seen, first_snapshot, timing = [], [], {}
            started = time.perf_counter()
            async def transport(request):
                seen.append(str(request.url))
                if len(seen) == 1:
                    building = self.service.manifest()
                    self.assertEqual(building["status"], "building")
                    self.assertTrue(building["refreshing"])
                    self.assertIsNone(building["count"])
                else:
                    partial = self.service.manifest()
                    first_snapshot.append(partial["snapshotId"])
                    self.assertEqual(partial["count"], 1)
                    self.assertTrue(partial["refreshing"])
                    self.assertEqual(partial["status"], "stale")  
                    timing["firstSourceVisibleMs"] = round((time.perf_counter()-started)*1000, 3)
                    wider = self.service.manifest("7d")
                    self.assertEqual(wider["status"], "building")
                    self.assertIsNone(wider["snapshotId"])
                    self.assertIsNone(wider["count"])
                    with self.assertRaises(SnapshotUnavailable):
                        self.service.tile(partial["snapshotId"], "7d", 0, 0, 0)
                source = "MODIS_NRT" if len(seen) == 1 else "VIIRS_NOAA20_NRT"
                return httpx.Response(200, text=csv(source, (1, 25)), headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                result = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT", "VIIRS_NOAA20_NRT"], window="24h")
            self.assertEqual(result["state"], "published")
            self.assertEqual(seen, [BULK_24H_SOURCES["MODIS_NRT"], BULK_24H_SOURCES["VIIRS_NOAA20_NRT"]])
            self.assertEqual(self.service.manifest()["count"], 2)
            self.assertFalse(self.service.manifest()["refreshing"])
            self.assertEqual(self.service.observations(first_snapshot[0], "24h")["data"]["total"], 1)
            self.assertEqual(self.service.manifest("48h")["status"], "unavailable")
            self.assertIsNone(self.service.manifest("48h")["count"])
            timing["completeBootstrapMs"] = round((time.perf_counter()-started)*1000, 3)
            print("\nSynthetic two-source 24h startup timings (zero NASA requests): " + json.dumps(timing))
        asyncio.run(exercise())

    def test_explicit_seven_day_refresh_has_own_conditional_identity_and_real_wider_membership(self):
        async def exercise():
            seen = []
            async def transport(request):
                seen.append(request)
                short = str(request.url).endswith("_24h.csv")
                if not short:
                    self.assertNotIn("if-none-match", request.headers)
                    self.assertNotIn("if-modified-since", request.headers)
                return httpx.Response(200, text=csv("MODIS_NRT", (1,) if short else (1, 72)), headers={"ETag": '"same-provider-tag"', "Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                boot = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"], window="24h")
                self.assertIsNone(self.service.manifest("7d")["snapshotId"])
                warm = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"], window="7d")
            self.assertEqual([str(request.url) for request in seen], [BULK_24H_SOURCES["MODIS_NRT"], BULK_SOURCES["MODIS_NRT"]])
            self.assertEqual(self.service.observations(warm["manifest"]["snapshot"], "7d")["data"]["total"], 2)
            self.assertEqual(self.service.observations(boot["manifest"]["snapshot"], "24h")["data"]["total"], 1)
            self.assertEqual(self.store.source_state("MODIS_NRT")["downloadWindowHours"], 168)
        asyncio.run(exercise())

    def test_building_manifest_is_not_cached_or_reported_as_successful_zero(self):
        self.assertTrue(self.store.lease("global-ingestion", "test-owner"))
        self.store.update_ingestion_status("test-owner", phase="downloading", window="24h", totalSources=3, completedSources=0)
        app = FastAPI()
        app.state.global_store = self.store
        register_global_routes(app)
        with TestClient(app) as client:
            self.assertEqual(client.get("/global/manifest?window=30d").status_code, 422)
            response = client.get("/global/manifest?window=24h")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.json()["status"], "building")
            self.assertIsNone(response.json()["count"])
        self.store.release("global-ingestion", "test-owner")
        self.assertEqual(self.service.manifest()["status"], "unavailable")

    def test_backend_owner_only_refreshes_24h_on_cold_start_and_subsequent_cycles(self):
        async def exercise():
            calls = []
            async def refresh(store, **options):
                calls.append(options)
                return {"state": "published"}
            async def sleep(seconds):
                if seconds != 1 and len(calls) >= 2:
                    raise asyncio.CancelledError()
            with patch.dict(os.environ, {"SHARP_GLOBAL_INGEST_ENABLED": "1"}), patch("global_ingestion.refresh_global", side_effect=refresh), patch("global_ingestion.asyncio.sleep", side_effect=sleep):
                with self.assertRaises(asyncio.CancelledError):
                    await run_owner(SimpleNamespace(state=SimpleNamespace(global_store=self.store)))
            self.assertEqual(calls, [{"window": "24h"}, {"window": "24h"}])
        asyncio.run(exercise())

    def test_default_three_source_refresh_never_downloads_a_longer_window(self):
        async def exercise():
            requested = []
            def transport(request):
                requested.append(str(request.url))
                source = next(name for name, url in BULK_24H_SOURCES.items() if url == str(request.url))
                return httpx.Response(200, text=csv(source), headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
            with patch.dict(os.environ, {"SHARP_GLOBAL_SOURCES": ""}):
                async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                    first = await refresh_global(self.store, client, ANCHOR)
                    cached = await refresh_global(self.store, client, ANCHOR + timedelta(minutes=1))
                    self.assertEqual(cached["state"], "cached")
                    
                    self.assertIsNone(self.service.manifest("7d")["snapshotId"])
                    await refresh_global(self.store, client, ANCHOR + timedelta(minutes=65))
            self.assertEqual(first["successfulSources"], 3)
            self.assertEqual(requested, list(BULK_24H_SOURCES.values()) * 2)
            self.assertFalse(any("_7d.csv" in url for url in requested))
        asyncio.run(exercise())

    def test_fresh_seven_day_cache_does_not_skip_the_default_24h_product(self):
        async def exercise():
            requested = []
            def transport(request):
                requested.append(str(request.url))
                short = str(request.url).endswith("_24h.csv")
                return httpx.Response(200, text=csv("MODIS_NRT", (1,) if short else (1, 72)),
                    headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"], window="7d")
                cached = await refresh_global(self.store, client, ANCHOR+timedelta(minutes=1), ["MODIS_NRT"], window="7d")
                self.assertEqual(cached["state"], "cached")
                default = await refresh_global(self.store, client, ANCHOR+timedelta(minutes=1), ["MODIS_NRT"])
            self.assertEqual(requested, [BULK_SOURCES["MODIS_NRT"], BULK_24H_SOURCES["MODIS_NRT"]])
            self.assertEqual(default["state"], "published")
            self.assertEqual(self.store.source_state("MODIS_NRT")["downloadWindowHours"], 24)
        asyncio.run(exercise())

    def test_rolling_24h_boundaries_preserve_reports_but_do_not_infer_full_day_coverage(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,
                    text=csv("MODIS_NRT", (24.01, 24, 1, 0)),
                    headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"}))) as client:
                result = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"])
            snapshot = result["manifest"]["snapshot"]
            rows = tuple(self.store.iter_observations(snapshot))
            self.assertEqual({row.acquired_at for row in rows}, {ANCHOR-timedelta(hours=24), ANCHOR-timedelta(hours=1)})
            self.assertEqual(result["manifest"]["windows"]["24h"]["startUtc"], "2026-11-14T13:00:00Z")
            self.assertEqual(result["manifest"]["status"], "partial")
            state = self.store.source_state("MODIS_NRT")
            self.assertEqual(state["coverageStart"], "2026-11-15T00:00:00Z")
            with closing(self.store.connect()) as db:
                coverage = dict(db.execute("SELECT day,coverage FROM global_partition_versions"))
            self.assertEqual(coverage, {"2026-11-14": "unknown", "2026-11-15": "partial"})
        asyncio.run(exercise())

    def test_refresh_keeps_a_failed_sources_actual_retrieval_time_and_stale_state(self):
        async def exercise():
            sources = ["MODIS_NRT", "VIIRS_NOAA20_NRT"]
            def initial(request):
                source = next(name for name in sources if BULK_24H_SOURCES[name] == str(request.url))
                return httpx.Response(200, text=csv(source), headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(initial)) as client:
                await refresh_global(self.store, client, ANCHOR, sources)
            retrieved = self.store.source_state("VIIRS_NOAA20_NRT")["retrievedAt"]
            def subsequent(request):
                if str(request.url) == BULK_24H_SOURCES["VIIRS_NOAA20_NRT"]:
                    return httpx.Response(429, headers={"Retry-After": "1800"})
                return httpx.Response(200, text=csv("MODIS_NRT"), headers={"Last-Modified": "Sun, 15 Nov 2026 13:20:00 GMT"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(subsequent)) as client:
                result = await refresh_global(self.store, client, ANCHOR+timedelta(minutes=20), sources, force=True)
            states = {state["source"]: state for state in result["manifest"]["sources"]}
            self.assertEqual(states["VIIRS_NOAA20_NRT"]["retrievedAt"], retrieved)
            self.assertEqual(states["VIIRS_NOAA20_NRT"]["status"], "stale")
            self.assertNotEqual(states["MODIS_NRT"]["retrievedAt"], retrieved)
            self.assertTrue(result["manifest"]["stale"])
            self.assertEqual(result["manifest"]["status"], "partial")
            self.assertEqual(self.service.manifest()["count"], 2)
        asyncio.run(exercise())

    def test_successful_zero_is_partial_reporting_coverage_and_missing_sources_stay_unknown(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,
                    text=HEADER, headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"}))) as client:
                result = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"])
            self.assertEqual(self.service.manifest()["count"], 0)
            self.assertEqual(result["manifest"]["status"], "partial")
            self.assertEqual(self.store.source_state("MODIS_NRT")["status"], "ok")
            self.assertIsNone(self.store.source_state("VIIRS_NOAA21_NRT"))
            self.assertIsNone(self.service.manifest("7d")["count"])
        asyncio.run(exercise())

    def test_prewarm_failure_does_not_turn_valid_source_data_into_a_download_failure(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,
                    text=csv("MODIS_NRT"), headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"}))) as client:
                with patch("global_raster.prewarm_global_raster", side_effect=RuntimeError("Test cache unavailable")):
                    result = await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"])
            self.assertEqual(result["state"], "published")
            self.assertEqual(result["failedSources"], [])
            self.assertEqual(self.service.manifest()["count"], 1)
            self.assertGreater(self.store.metrics()["raster_prewarm_failures"], 0)
        asyncio.run(exercise())

    def test_download_default_uses_24h_and_rejects_unsupported_windows(self):
        async def exercise():
            requested = []
            def transport(request):
                requested.append(str(request.url))
                return httpx.Response(200, text=csv("MODIS_NRT"))
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                await download_source(client, "MODIS_NRT")
                with self.assertRaises(ValueError):
                    await download_source(client, "MODIS_NRT", window="48h")
            self.assertEqual(requested, [BULK_24H_SOURCES["MODIS_NRT"]])
        asyncio.run(exercise())

    def test_retained_startup_warmup_is_shared_local_work_and_does_not_freshen_data(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,
                    text=csv("MODIS_NRT"), headers={"Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"}))) as client:
                await refresh_global(self.store, client, ANCHOR, ["MODIS_NRT"])
            before = self.store.current_manifest()
            requests = self.store.metrics()["upstream_bulk_requests"]
            with patch("global_raster.prewarm_global_raster", return_value={"tiles": 5}) as prewarm:
                with closing(self.store.connect()) as db, db:
                    db.execute("DELETE FROM global_leases WHERE name LIKE 'global-raster-prewarm:%'")
                first, second = await asyncio.gather(warm_retained_raster(self.store),
                    warm_retained_raster(GlobalStore(self.store.path)))
                self.assertEqual({first["state"], second["state"]}, {"warmed", "coalesced"})
                self.assertEqual((await warm_retained_raster(self.store))["state"], "coalesced")
                self.assertEqual(prewarm.call_count, 1)
                self.assertEqual(prewarm.call_args.args[1:], (before["snapshot"], "24h"))
            self.assertEqual(self.store.current_manifest(), before)
            self.assertEqual(self.store.metrics()["upstream_bulk_requests"], requests)
        asyncio.run(exercise())

    def test_owner_hourly_default_honors_explicit_fifteen_minute_configuration(self):
        async def exercise(configured):
            sleeps = []
            async def sleep(seconds):
                sleeps.append(seconds)
                if seconds != 1:
                    raise asyncio.CancelledError()
            with patch.dict(os.environ, {"SHARP_GLOBAL_INGEST_ENABLED": "1"}), patch("global_ingestion.asyncio.sleep", side_effect=sleep), patch("global_ingestion.warm_retained_raster", return_value={"state": "unavailable"}), patch("global_ingestion.refresh_global", return_value={"state": "cached"}):
                if configured is None:
                    os.environ.pop("SHARP_GLOBAL_REFRESH_SECONDS", None)
                else:
                    os.environ["SHARP_GLOBAL_REFRESH_SECONDS"] = configured
                with self.assertRaises(asyncio.CancelledError):
                    await run_owner(SimpleNamespace(state=SimpleNamespace(global_store=self.store)))
            self.assertEqual(sleeps, [1, 3600 if configured is None else 900])
        for configured in (None, "900"):
            with self.subTest(configured=configured):
                asyncio.run(exercise(configured))

    def test_hourly_refresh_does_not_round_away_recent_provider_acquisitions(self):
        async def exercise():
            text = HEADER + "52,12,2026-11-15,1330,Aqua,75,12,D,1.2,1.1,NRT\n"
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,
                    text=text, headers={"Last-Modified": "Sun, 15 Nov 2026 13:37:00 GMT"}))) as client:
                with patch.dict(os.environ, {"SHARP_GLOBAL_REFRESH_SECONDS": "3600"}):
                    result = await refresh_global(self.store, client, ANCHOR+timedelta(minutes=50), ["MODIS_NRT"])
            self.assertEqual(result["manifest"]["anchorUtc"], "2026-11-15T13:37:00Z")
            self.assertEqual(len(tuple(self.store.iter_observations(result["manifest"]["snapshot"]))), 1)
            interval = result["manifest"]["windows"]["24h"]
            self.assertEqual(interval["startUtc"], "2026-11-14T13:37:00Z")
            self.assertEqual(interval["endUtcExclusive"], "2026-11-15T13:37:00Z")
        asyncio.run(exercise())

    def test_read_only_backend_still_warms_retained_raster_without_acquisition(self):
        async def exercise():
            async def sleep(_seconds):
                return
            with patch.dict(os.environ, {"SHARP_GLOBAL_INGEST_ENABLED": "0"}), patch("global_ingestion.asyncio.sleep", side_effect=sleep), patch("global_ingestion.warm_retained_raster", return_value={"state": "warmed"}) as prewarm, patch("global_ingestion.refresh_global") as refresh:
                await run_owner(SimpleNamespace(state=SimpleNamespace(global_store=self.store)))
            prewarm.assert_awaited_once_with(self.store)
            refresh.assert_not_called()
        asyncio.run(exercise())

    def test_read_only_or_disabled_warmup_never_requires_failure_metadata_writes(self):
        async def exercise():
            with patch.dict(os.environ, {"SHARP_GLOBAL_RASTER_PREWARM_ENABLED": "0"}), patch.object(self.store, "lease") as lease:
                self.assertEqual((await warm_retained_raster(self.store, "stored"))["state"], "disabled")
                lease.assert_not_called()
            with patch.dict(os.environ, {"SHARP_GLOBAL_RASTER_PREWARM_ENABLED": "1"}), patch.object(self.store, "lease", side_effect=sqlite3.OperationalError("readonly database")), patch.object(self.store, "metric") as metric, patch("global_raster.prewarm_global_raster") as render:
                self.assertEqual((await warm_retained_raster(self.store, "stored"))["state"], "skipped")
                metric.assert_not_called()
                render.assert_not_called()
        asyncio.run(exercise())
