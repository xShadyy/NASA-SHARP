import os
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
import asyncio
import sys
import tempfile
import time
import unittest
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as service
from cache import BatchCache
from harmonize import CanonicalStore, Coverage, Detection, RejectedQuery, detection_id, map_source_document, overview_document, calendar_document

AREA = {"type": "Polygon", "coordinates": [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]]}
HEADER = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,scan,track,version\n"


def query(start, end, **filters):
    return {
        "id": "analysis-cache-test",
        "processingMode": "harmonized",
        "aoi": {"geometry": AREA},
        "interval": {"start": f"{start}T00:00:00Z", "endExclusive": f"{end}T00:00:00Z"},
        "filters": {"platforms": ["aqua"], "dayNight": "all", "modisConfidenceMin": 0, "viirsConfidence": ["low", "nominal", "high"], **filters},
    }


def fake_app(path, slots=8):
    return SimpleNamespace(state=SimpleNamespace(cache=BatchCache(path), batch_locks=[asyncio.Lock() for _ in range(8)], batch_fetches={}, slots=asyncio.Semaphore(slots), key="test-key"))


class AnalysisAcquisitionCacheTest(unittest.TestCase):
    def setUp(self):
        service._FIRMS_STORES.clear()
        service._FIRMS_TASKS.clear()

    def test_daily_batches_reuse_overlap_filters_and_persistent_cache(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            first = today - timedelta(days=4)
            calls = []

            async def fetch(_app, path, started=None):
                if started:
                    started.set()
                calls.append(path)
                day = path.rsplit("/", 1)[-1]
                self.assertIn("/1/", path)
                return HEADER + f"0.5,0.5,{day},1230,Aqua,80,20,D,1.2,1.1,6.1\n"

            windows = {"MODIS_NRT": (date(2000, 11, 1), today)}
            with patch("app.product_windows", new=AsyncMock(return_value=windows)), patch("app.fetch_csv", new=AsyncMock(side_effect=fetch)):
                original = query(first, first + timedelta(days=2))
                initial = await service.shared_firms_store(app, original, (0, 0, 3, 3))
                self.assertEqual(len(initial.rows), 2)
                self.assertEqual(len(calls), 2)
                self.assertFalse(initial.cache_hit)
                changed = query(first, first + timedelta(days=2), modisConfidenceMin=95, dayNight="night", frpMin=50)
                reused = await service.shared_firms_store(app, changed, (0, 0, 3, 3))
                self.assertEqual(reused.rows, initial.rows)
                self.assertTrue(reused.cache_hit)
                self.assertEqual(len(calls), 2)
                overlap = query(first + timedelta(days=1), first + timedelta(days=3))
                await service.shared_firms_store(app, overlap, (0, 0, 3, 3))
                self.assertEqual(len(calls), 3)
                service._FIRMS_STORES.clear()
                restored = await service.shared_firms_store(app, original, (0, 0, 3, 3))
                self.assertEqual(restored.rows, initial.rows)
                self.assertTrue(restored.cache_hit)
                self.assertEqual(len(calls), 3)
                self.assertGreater(restored.expires_at, restored.fetched_at)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_empty_batches_are_cached_and_unavailable_products_are_distinct(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            first = today - timedelta(days=2)
            request = query(first, first + timedelta(days=1))
            fetch = AsyncMock(return_value=HEADER)
            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (first, today)})), patch("app.fetch_csv", new=fetch):
                empty = await service.shared_firms_store(app, request, (0, 0, 3, 3))
                service._FIRMS_STORES.clear()
                await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(overview_document(request, empty)["data"]["detectionCount"]["value"], 0)
            service._FIRMS_STORES.clear()
            with patch("app.product_windows", new=AsyncMock(return_value={})), patch("app.fetch_csv", new=fetch):
                unavailable = await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertIsNone(overview_document(request, unavailable)["data"]["detectionCount"]["value"])
                self.assertEqual(fetch.call_count, 1)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_expired_memory_and_sqlite_batches_are_reacquired(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            request = query(today - timedelta(days=1), today)
            now = time.time()
            fetch = AsyncMock(return_value=HEADER)
            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=fetch):
                first = await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertLessEqual(first.expires_at - first.fetched_at, 300)
                with patch("app.clock.time", return_value=now + 301):
                    updated = await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertEqual(fetch.call_count, 2)
                self.assertGreater(updated.fetched_at, first.fetched_at)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_exact_bounds_and_memory_size_limits(self):
        first = query("2026-11-01", "2026-11-02")
        self.assertNotEqual(service.firms_store_key(first, (0, 0, 3, 3)), service.firms_store_key(first, (0.000001, 0, 3, 3)))
        store = CanonicalStore((), (), "test", time.time(), time.time() + 100, True)
        with patch("app.MAX_FIRMS_STORE_BYTES", 2):
            service.retain_firms_store(("oversized",), store)
            self.assertFalse(service._FIRMS_STORES)
        service.retain_firms_store(("expired",), replace(store, expires_at=time.time() - 1))
        self.assertFalse(service._FIRMS_STORES)

    def test_wrapped_acquisition_areas_fail_before_any_upstream_request(self):
        from fastapi.testclient import TestClient
        wrapped = {"type": "Polygon", "coordinates": [[[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]]}
        split = {"type": "MultiPolygon", "coordinates": [
            [[[179, -1], [180, -1], [180, 1], [179, 1], [179, -1]]],
            [[[-180, -1], [-179, -1], [-179, 1], [-180, 1], [-180, -1]]],
        ]}
        unwrapped = {"type": "Polygon", "coordinates": [[[179, -1], [181, -1], [181, 1], [179, 1], [179, -1]]]}
        empty = CanonicalStore((), (), "isolated empty fixture")
        with patch("app.store_from_environment", return_value=empty), patch("app.fetch_csv", new=AsyncMock()) as upstream, TestClient(service.app) as client:
            service.app.state.key = "isolated-test-key"
            for geometry in (wrapped, split, unwrapped):
                request = query("2026-11-01", "2026-11-02")
                request["aoi"]["geometry"] = geometry
                response = client.post("/analysis/map-source", json={"query": request})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("180", response.json()["message"])
            self.assertEqual(upstream.call_count, 0)
        service.validate_acquisition_longitudes(AREA)
        service.validate_acquisition_longitudes({"type": "Polygon", "coordinates": [[[-170, -1], [-60, -1], [60, -1], [170, -1], [170, 1], [60, 1], [-60, 1], [-170, 1], [-170, -1]]]})

        async def direct():
            request = query("2026-11-01", "2026-11-02")
            request["aoi"]["geometry"] = wrapped
            with patch("app.product_windows", new=AsyncMock()) as availability:
                with self.assertRaisesRegex(RejectedQuery, "180"):
                    await service.firms_canonical_store(SimpleNamespace(), request, (-179, -1, 179, 1))
                self.assertEqual(availability.call_count, 0)
        asyncio.run(direct())

    def test_started_shared_batch_survives_one_cancelled_analysis_consumer(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            request = query(today - timedelta(days=2), today - timedelta(days=1))
            started, release = asyncio.Event(), asyncio.Event()

            async def fetch(_app, _path, request_started=None):
                if request_started:
                    request_started.set()
                started.set()
                await release.wait()
                return HEADER

            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=AsyncMock(side_effect=fetch)) as upstream:
                first = asyncio.create_task(service.shared_firms_store(app, request, (0, 0, 3, 3)))
                second = asyncio.create_task(service.shared_firms_store(app, request, (0, 0, 3, 3)))
                await started.wait()
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                release.set()
                await second
                await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertEqual(upstream.call_count, 1)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_last_cancelled_analysis_consumer_cancels_queued_days(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3", slots=0)
            today = datetime.now(UTC).date()
            request = query(today - timedelta(days=3), today)
            started = asyncio.Event()

            async def fetch(_app, _path, request_started=None):
                async with _app.state.slots:
                    if request_started:
                        request_started.set()
                    started.set()
                    return HEADER

            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=AsyncMock(side_effect=fetch)):
                first = asyncio.create_task(service.shared_firms_store(app, request, (0, 0, 3, 3)))
                await asyncio.sleep(0.02)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                await asyncio.sleep(0.02)
                self.assertFalse(started.is_set())
                self.assertFalse(app.state.batch_fetches)
                self.assertFalse(service._FIRMS_TASKS)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_started_batch_survives_last_consumer_cancel_and_is_reused(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            request = query(today - timedelta(days=2), today - timedelta(days=1))
            started, release = asyncio.Event(), asyncio.Event()

            async def fetch(_app, _path, request_started=None):
                request_started.set()
                started.set()
                await release.wait()
                return HEADER

            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=AsyncMock(side_effect=fetch)) as upstream:
                first = asyncio.create_task(service.shared_firms_store(app, request, (0, 0, 3, 3)))
                await started.wait()
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                await asyncio.sleep(0.01)
                second = asyncio.create_task(service.shared_firms_store(app, request, (0, 0, 3, 3)))
                await asyncio.sleep(0.01)
                self.assertEqual(upstream.call_count, 1)
                release.set()
                await second
                self.assertEqual(upstream.call_count, 1)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))

    def test_partial_acquisition_is_not_reported_as_successful_empty(self):
        async def exercise(directory):
            app = fake_app(directory / "batches.sqlite3")
            today = datetime.now(UTC).date()
            first = today - timedelta(days=3)
            request = query(first, first + timedelta(days=2))
            async def fetch(_app, path, request_started=None):
                if request_started:
                    request_started.set()
                if path.endswith(first.isoformat()):
                    raise service.FIRMSFailure("FIRMS request failed or timed out.")
                return HEADER
            with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=AsyncMock(side_effect=fetch)):
                result = await service.shared_firms_store(app, request, (0, 0, 3, 3))
                self.assertEqual({record.state for record in result.coverage}, {"partial", "complete"})
                summary = overview_document(request, result)
                self.assertEqual(summary["meta"]["completeness"], "partial")
                self.assertLessEqual(result.expires_at - time.time(), 30)
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory)))


