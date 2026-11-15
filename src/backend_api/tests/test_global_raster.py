
import concurrent.futures
import os
import struct
import sys
import tempfile
import unittest
import zlib
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from global_raster import GlobalRasterPresentation, RASTER_SIZE, RASTER_STYLE, prewarm_global_raster, raster_cache_statistics
from global_store import GlobalStore
from global_tiles import GlobalPresentation, SnapshotUnavailable
from harmonize import RejectedQuery
from test_global_point_tiles import observation, publish


def rgba(body):
    if body[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError("Expected a real PNG signature")
    offset, compressed = 8, bytearray()
    while offset < len(body):
        length = struct.unpack(">I", body[offset:offset + 4])[0]
        name = body[offset + 4:offset + 8]
        payload = body[offset + 8:offset + 8 + length]
        checksum = struct.unpack(">I", body[offset + 8 + length:offset + 12 + length])[0]
        if zlib.crc32(name + payload) != checksum:
            raise AssertionError("PNG checksum mismatch")
        if name == b"IHDR":
            if struct.unpack(">IIBBBBB", payload) != (512, 512, 8, 6, 0, 0, 0):
                raise AssertionError("Expected a 512 RGBA PNG")
        elif name == b"IDAT":
            compressed.extend(payload)
        offset += length + 12
    pixels = zlib.decompress(compressed)
    stride = 512 * 4 + 1
    if len(pixels) != stride * 512 or any(pixels[y * stride] for y in range(512)):
        raise AssertionError("Expected unfiltered fixed-size PNG rows")
    return b"".join(pixels[y * stride + 1:(y + 1) * stride] for y in range(512))


def pixel(pixels, x, y):
    offset = (y * RASTER_SIZE + x) * 4
    return pixels[offset:offset + 4]


class GlobalRasterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = GlobalStore(Path(directory.name) / "observations.sqlite")
        self.service = GlobalRasterPresentation(self.store)

    def tile(self, snapshot, z=0, x=0, y=0, filters=None, aggregate=None):
        return self.service.tile(snapshot, "24h", RASTER_STYLE, z, x, y, filters, aggregate)

    def test_png_transparency_exact_positions_solid_red_and_unknown_frp_retained(self):
        snapshot = publish(self.store, [observation(0, 0, 0, power=None), observation(1, 120, 0, power=5), observation(2, -120, 0, power=100)])
        body, _etag, metrics = self.tile(snapshot)
        pixels = rgba(body)
        self.assertEqual(metrics["observations"], 3)
        self.assertEqual(metrics["visitedRecords"], 3)
        self.assertEqual(pixel(pixels, 255, 255), b"\xff\x00\x00\xff")
        self.assertEqual(pixel(pixels, 256, 256), b"\xff\x00\x00\xff")
        self.assertEqual(pixel(pixels, 427, 256), b"\xff\x00\x00\xff")
        self.assertEqual(pixel(pixels, 84, 255), b"\xff\x00\x00\xff")
        self.assertEqual(pixel(pixels, 10, 10), b"\x00\x00\x00\x00")
        self.assertEqual(sum(pixels[index] > 0 for index in range(3, len(pixels), 4)), 48)
        self.assertTrue(all(pixel(pixels, x, y) in (b"\xff\x00\x00\xff", b"\x00\x00\x00\x00") for y in range(512) for x in range(512)))

    def test_dense_records_are_all_processed_without_sampling_or_symbol_limits(self):
        snapshot = publish(self.store, [observation(index, longitude=.0001, latitude=.0001) for index in range(40_000)])
        body, _digest, metrics = self.tile(snapshot)
        self.assertEqual(metrics["observations"], 40_000)
        self.assertEqual(metrics["visitedRecords"], 40_000)
        self.assertTrue(any(rgba(body)[3::4]))

    def test_zero_is_valid_transparent_png_and_utc_interval_is_exclusive(self):
        snapshot = publish(self.store, [observation(hours=24), observation(1, hours=24), observation(hours=0)])
        self.assertEqual(self.tile(snapshot)[2]["observations"], 1)
        empty = self.tile(snapshot, filters={"platform": "terra"})
        self.assertEqual(empty[2]["observations"], 0)
        self.assertFalse(any(rgba(empty[0])))

    def test_zoom_specific_crisp_display_marks_do_not_fabricate_footprints(self):
        snapshot = publish(self.store, [observation(longitude=0, latitude=0)])
        overview = self.tile(snapshot)
        detail = self.tile(snapshot, 4, 8, 8)
        self.assertEqual(overview[2]["pixelSize"], 4)
        self.assertEqual(detail[2]["pixelSize"], 4)
        self.assertEqual(sum(value > 0 for value in rgba(detail[0])[3::4]), 4)
        self.assertEqual(self.tile(snapshot, 13, 4096, 4096)[2]["pixelSize"], 14)
        self.assertEqual(pixel(rgba(detail[0]), 0, 0), b"\xff\x00\x00\xff")

    def test_antimeridian_buffering_seam_ownership_and_polar_extent(self):
        snapshot = publish(self.store, [observation(0, -180, 0), observation(1, 180, 0), observation(2, 0, 0), observation(3, 10, 89)])
        self.assertEqual(self.tile(snapshot)[2]["observations"], 3)
        world = rgba(self.tile(snapshot)[0])
        self.assertEqual(pixel(world, 0, 255), b"\xff\x00\x00\xff")
        self.assertEqual(pixel(world, 511, 255), b"\xff\x00\x00\xff")
        owners = sum(self.tile(snapshot, 1, x, y)[2]["observations"] for x in range(2) for y in range(2))
        self.assertEqual(owners, 3)
        self.assertEqual(GlobalPresentation(self.store).manifest()["polarCount"], 1)

    def test_filters_and_frozen_membership_intersect_and_keep_snapshot_generation(self):
        first = publish(self.store, [observation(index, power=index % 100) for index in range(1500)])
        import json
        grouped = json.loads(GlobalPresentation(self.store).tile(first, "24h", 0, 0, 0, {"frpMin": 50})[0])
        group = next(feature["properties"]["aggregateId"] for feature in grouped["features"] if feature["properties"]["kind"] == "aggregate")
        frozen = self.tile(first, filters={"frpMax": 60}, aggregate=group)
        self.assertEqual(frozen[2]["observations"], 165)
        second = publish(self.store, [observation()])
        self.assertEqual(self.tile(first, filters={"frpMax": 60}, aggregate=group), frozen)
        with self.assertRaises(RejectedQuery):
            self.tile(second, aggregate=group)

    def test_snapshot_pruned_before_build_is_expired_not_successful_empty(self):
        snapshot = publish(self.store, [observation()])
        original = self.service._base
        def prune(*args, **kwargs):
            scope = original(*args, **kwargs)
            with closing(self.store.connect()) as db, db:
                db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (snapshot,))
                db.execute("DELETE FROM global_snapshot_observations WHERE snapshot=?", (snapshot,))
            return scope
        with patch.object(self.service, "_base", side_effect=prune):
            with self.assertRaisesRegex(SnapshotUnavailable, "expired before"):
                self.tile(snapshot)

    def test_snapshot_prune_after_transaction_pinning_retains_complete_old_records(self):
        snapshot = publish(self.store, [observation(index) for index in range(4)])
        original = self.store.connect
        class ReadVersion:
            def __init__(self): self.connection = original()
            def execute(self, statement, parameters=()):
                cursor = self.connection.execute(statement, parameters)
                if statement.startswith("SELECT 1 FROM global_snapshots"):
                    with closing(original()) as db, db:
                        db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (snapshot,))
                        db.execute("DELETE FROM global_snapshot_observations WHERE snapshot=?", (snapshot,))
                return cursor
            def close(self): self.connection.close()
        with patch.object(self.store, "connect", side_effect=ReadVersion):
            self.assertEqual(self.tile(snapshot)[2]["observations"], 4)
        with self.assertRaises(SnapshotUnavailable): self.tile(snapshot)

    def test_concurrent_visitors_share_one_local_render_and_overview_prewarm(self):
        snapshot = publish(self.store, [observation(index) for index in range(100)])
        with patch.object(self.service, "_build", wraps=self.service._build) as build:
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                results = list(pool.map(lambda _: self.tile(snapshot), range(100)))
            self.assertEqual(build.call_count, 1)
        self.assertTrue(all(result[0] == results[0][0] for result in results))
        self.assertEqual(prewarm_global_raster(self.store, snapshot)["tiles"], 5)
        statistics = raster_cache_statistics()
        self.assertLessEqual(statistics["bytes"], 32 * 1024 * 1024)
        self.assertLessEqual(statistics["entries"], 256)
        self.assertLessEqual(statistics["peakRendering"], 2)

    def test_http_png_manifest_conditional_cache_and_expiry_never_acquire(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from global_routes import register_global_routes
        snapshot = publish(self.store, [observation()])
        app = FastAPI()
        app.state.global_store = self.store
        register_global_routes(app)
        with TestClient(app) as client, patch("httpx.AsyncClient.send", side_effect=AssertionError("NASA acquisition forbidden")):
            manifest = client.get("/global/manifest").json()
            self.assertEqual(manifest["rasterTileSize"], 512)
            self.assertEqual(manifest["rasterStyle"], RASTER_STYLE)
            url = manifest["rasterTiles"].removeprefix("/firms-api").replace("{z}", "0").replace("{x}", "0").replace("{y}", "0")
            response = client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/png")
            self.assertNotIn("content-encoding", response.headers)
            self.assertIn("immutable", response.headers["cache-control"])
            self.assertEqual(response.headers["x-observation-count"], "1")
            self.assertTrue(any(rgba(response.content)))
            self.assertEqual(client.get(url, headers={"If-None-Match": response.headers["etag"]}).status_code, 304)
            self.assertEqual(client.get(url, params={"filters": "[]"}).status_code, 422)
            self.assertEqual(client.get(url.replace(RASTER_STYLE, "bad-style")).status_code, 422)
            with closing(self.store.connect()) as db, db:
                db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (snapshot,))
            self.assertEqual(client.get(url).status_code, 410)


if __name__ == "__main__":
    unittest.main()
