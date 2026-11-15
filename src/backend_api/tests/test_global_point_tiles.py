
import concurrent.futures
import gzip
import json
import math
import os
import sys
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from global_point_tiles import GlobalPointPresentation, POINT_EXTENT, PointTileTooLarge, point_cache_statistics
from global_store import GlobalStore
from global_tiles import GlobalPresentation, SnapshotUnavailable
from harmonize import Detection, RejectedQuery

ANCHOR = datetime(2026, 11, 15, 13, tzinfo=UTC)


def observation(index=0, longitude=.0001, latitude=.0001, power=20., hours=1):
    return Detection("aqua", latitude, longitude, ANCHOR - timedelta(hours=hours, seconds=index),
                     power, None, 80, "D", 1.1, 1.3, 1000, "MODIS_NRT", "v1", "NRT")


def publish(store, rows):
    store.replace_source("MODIS_NRT", rows, ANCHOR - timedelta(days=7), ANCHOR, ANCHOR.timestamp())
    return store.publish(ANCHOR, ["MODIS_NRT"], ANCHOR.timestamp())["snapshot"]


def varint(data, offset):
    value = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
        shift += 7


def fields(data):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire == 2:
            length, offset = varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        else:
            raise AssertionError(f"Unexpected protobuf wire type {wire}")
        yield field, value


def packed(data):
    output, offset = [], 0
    while offset < len(data):
        value, offset = varint(data, offset)
        output.append(value)
    return output


def decode_points(body):
    
    layers = []
    for number, layer in fields(body):
        if number != 3:
            continue
        keys, values, features = [], [], []
        result = {}
        for field, value in fields(layer):
            if field == 15:
                result["version"] = value
            elif field == 1:
                result["name"] = value.decode()
            elif field == 2:
                features.append(dict(fields(value)))
            elif field == 3:
                keys.append(value.decode())
            elif field == 4:
                values.append(dict(fields(value))[1].decode())
            elif field == 5:
                result["extent"] = value
        output = []
        for feature in features:
            tags = packed(feature[2])
            properties = {keys[tags[index]]: values[tags[index + 1]] for index in range(0, len(tags), 2)}
            commands = packed(feature[4])
            command, coordinates = commands[0], commands[1:]
            if command & 7 != 1 or len(coordinates) != 2 * (command >> 3):
                raise AssertionError("Expected only Point MoveTo geometry")
            points, x, y = [], 0, 0
            for index in range(0, len(coordinates), 2):
                dx, dy = coordinates[index:index + 2]
                x += (dx >> 1) ^ -(dx & 1)
                y += (dy >> 1) ^ -(dy & 1)
                points.append((x, y))
            output.append({"id": feature[1], "type": feature[3], "properties": properties, "points": points})
        result["features"] = output
        layers.append(result)
    if len(layers) != 1:
        raise AssertionError("Expected exactly one MVT layer")
    return layers[0]


class GlobalPointTileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = GlobalStore(Path(directory.name) / "observations.sqlite")
        self.service = GlobalPointPresentation(self.store)

    def test_every_record_individual_at_world_and_dense_close_zoom(self):
        snapshot = publish(self.store, [observation(index, longitude=.0001 + index * .00000001)
                                        for index in range(1600)])
        identities = None
        for zoom, x, y in ((0, 0, 0), (12, 2048, 2047)):
            body, compressed, digest, metrics = self.service.tile(snapshot, "24h", zoom, x, y)
            layer = decode_points(body)
            self.assertEqual(gzip.decompress(compressed), body)
            self.assertEqual(layer["name"], "observations")
            self.assertEqual(layer["version"], 2)
            self.assertEqual(layer["extent"], POINT_EXTENT)
            self.assertEqual(len(layer["features"]), 1600)
            self.assertEqual(metrics["observations"], 1600)
            self.assertTrue(all(feature["type"] == 1 and feature["properties"] == {"severity": "moderate"}
                                for feature in layer["features"]))
            current = {feature["id"] for feature in layer["features"]}
            self.assertEqual(len(current), 1600)
            if identities is not None:
                self.assertEqual(current, identities)
            identities = current
            self.assertEqual(self.service.tile(snapshot, "24h", zoom, x, y)[2], digest)

    def test_frp_and_coincident_satellites_preserve_separate_native_ids(self):
        rows = [observation(index, power=power) for index, power in enumerate((None, -1, 0, 9.99, 10, 49.99, 50))]
        rows.append(replace(rows[0], platform="terra"))
        snapshot = publish(self.store, rows)
        features = decode_points(self.service.tile(snapshot, "24h", 0, 0, 0)[0])["features"]
        self.assertEqual(len({feature["id"] for feature in features}), 8)
        self.assertEqual([feature["properties"]["severity"] for feature in features].count("unknown"), 3)
        with closing(self.store.connect()) as db:
            powers = dict(db.execute("SELECT id,frp FROM global_observations"))
        expected = {None: "unknown", -1: "unknown", 0: "low", 9.99: "low", 10: "moderate", 49.99: "moderate", 50: "high"}
        for feature in features:
            self.assertEqual(feature["properties"]["severity"], expected[powers[feature["id"]]])

    def test_coordinates_not_cell_centers_and_utc_bounds(self):
        rows = [observation(longitude=17.123456, latitude=54.987654, hours=24),
                observation(1, hours=24), observation(hours=0)]
        snapshot = publish(self.store, rows)
        layer = decode_points(self.service.tile(snapshot, "24h", 0, 0, 0)[0])
        self.assertEqual(len(layer["features"]), 1)
        point = layer["features"][0]["points"][0]
        self.assertLessEqual(abs(point[0] / POINT_EXTENT * 360 - 180 - rows[0].longitude), 180 / POINT_EXTENT)
        expected_y = (1 - math.asinh(math.tan(math.radians(rows[0].latitude))) / math.pi) / 2
        self.assertLessEqual(abs(point[1] / POINT_EXTENT - expected_y), .5 / POINT_EXTENT)

    def test_dateline_buffers_tile_seams_and_polar_extent(self):
        rows = [observation(index, longitude=longitude, latitude=latitude)
                for index, (longitude, latitude) in enumerate(((-180, 0), (180, 0), (-179.99, 0),
                                                              (179.99, 0), (-.00001, .00001), (0, 0), (10, 89)))]
        snapshot = publish(self.store, rows)
        world = decode_points(self.service.tile(snapshot, "24h", 0, 0, 0)[0])["features"]
        self.assertEqual(len(world), 6)
        self.assertEqual(sum(len(feature["points"]) == 2 for feature in world), 4)
        ids, owners = set(), 0
        for x in range(2):
            for y in range(2):
                body, _gzip, _digest, metrics = self.service.tile(snapshot, "24h", 1, x, y)
                ids.update(feature["id"] for feature in decode_points(body)["features"])
                owners += metrics["observations"]
        self.assertEqual(ids, {feature["id"] for feature in world})
        self.assertEqual(owners, 6)
        self.assertEqual(GlobalPresentation(self.store).manifest()["polarCount"], 1)

    def test_frozen_filters_snapshot_identity_and_expiry(self):
        first = publish(self.store, [observation(index, power=index % 100) for index in range(1500)])
        grouped = json.loads(GlobalPresentation(self.store).tile(first, "24h", 0, 0, 0, {"frpMin": 50})[0])
        group = next(feature["properties"]["aggregateId"] for feature in grouped["features"] if feature["properties"]["kind"] == "aggregate")
        body = self.service.tile(first, "24h", 0, 0, 0, {"frpMax": 60}, group)[0]
        self.assertEqual(len(decode_points(body)["features"]), 165)
        second = publish(self.store, [observation()])
        self.assertNotEqual(first, second)
        self.assertEqual(self.service.tile(first, "24h", 0, 0, 0, {"frpMax": 60}, group)[0], body)
        with self.assertRaises(RejectedQuery):
            self.service.tile(second, "24h", 0, 0, 0, aggregate=group)
        with closing(self.store.connect()) as db, db:
            db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (first,))
        with self.assertRaises(SnapshotUnavailable):
            self.service.tile(first, "24h", 0, 0, 0, {"frpMax": 60}, group)

    def test_empty_tile_and_explicit_byte_budget_failure(self):
        snapshot = publish(self.store, [observation(index) for index in range(100)])
        self.assertEqual(decode_points(self.service.tile(snapshot, "24h", 0, 0, 0, {"platform": "terra"})[0])["features"], [])
        with patch.dict(os.environ, {"SHARP_GLOBAL_POINT_TILE_MAX_BYTES": "1024"}):
            with self.assertRaisesRegex(PointTileTooLarge, "No records were sampled or omitted"):
                self.service.tile(snapshot, "24h", 0, 0, 0)
        with self.assertRaises(RejectedQuery):
            self.service.tile(snapshot, "24h", 0, 0, 0, filters=[])
        with self.assertRaises(RejectedQuery):
            self.service.tile(snapshot, "24h", 1, 2, 0)

    def test_snapshot_pruned_between_scope_validation_and_build_returns_expired(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from global_routes import register_global_routes
        snapshot = publish(self.store, [observation(index) for index in range(4)])
        original_base = self.service._base

        def prune_after_validation(*args, **kwargs):
            scope = original_base(*args, **kwargs)
            with closing(self.store.connect()) as db, db:
                db.execute("DELETE FROM global_snapshot_observations WHERE snapshot=?", (snapshot,))
                db.execute("DELETE FROM global_snapshots WHERE snapshot=?", (snapshot,))
            return scope

        with patch.object(self.service, "_base", side_effect=prune_after_validation):
            with self.assertRaisesRegex(SnapshotUnavailable, "expired before"):
                self.service.tile(snapshot, "24h", 0, 0, 0)
        app = FastAPI()
        app.state.global_store = self.store
        register_global_routes(app)
        with TestClient(app) as client:
            response = client.get(f"/global/point-tiles/{snapshot}/24h/0/0/0.pbf")
            self.assertEqual(response.status_code, 410)
            self.assertEqual(response.json()["status"], "unavailable")

    def test_prune_after_read_version_pinned_preserves_complete_membership(self):
        snapshot = publish(self.store, [observation(index) for index in range(4)])
        original_connect = self.store.connect
        was_pruned = []

        class PruneAfterExistenceRead:
            def __init__(self):
                self.connection = original_connect()

            def execute(self, statement, parameters=()):
                cursor = self.connection.execute(statement, parameters)
                if statement.startswith("SELECT 1 FROM global_snapshots"):
                    
                    
                    with closing(original_connect()) as writer, writer:
                        writer.execute("DELETE FROM global_snapshot_observations WHERE snapshot=?", (snapshot,))
                        writer.execute("DELETE FROM global_snapshots WHERE snapshot=?", (snapshot,))
                    was_pruned.append(True)
                return cursor

            def close(self):
                self.connection.close()

        with patch.object(self.store, "connect", side_effect=PruneAfterExistenceRead):
            body = self.service.tile(snapshot, "24h", 0, 0, 0)[0]
        self.assertTrue(was_pruned)
        self.assertEqual(len(decode_points(body)["features"]), 4)
        with self.assertRaises(SnapshotUnavailable):
            self.service.tile(snapshot, "24h", 0, 0, 0)

    def test_manifest_http_cache_and_concurrent_reads_without_upstream(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from global_routes import register_global_routes
        snapshot = publish(self.store, [observation(index) for index in range(100)])
        app = FastAPI()
        app.state.global_store = self.store
        register_global_routes(app)
        with TestClient(app) as client, patch("httpx.AsyncClient.send", side_effect=AssertionError("NASA acquisition forbidden")):
            manifest = client.get("/global/manifest").json()
            self.assertEqual(manifest["pointSourceLayer"], "observations")
            self.assertEqual(manifest["pointExtent"], POINT_EXTENT)
            url = manifest["pointTiles"].removeprefix("/firms-api").replace("{z}", "0").replace("{x}", "0").replace("{y}", "0")
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                responses = list(pool.map(lambda _: client.get(url), range(100)))
            self.assertTrue(all(response.status_code == 200 for response in responses))
            self.assertTrue(all(len(decode_points(response.content)["features"]) == 100 for response in responses))
            response = responses[0]
            self.assertEqual(response.headers["content-type"], "application/vnd.mapbox-vector-tile")
            self.assertEqual(response.headers["content-encoding"], "gzip")
            self.assertEqual(response.headers["x-snapshot-id"], snapshot)
            self.assertIn("immutable", response.headers["cache-control"])
            self.assertEqual(client.get(url, headers={"If-None-Match": response.headers["etag"]}).status_code, 304)
            plain = client.get(url, headers={"Accept-Encoding": "identity"})
            self.assertEqual(plain.content, response.content)
            self.assertNotEqual(plain.headers["etag"], response.headers["etag"])
            self.assertEqual(client.get(url, params={"filters": "[]"}).status_code, 422)
            with patch.dict(os.environ, {"SHARP_GLOBAL_POINT_TILE_MAX_BYTES": "1024"}):
                self.assertEqual(client.get(url).status_code, 413)
        self.assertLessEqual(point_cache_statistics()["bytes"], 32 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
