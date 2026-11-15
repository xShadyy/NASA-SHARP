import os
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
"""Synthetic fixtures exercise durable global presentation without NASA calls."""
import asyncio
import concurrent.futures
import gzip
import json
import math
import os
import sys
import tempfile
import time
import tracemalloc
import unittest
from types import SimpleNamespace
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from global_store import GlobalStore
from global_tiles import GlobalPresentation, MERCATOR_LIMIT, MAX_TILE_FEATURES, cache_statistics
from harmonize import Detection, RejectedQuery, detection_id

ANCHOR = datetime(2026, 11, 15, 13, tzinfo=UTC)


def row(index=0, lon=10., lat=10., hours=1, power=20., platform="aqua"):
    return Detection(platform, lat, lon, ANCHOR - timedelta(hours=hours, seconds=index), power,
                     "high" if platform != "aqua" else None, 80 if platform == "aqua" else None,
                     "D", 1.1, 1.3, 1000 if platform == "aqua" else 375, "MODIS_NRT", "v1", "NRT")


def fixture(store, rows):
    store.replace_source("MODIS_NRT", rows, ANCHOR - timedelta(days=7), ANCHOR, ANCHOR.timestamp())
    return store.publish(ANCHOR, ["MODIS_NRT"], ANCHOR.timestamp())


class GlobalPresentationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = GlobalStore(Path(self.directory.name) / "global.sqlite")
        self.service = GlobalPresentation(self.store)

    def test_empty_manifest_explicitly_unavailable(self):
        self.assertEqual(self.service.manifest()["status"], "unavailable")
        self.assertIsNone(self.service.manifest()["count"])

    def test_rolling_windows_exact_anchor_and_restart_preserves_snapshot(self):
        published = fixture(self.store, [row(hours=.5), row(1, hours=25), row(2, hours=100)])
        snapshot = published["snapshot"]
        self.assertEqual(self.service.manifest("24h")["count"], 1)
        self.assertEqual(self.service.manifest("48h")["count"], 2)
        self.assertEqual(self.service.manifest("7d")["count"], 3)
        self.assertEqual(self.service.manifest()["interval"]["endExclusive"], "2026-11-15T13:00:00Z")
        restarted = GlobalPresentation(GlobalStore(self.store.path))
        self.assertEqual(restarted.manifest()["snapshotId"], snapshot)

    def test_tile_seams_wrap_poles_and_aggregate_max_valid_frp(self):
        rows = [row(0, -180, 0, power=None), row(1, 180, 0, power=None), row(2, -.0000001, 0, power=5), row(3, 0, 0, power=50), row(4, .000001, 0, power=10), row(5, 10, 89, power=100)]
        snapshot = fixture(self.store, rows)["snapshot"]
        manifest = self.service.manifest()
        self.assertEqual(manifest["count"], 6)
        self.assertEqual(manifest["polarCount"], 1)
        self.assertEqual(manifest["renderingExtent"][3], MERCATOR_LIMIT)
        represented = 0
        for x in range(2):
            for y in range(2):
                body, compressed, _etag, _metrics = self.service.tile(snapshot, "24h", 1, x, y)
                self.assertEqual(gzip.decompress(compressed), body)
                tile = json.loads(body)
                represented += sum(f["properties"]["count"] for f in tile["features"])
                for feature in tile["features"]:
                    if feature["properties"]["kind"] == "aggregate":
                        data = self.service.observations(snapshot, "24h", feature["properties"]["aggregateId"])["data"]
                        self.assertEqual(data["total"], feature["properties"]["count"])
                        self.assertEqual(data["summary"]["maxFrpMw"], feature["properties"]["frpMw"])
        self.assertEqual(represented, 5)

    def test_global_search_sort_unknown_filters_and_grouping_before_pages(self):
        snapshot = fixture(self.store, [row(i, 10 + i * .000001, 10, power=None if i % 2 else float(i)) for i in range(650)])["snapshot"]
        data = self.service.observations(snapshot, "24h", options={"sort": "frp", "pageSize": 10})["data"]
        self.assertEqual(data["total"], 650)
        self.assertEqual(data["rows"][0]["frpMw"], 648)
        next_page = self.service.observations(snapshot, "24h", options={"sort": "frp", "pageSize": 10, "page": 2})["data"]
        self.assertLess(next_page["rows"][0]["frpMw"], data["rows"][-1]["frpMw"])
        found = self.service.observations(snapshot, "24h", options={"search": data["rows"][0]["id"]})["data"]
        self.assertEqual(found["total"], 1)
        unknown = self.service.observations(snapshot, "24h", options={"frpUnknown": True, "groupBy": "hour"})["data"]
        self.assertEqual(unknown["total"], 325)
        self.assertTrue(all(record["frpMw"] is None for record in unknown["rows"]))
        self.assertEqual(sum(group["count"] for group in unknown["groups"]), 325)
        self.assertIn("2026", unknown["groups"][0]["label"])

    def test_snapshot_membership_stays_frozen_and_export_complete(self):
        rows = [row(i, 10 + i * .000001, 10) for i in range(1500)]
        first = fixture(self.store, rows)["snapshot"]
        tile = json.loads(self.service.tile(first, "24h", 0, 0, 0)[0])
        group = next(feature["properties"]["aggregateId"] for feature in tile["features"] if feature["properties"]["kind"] == "aggregate")
        second = fixture(self.store, rows[:2])["snapshot"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.service.observations(first, "24h", group)["data"]["total"], 1500)
        with self.assertRaises(RejectedQuery): self.service.observations(second, "24h", group)
        stream, count = self.service.export(first, "24h", group, {"pageSize": 10}, "geojson")
        exported = json.loads("".join(stream))
        self.assertEqual(count, 1500)
        self.assertEqual(len(exported["features"]), 1500)
        self.assertEqual(exported["reproducibility"]["snapshotId"], first)

    def test_dense_close_zoom_aggregates_without_truncation_and_filtered_counts_match(self):
        rows = [row(i, .0001 + i * .00000001, .0001, power=float(i % 100)) for i in range(1200)]
        snapshot = fixture(self.store, rows)["snapshot"]
        tile = json.loads(self.service.tile(snapshot, "24h", 12, 2048, 2047, {"frpMin": 50})[0])
        self.assertLessEqual(len(tile["features"]), MAX_TILE_FEATURES)
        self.assertEqual(sum(f["properties"]["count"] for f in tile["features"]), 600)
        tile = json.loads(self.service.tile(snapshot, "24h", 12, 2048, 2047)[0])
        self.assertEqual(sum(f["properties"]["count"] for f in tile["features"]), 1200)
        self.assertTrue(any(f["properties"]["kind"] == "aggregate" for f in tile["features"]))

    def test_duplicate_product_revision_replaced_while_satellites_remain_distinct(self):
        original = row()
        self.store.replace_source("MODIS_NRT", [original], ANCHOR - timedelta(days=1), ANCHOR)
        revised = replace(original, source_product="MODIS_SP", processing_tier="SP", frp_mw=75)
        self.store.replace_source("MODIS_SP", [revised, replace(original, platform="terra")], ANCHOR - timedelta(days=1), ANCHOR)
        snapshot = self.store.publish(ANCHOR, ["MODIS_NRT", "MODIS_SP"])["snapshot"]
        data = self.service.observations(snapshot, "24h")["data"]
        self.assertEqual(data["total"], 2)
        self.assertEqual(next(r for r in data["rows"] if r["platform"] == "aqua")["frpMw"], 75)

    def test_http_local_tiles_and_100_concurrent_readers_never_acquire(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from global_routes import register_global_routes
        snapshot = fixture(self.store, [row(i) for i in range(100)])["snapshot"]
        app = FastAPI(); app.state.global_store = self.store; register_global_routes(app)
        with TestClient(app) as client:
            manifest = client.get("/global/manifest").json()
            self.assertEqual(manifest["snapshotId"], snapshot)
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                responses = list(pool.map(lambda _: client.get(f"/global/tiles/{snapshot}/24h/0/0/0.json"), range(100)))
            self.assertTrue(all(r.status_code == 200 for r in responses))
            self.assertTrue(all(r.json()["count"] == 100 for r in responses))
            etag = responses[0].headers["etag"]
            self.assertEqual(client.get(f"/global/tiles/{snapshot}/24h/0/0/0.json", headers={"If-None-Match": etag}).status_code, 304)
            response = client.post("/global/observations", json={"snapshotId": snapshot, "options": {"page": 2}})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["data"]["total"], 100)

    def test_aoi_reuses_complete_global_source_days_and_supplements_only_missing_source(self):
        import app as api
        fixture(self.store, [row(hours=25)])
        query = {"id": "global-aoi-reuse", "processingMode": "harmonized", "aoi": {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]]}},
                 "interval": {"start": "2026-11-14T00:00:00Z", "endExclusive": "2026-11-15T00:00:00Z"},
                 "filters": {"platforms": ["aqua", "noaa-20"], "dayNight": "all", "modisConfidenceMin": 0, "viirsConfidence": ["low", "nominal", "high"]}}
        application = SimpleNamespace(state=SimpleNamespace(global_store=self.store, key="not-an-upstream-key"))
        windows = {"MODIS_NRT": (ANCHOR.date() - timedelta(days=7), ANCHOR.date()), "VIIRS_NOAA20_NRT": (ANCHOR.date() - timedelta(days=7), ANCHOR.date())}
        upstream = AsyncMock(return_value=([], ANCHOR.timestamp(), False))
        with patch.object(api, "product_windows", new=AsyncMock(return_value=windows)), patch.object(api, "load_batch", new=upstream):
            stored = asyncio.run(api.firms_canonical_store(application, query, (0, 0, 20, 20)))
        self.assertEqual(upstream.await_count, 1)
        self.assertEqual(upstream.await_args.args[1], api.Source.VIIRS_NOAA20_NRT)
        self.assertEqual(upstream.await_args.args[3], ANCHOR.date() - timedelta(days=1))
        self.assertEqual(len(stored.rows), 1)
        query["filters"]["platforms"] = ["aqua"]
        no_availability = AsyncMock(side_effect=AssertionError("Fully stored AOI must not query NASA availability"))
        with patch.object(api, "product_windows", new=no_availability), patch.object(api, "load_batch", new=AsyncMock(side_effect=AssertionError("Unexpected acquisition"))):
            existing = asyncio.run(api.firms_canonical_store(application, query, (0, 0, 20, 20)))
        self.assertEqual(len(existing.rows), 1)

    def test_aoi_endpoint_exact_polygon_reuses_global_store_without_acquisition(self):
        import app as api
        from fastapi.testclient import TestClient
        fixture(self.store, [row(hours=25, lon=1, lat=1), row(1, hours=25, lon=9, lat=9)])
        query = {"id": "global-polygon", "processingMode": "harmonized", "aoi": {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [0, 10], [0, 0]]]}},
                 "interval": {"start": "2026-11-14T00:00:00Z", "endExclusive": "2026-11-15T00:00:00Z"},
                 "filters": {"platforms": ["aqua"], "dayNight": "all", "modisConfidenceMin": 0, "viirsConfidence": ["low", "nominal", "high"]}}
        with patch.dict(os.environ, {"FIRMS_MAP_KEY": "", "SHARP_GLOBAL_DB_PATH": str(self.store.path), "FIRMS_CACHE_PATH": str(Path(self.directory.name) / "cache.sqlite")}), patch.object(api, "store_from_environment", return_value=__import__('harmonize').CanonicalStore((), (), "empty")), patch.object(api, "shared_firms_store", new=AsyncMock(side_effect=AssertionError("Unexpected NASA acquisition"))), TestClient(api.app) as client:
            response = client.post("/analysis/observations", json={"query": query})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["data"]["total"], 1)

    def test_original_area_analytics_stream_reuses_global_source_without_map_key(self):
        import app as api
        from fastapi.testclient import TestClient
        fixture(self.store, [row(hours=25, lon=1, lat=1), row(1, hours=25, lon=9, lat=9)])
        geometry = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [0, 10], [0, 0]]]}
        with patch.dict(os.environ, {"FIRMS_MAP_KEY": "", "SHARP_GLOBAL_DB_PATH": str(self.store.path), "FIRMS_CACHE_PATH": str(Path(self.directory.name) / "cache.sqlite")}), patch.object(api, "fetch_csv", new=AsyncMock(side_effect=AssertionError("Original analytics must reuse durable source/day"))), TestClient(api.app) as client:
            response = client.post("/hotspots/stream", json={"geometry": geometry, "start_date": "2026-11-14", "days": 1, "source": ["MODIS_NRT"], "summary": True})
            self.assertEqual(response.status_code, 200, response.text)
            events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            result = next(event["data"] for event in events if event["type"] == "result")
            self.assertEqual(result["count"], 1)
            self.assertFalse(result["partial"])
            self.assertEqual(result["features"][0]["properties"]["source"], "MODIS_NRT")

    def test_missing_provenance_values_remain_unknown_in_global_records(self):
        unknown = replace(row(), product_version=None, processing_tier=None)
        snapshot = fixture(self.store, [unknown])["snapshot"]
        record = self.service.observations(snapshot, "24h")["data"]["rows"][0]
        self.assertIsNone(record["productVersion"])
        self.assertIsNone(record["processingTier"])

    def test_record_fixture_presentation_performance(self):
        rows = [row(i, -179 + (i % 360) * .99, -70 + (i % 140), hours=1 + i % 120, power=float(i % 100)) for i in range(15000)]
        snapshot = fixture(self.store, rows)["snapshot"]
        tracemalloc.start()
        measurements = {"kind": "synthetic local fixture, no NASA traffic or browser measurements", "observations": len(rows)}
        for label, window, zoom, x, y in (("worldwide24h", "24h", 0, 0, 0), ("worldwide7d", "7d", 0, 0, 0), ("regionalZoom", "7d", 5, 16, 16)):
            started = time.perf_counter(); result = self.service.tile(snapshot, window, zoom, x, y)
            cold = (time.perf_counter() - started) * 1000
            started = time.perf_counter(); self.service.tile(snapshot, window, zoom, x, y)
            measurements[label] = {**result[3], "coldMs": round(cold, 3), "warmMs": round((time.perf_counter() - started) * 1000, 3)}
        tile = json.loads(self.service.tile(snapshot, "7d", 0, 0, 0)[0])
        group = next((f["properties"].get("aggregateId") for f in tile["features"] if f["properties"].get("aggregateId")), None)
        started = time.perf_counter(); inspected = self.service.observations(snapshot, "7d", group)
        measurements["aggregateInspection"] = {"matchingCount": inspected["data"]["total"], "pageBytes": len(json.dumps(inspected)), "ms": round((time.perf_counter() - started) * 1000, 3)}
        previous = cache_statistics()
        started = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            list(pool.map(lambda _: self.service.tile(snapshot, "7d", 0, 0, 0), range(100)))
        after = cache_statistics()
        measurements["concurrentWarmReaders"] = {"requests": after["requests"] - previous["requests"], "cacheHits": after["hits"] - previous["hits"], "generatedTiles": after["generated"] - previous["generated"], "elapsedMs": round((time.perf_counter() - started) * 1000, 3), "kind": "100 local serving calls across 20 threads; HTTP integration separately tested; not browser load latency"}
        measurements["peakTracemallocBytes"] = tracemalloc.get_traced_memory()[1]; tracemalloc.stop()
        measurements.update(estimatedUpstreamTransactions=0, actualUpstreamRequests=0, browserMemory=None, navigationFrameTimes=None)
        target = Path(self.directory.name) / "benchmark-global-results.json"
        target.write_text(json.dumps(measurements, indent=2), encoding="utf-8")
        print("\nGlobal presentation fixture timings: " + json.dumps(measurements))


if __name__ == "__main__": unittest.main()
