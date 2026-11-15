import os
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
"""Synthetic canonical fixtures verify complete investigation semantics."""
import asyncio
import csv
import io
import json
import os
import sys
import unittest
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harmonize import CanonicalStore, Coverage, Detection, detection_id
from observation_explorer import (
    SelectionInvalid, cached_snapshot, export_document, freeze_document,
    observations_document, remember_snapshot, source_generation,
)

AREA = {"type": "Polygon", "coordinates": [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]]}
QUERY = {"id": "test-full-query", "processingMode": "harmonized", "aoi": {"id": "region", "geometry": AREA},
    "interval": {"start": "2026-11-01T00:00:00Z", "endExclusive": "2026-11-05T00:00:00Z"},
    "filters": {"platforms": ["aqua", "noaa-20"], "dayNight": "all", "modisConfidenceMin": 0,
        "viirsConfidence": ["low", "nominal", "high"]}}


def fixture(count=620):
    rows = tuple(Detection(
        "aqua" if index % 2 else "noaa-20", 0.5, 0.5 + index * 0.001,
        datetime(2026, 11, 1 + index % 4, 13, index % 60, tzinfo=UTC),
        None if index % 7 == 0 else float(index),
        (None if index % 11 == 0 else "high") if index % 2 == 0 else None,
        (None if index % 13 == 0 else index % 101) if index % 2 else None,
        None if index % 5 == 0 else "D" if index % 3 else "N",
        0.375, 0.5, 375, "rare-product" if index == 0 else "standard-product", "v1", "SP")
        for index in range(count))
    coverage = tuple(Coverage(date(2026, 11, day), platform, "complete")
        for day in range(1, 5) for platform in ("aqua", "noaa-20"))
    return CanonicalStore(rows, coverage, "synthetic test fixture", 1793491200, 9999999999, True)


async def stream_content(response):
    parts = []
    async for part in response.body_iterator:
        parts.append(part.decode() if isinstance(part, bytes) else part)
    return "".join(parts)