class AnalysisMapContractTest(unittest.TestCase):
    def make_store(self, rows):
        return CanonicalStore(tuple(rows), (Coverage(date(2026, 11, 1), "aqua", "complete"),), "isolated test fixture")

    def test_all_600_records_have_stable_full_precision_ids_and_optional_dimensions(self):
        acquired = datetime(2026, 11, 1, 12, tzinfo=UTC)
        rows = [Detection("aqua", 0.5, 0.5 + index / 1_000_000, acquired, None, None, None, None, 1.2, 1.1, 1000) for index in range(600)]
        result = map_source_document(query("2026-11-01", "2026-11-02"), self.make_store(rows))
        features = result["data"]["data"]["features"]
        self.assertEqual(len(features), 600)
        self.assertEqual(len({feature["id"] for feature in features}), 600)
        self.assertEqual(features[0]["properties"]["dayNight"], "unknown")
        self.assertIsNone(features[0]["properties"]["confidence"]["value"])
        self.assertIsNone(features[0]["properties"]["frpMw"])
        self.assertEqual(features[0]["properties"]["nominalResolutionM"], 1000)
        self.assertEqual(features[0]["properties"]["scanKm"], 1.2)
        self.assertEqual(features[0]["id"], detection_id(rows[0]))

    def test_exact_time_boundary_holes_islands_and_antimeridian(self):
        acquired = datetime(2026, 11, 1, 12, tzinfo=UTC)
        region = {"type": "MultiPolygon", "coordinates": [
            [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
            [[[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]]],
            [[[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]],
        ]}
        rows = [Detection("aqua", lat, lon, acquired, 20, None, 80, "D") for lon, lat in [(0, 1), (1.5, 1.5), (4, 1), (10.5, 0.5), (179.5, 0), (-179.5, 0)]]
        request = query("2026-11-01", "2026-11-02")
        request["aoi"]["geometry"] = region
        request["interval"]["start"] = "2026-11-01T12:00:00Z"
        request["interval"]["endExclusive"] = "2026-11-01T12:01:00Z"
        features = map_source_document(request, self.make_store(rows))["data"]["data"]["features"]
        self.assertEqual(len(features), 4)
        request["interval"]["endExclusive"] = "2026-11-01T12:00:00Z"
        request["interval"]["start"] = "2026-11-01T11:59:00Z"
        self.assertEqual(map_source_document(request, self.make_store(rows))["data"]["data"]["features"], [])

    def test_day_summaries_and_limit_are_explicit(self):
        row = Detection("aqua", 0.5, 0.5, datetime(2026, 11, 1, 12, tzinfo=UTC), 20, None, 80, "D")
        store = self.make_store([row])
        result = overview_document(query("2026-11-01", "2026-11-02"), store)
        self.assertEqual(result["data"]["daily"][0]["detectionCount"], 1)
        self.assertEqual(result["data"]["daily"][0]["medianFrp"], 20)
        with patch("harmonize.kept_detections", return_value=[None] * 100_001):
            with self.assertRaisesRegex(RejectedQuery, "100,000"):
                map_source_document(query("2026-11-01", "2026-11-02"), store)

    def test_response_freshness_uses_acquisition_and_exact_selected_observations(self):
        from fastapi.testclient import TestClient
        old = datetime(2026, 11, 1, 12, tzinfo=UTC)
        rows = [
            Detection("aqua", 0.5, 0.5, old, 20, None, 80, "D"),
            Detection("aqua", 2.5, 2.5, old + timedelta(hours=2), 20, None, 80, "D"),
            Detection("aqua", 0.5, 0.5, old + timedelta(hours=3), 20, None, 10, "D"),
        ]
        now = time.time()
        store = replace(self.make_store(rows), fetched_at=now - 100, expires_at=now + 200, cache_hit=True)
        request = query("2026-11-01", "2026-11-02", modisConfidenceMin=50)
        request["aoi"]["geometry"] = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        with patch("app.store_from_environment", return_value=store), TestClient(service.app) as client:
            response = client.post("/analysis/map-source", json={"query": request})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["meta"]["newestObservationAt"], old.isoformat().replace("+00:00", "Z"))
        self.assertEqual(body["meta"]["freshness"], "fresh")
        self.assertNotEqual(body["meta"]["generatedAt"], body["meta"]["fetchedAt"])
        self.assertEqual(body["meta"]["methodVersion"], "afternoon-active-cells-2km-1")
        self.assertEqual(body["meta"]["processingTier"], "firms-active-fire")
        self.assertEqual(len(body["data"]["data"]["features"]), 1)

    def test_missing_viirs_confidence_does_not_change_harmonized_method(self):
        row = Detection("suomi-npp", 0.5, 0.5, datetime(2026, 11, 1, 12, tzinfo=UTC), None, None, None, None)
        store = CanonicalStore((row,), (Coverage(date(2026, 11, 1), "suomi-npp", "complete"),), "isolated test fixture")
        request = query("2026-11-01", "2026-11-02", platforms=["suomi-npp"])
        self.assertEqual(calendar_document(request, store)["data"][0]["count"], 0)
        features = map_source_document(request, store)["data"]["data"]["features"]
        self.assertEqual(len(features), 1)
        self.assertIsNone(features[0]["properties"]["confidence"]["value"])


if __name__ == "__main__":
    unittest.main()