class ObservationExplorerTest(unittest.TestCase):
    def setUp(self):
        self.store = fixture()

    def query(self, options=None):
        return observations_document(QUERY, self.store, {"options": options or {}})

    def test_query_wide_search_finds_record_outside_old_sample(self):
        document = self.query({"search": "rare-product"})
        self.assertEqual(document["data"]["total"], 1)
        self.assertEqual(document["data"]["rows"][0]["id"], detection_id(self.store.rows[0]))
        self.assertEqual(self.query()["data"]["total"], 620)
        self.assertEqual(len(self.query()["data"]["rows"]), 25)
        self.assertEqual(self.query({"search": detection_id(self.store.rows[0])})["data"]["total"], 1)

    def test_global_stable_sort_across_pages(self):
        options = {"sort": "frp", "pageSize": 25}
        first = self.query(options)["data"]["rows"]
        second = self.query({**options, "page": 2})["data"]["rows"]
        values = [row["frpMw"] for row in first + second]
        self.assertEqual(values, sorted(values, reverse=True))
        all_rows = []
        for page in range(1, 8):
            all_rows.extend(self.query({"sort": "newest", "pageSize": 100, "page": page})["data"]["rows"])
        for left, right in zip(all_rows, all_rows[1:]):
            if left["acquiredAt"] == right["acquiredAt"]:
                self.assertLess(left["id"], right["id"])

    def test_filters_and_grouping_before_pagination(self):
        data = self.query({"groupBy": "hour", "pageSize": 10, "sensor": "VIIRS"})["data"]
        self.assertEqual(data["total"], 310)
        self.assertEqual(sum(group["count"] for group in data["groups"]), 310)
        self.assertEqual(len(data["groups"]), 2)
        self.assertIn("2026", data["groups"][0]["label"])
        self.assertNotEqual(data["groups"][0]["key"], data["groups"][1]["key"])
        self.assertTrue(all(row["sensor"] == "VIIRS" for row in data["rows"]))

    def test_unknown_native_metadata_preserved_and_filterable(self):
        data = self.query({"frpUnknown": True, "dayNight": "unknown", "viirsConfidence": ["unknown"]})["data"]
        self.assertGreater(data["total"], 0)
        for row in data["rows"]:
            self.assertIsNone(row["frpMw"])
            self.assertEqual(row["dayNight"], "unknown")
            self.assertEqual(row["confidence"], {"kind": "categorical", "value": None})
            self.assertEqual(row["sourceProduct"], "rare-product")
            self.assertEqual(row["productVersion"], "v1")

    def test_facets_use_native_conditions_and_partition_matching_rows(self):
        data = self.query()["data"]
        for name, buckets in data["summary"]["facets"].items():
            self.assertEqual(sum(bucket["count"] for bucket in buckets), data["total"], name)
            for bucket in buckets:
                matched = self.query(bucket["options"])["data"]["total"]
                self.assertEqual(matched, bucket["count"], (name, bucket))

    def test_exact_utc_start_inclusive_and_end_exclusive(self):
        instant = self.store.rows[0].acquired_at.isoformat().replace("+00:00", "Z")
        exclusive = (self.store.rows[0].acquired_at + timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
        document = self.query({"acquiredStart": instant, "acquiredEndExclusive": exclusive})
        self.assertGreater(document["data"]["total"], 0)
        self.assertTrue(all(row["acquiredAt"] == instant for row in document["data"]["rows"]))
        excluded = self.query({"acquiredEndExclusive": instant})
        self.assertEqual(excluded["data"]["total"], 0)

    def test_frozen_membership_ignores_camera_and_invalidates_source_changes(self):
        remember_snapshot(QUERY, self.store)
        ids = [detection_id(row) for row in self.store.rows[:10]]
        first = freeze_document(QUERY, self.store, {"options": {"observationIds": ids[:5]}})
        token = first["data"]["selectionToken"]
        second = freeze_document(QUERY, self.store, {"options": {"selectionToken": token, "observationIds": ids[5:]}})
        self.assertEqual(second["data"]["total"], 10)
        changed_camera = {**QUERY, "camera": {"zoom": 3}, "id": "new-client-query-id"}
        self.assertIs(cached_snapshot(changed_camera, {"selectionToken": token}), self.store)
        data = self.query({"selectionToken": token, "pageSize": 25})["data"]
        self.assertEqual({row["id"] for row in data["rows"]}, set(ids))
        replacement = replace(self.store, rows=(replace(self.store.rows[0], product_version="v2"), *self.store.rows[1:]))
        remember_snapshot(QUERY, replacement)
        with self.assertRaises(SelectionInvalid):
            cached_snapshot(QUERY, {"selectionToken": token})

    def test_generation_changes_with_metadata_not_cache_status(self):
        original = source_generation(self.store)
        self.assertEqual(source_generation(replace(self.store, fetched_at=123, cache_hit=False)), original)
        self.assertNotEqual(source_generation(replace(self.store, coverage=self.store.coverage[:-1])), original)
        self.assertNotEqual(source_generation(replace(self.store, rows=(replace(self.store.rows[0], frp_mw=15), *self.store.rows[1:]))), original)

    def test_complete_streamed_exports_exceed_sample_and_match_scope(self):
        for format_name in ("csv", "geojson", "json"):
            response = export_document(QUERY, self.store, {"format": format_name, "options": {"sort": "oldest"}})
            content = asyncio.run(stream_content(response))
            self.assertEqual(response.headers["X-Observation-Count"], "620")
            if format_name == "csv":
                rows = list(csv.DictReader(io.StringIO(content)))
                self.assertEqual(len(rows), 620)
                self.assertEqual({row["id"] for row in rows}, {detection_id(row) for row in self.store.rows})
                self.assertTrue(all(row["sourceGeneration"] for row in rows))
            else:
                document = json.loads(content)
                self.assertEqual(len(document["features"] if format_name == "geojson" else document["observations"]), 620)
                self.assertEqual(document["reproducibility"]["matchingCount"], 620)
                self.assertEqual(document["reproducibility"]["query"], QUERY)
                self.assertEqual(document["reproducibility"]["methodVersion"], "afternoon-active-cells-2km-1")

    def test_token_routes_do_not_reacquire_and_explicitly_reject_changed_source(self):
        from fastapi.testclient import TestClient
        import app as api
        with patch.dict(os.environ, {"FIRMS_MAP_KEY": ""}), patch.object(api, "store_from_environment", return_value=self.store):
            with TestClient(api.app) as client:
                mapped = client.post("/analysis/map-source", json={"query": QUERY})
                self.assertEqual(mapped.status_code, 200, mapped.text)
                generation = mapped.json()["meta"]["sourceGeneration"]
                with patch.object(api, "shared_firms_store", side_effect=AssertionError("Unexpected acquisition")), patch.object(api, "store_from_environment", side_effect=AssertionError("Unexpected source read")):
                    frozen = client.post("/analysis/selections", json={"query": QUERY, "options": {"sourceGeneration": generation, "observationIds": [detection_id(self.store.rows[0])]}})
                    self.assertEqual(frozen.status_code, 200, frozen.text)
                    token = frozen.json()["data"]["selectionToken"]
                    response = client.post("/analysis/observations", json={"query": QUERY, "options": {"selectionToken": token}})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["data"]["total"], 1)
                    exported = client.post("/analysis/observations/export", json={"query": QUERY, "format": "json", "options": {"selectionToken": token}})
                    self.assertEqual(len(exported.json()["observations"]), 1)
                remember_snapshot(QUERY, replace(self.store, rows=self.store.rows[1:]))
                invalid = client.post("/analysis/observations", json={"query": QUERY, "options": {"selectionToken": token}})
                self.assertEqual(invalid.status_code, 409)
                self.assertEqual(invalid.json()["code"], "selection-invalid")

    def test_imported_archive_daily_investigation_reuses_canonical_source(self):
        from fastapi.testclient import TestClient
        import app as api
        manifest = {"datasetVersion": "regional-v3", "regionId": "test-region", "geometry": AREA}
        archive = replace(self.store, source="Regional archive regional-v3")
        empty = CanonicalStore((), (), "No configured local source")
        with patch.dict(os.environ, {"SHARP_HISTORY_PATH": "synthetic-test-only", "FIRMS_MAP_KEY": "synthetic-test-only"}), patch.object(api, "store_from_environment", return_value=empty), patch("historical_activity.load_archive", return_value=(manifest, archive)), patch.object(api, "shared_firms_store", side_effect=AssertionError("Historical archive must not acquire FIRMS")):
            with TestClient(api.app) as client:
                response = client.post("/analysis/map-source", json={"query": QUERY})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["meta"]["datasetVersion"], "regional-v3")
                self.assertEqual(response.json()["meta"]["freshness"], "archived")
                self.assertEqual(len(response.json()["data"]["data"]["features"]), 620)
                exported = client.post("/analysis/observations/export", json={"query": QUERY, "format": "json", "investigation": {"area": {"id": "test-region", "name": "Test region"}}})
                self.assertEqual(exported.status_code, 200, exported.text)
                metadata = exported.json()["reproducibility"]
                self.assertEqual(metadata["datasetVersion"], "regional-v3")
                self.assertEqual(metadata["area"]["name"], "Test region")
                self.assertEqual(metadata["area"]["geometry"], AREA)
                described = client.get("/capabilities").json()
                self.assertTrue(described["historical"]["available"])
                self.assertEqual(described["exportFormats"], ["csv", "geojson", "json"])

    def test_page_and_export_reuse_expired_acquisition_without_reacquiring(self):
        from fastapi.testclient import TestClient
        import app as api
        import observation_explorer as explorer
        expired = replace(self.store, expires_at=1)
        with patch.dict(os.environ, {"FIRMS_MAP_KEY": "synthetic-test-only"}):
            with TestClient(api.app) as client:
                remember_snapshot(QUERY, expired)
                with patch.object(api, "store_from_environment", side_effect=AssertionError("Must retain the investigated source")), patch.object(api, "shared_firms_store", side_effect=AssertionError("Paging must not reacquire")):
                    paged = client.post("/analysis/observations", json={"query": QUERY, "options": {"page": 2}})
                    self.assertEqual(paged.status_code, 200, paged.text)
                    self.assertEqual(paged.json()["meta"]["freshness"], "stale")
                    exported = client.post("/analysis/observations/export", json={"query": QUERY, "format": "json"})
                    self.assertEqual(exported.status_code, 200, exported.text)
                    self.assertEqual(len(exported.json()["observations"]), 620)
                    key = explorer.scope_key(QUERY)
                    generation, store, created = explorer._snapshots[key]
                    explorer._snapshots[key] = (generation, store, created - explorer.SELECTION_TTL - 1)
                    expired_selection = client.post("/analysis/observations", json={"query": QUERY, "options": {"page": 3}})
                    self.assertEqual(expired_selection.status_code, 409)


if __name__ == "__main__":
    unittest.main()
