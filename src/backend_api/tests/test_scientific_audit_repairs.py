
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from dataclasses import replace
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harmonize import CanonicalStore, Coverage, Filters, evaluate_query, geometry_supports_area
from historical_activity import import_archive, load_archive, cell_polygon, recurrence_document
from activity_outlook import domain_cells, outlook_document, GRID_M, FEATURES, SUPPORT_POLICY
from test_historical_activity import archive, query, row, AREA


class ScientificAuditRepairsTests(unittest.TestCase):
    def test_covered_empty_aoi_is_successful_zero_without_positive_bbox_inference(self):
        selected = {"type": "Polygon", "coordinates": [[[.07, .07], [.09, .07], [.09, .09], [.07, .09], [.07, .07]]]}
        scoped = query("2024-01-01", "2024-01-02")
        scoped["aoi"]["geometry"] = selected
        stored = CanonicalStore((row(date(2024, 1, 1), lon=.01),), (Coverage(date(2024, 1, 1), "suomi-npp", "complete"),), "registered archive", coverage_geometry=AREA)
        result = evaluate_query(scoped, stored)[0]
        self.assertEqual(result.days[0].count, 0)
        self.assertEqual(result.days[0].state, "complete")
        outside = {"type": "Polygon", "coordinates": [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]]}
        scoped["aoi"]["geometry"] = outside
        result = evaluate_query(scoped, stored)[0]
        self.assertIsNone(result.days[0].count)
        self.assertEqual(result.days[0].state, "unavailable")
        scoped["aoi"]["geometry"] = selected
        unknown = replace(stored, coverage=(Coverage(date(2024, 1, 1), "suomi-npp", "unknown"),))
        self.assertIsNone(evaluate_query(scoped, unknown)[0].days[0].count)

    def test_archive_read_pins_manifest_rows_and_coverage_to_actual_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            db_path = directory / "history.sqlite"
            rows_path = directory / "rows.csv"
            coverage_path = directory / "coverage.csv"
            header = "platform_code,latitude,longitude,acquired_at,confidence_class\n"
            rows_path.write_text(header + "N,.05,.05,2024-01-01T13:00:00Z,high\n")
            coverage_path.write_text("date,platform_code,state\n2024-01-01,N,complete\n")
            manifest, _ = archive()
            first = import_archive(db_path, rows_path, coverage_path, {**manifest, "datasetVersion": "old"})
            original_connect = sqlite3.connect
            with closing(original_connect(db_path)) as db:
                db.execute("PRAGMA journal_mode=WAL")
            rows_path.write_text(header + "N,.05,.05,2024-01-02T13:00:00Z,nominal\n")
            coverage_path.write_text("date,platform_code,state\n2024-01-02,N,complete\n")
            errors = []
            updated = threading.Event()
            def writer():
                try:
                    import_archive(db_path, rows_path, coverage_path, {**manifest, "datasetVersion": "new"})
                except Exception as error:
                    errors.append(error)
                finally:
                    updated.set()
            def connect(*args, **kwargs):
                connection = original_connect(*args, **kwargs)
                if kwargs.get("uri"):
                    def trace(statement):
                        if statement.startswith("SELECT payload FROM detections") and not updated.is_set():
                            thread = threading.Thread(target=writer)
                            thread.start()
                            self.assertTrue(updated.wait(10))
                            thread.join()
                    connection.set_trace_callback(trace)
                return connection
            with patch("historical_activity.sqlite3.connect", side_effect=connect):
                old_manifest, old_store = load_archive(db_path)
            self.assertEqual(errors, [])
            self.assertEqual(old_manifest["generation"], first["generation"])
            self.assertEqual(old_store.generation, first["generation"])
            self.assertEqual(old_store.rows[0].acquired_at.date(), date(2024, 1, 1))
            self.assertEqual(old_store.coverage[0].day, date(2024, 1, 1))
            new_manifest, new_store = load_archive(db_path)
            self.assertEqual(new_manifest["datasetVersion"], "new")
            self.assertNotEqual(new_manifest["generation"], old_manifest["generation"])
            self.assertEqual(new_store.rows[0].acquired_at.date(), date(2024, 1, 2))
            self.assertEqual(new_store.coverage_geometry, manifest["geometry"])

    def test_forecast_cells_cannot_cross_holes_or_concave_support_boundaries(self):
        shell = [[0, 0], [.4, 0], [.4, .4], [0, .4], [0, 0]]
        hole = [[.06, .06], [.08, .06], [.08, .08], [.06, .08], [.06, .06]]
        holed = {"type": "Polygon", "coordinates": [shell, hole]}
        self.assertFalse(geometry_supports_area(holed, cell_polygon((0, 0), GRID_M)))
        self.assertNotIn((0, 0), domain_cells(holed))
        concave = {"type": "Polygon", "coordinates": [[[0, 0], [.3, 0], [.3, .3], [.07, .3], [.07, .07], [.05, .07], [.05, .3], [0, .3], [0, 0]]]}
        self.assertNotIn((0, 0), domain_cells(concave))
        for geometry in (holed, concave):
            for cell in domain_cells(geometry):
                self.assertTrue(geometry_supports_area(geometry, cell_polygon(cell, GRID_M)))

    def test_recurrence_blank_semantics_do_not_claim_missing_support_only(self):
        stored = CanonicalStore((row(date(2024, 1, 1)),), (Coverage(date(2024, 1, 1), "suomi-npp", "complete"),), "covered")
        result = recurrence_document(query("2024-01-01", "2024-01-02"), stored)
        self.assertEqual(result["representation"], "occupied-cells-only")
        self.assertIn("No reported detections or unavailable", result["emptyCellMeaning"])

    def test_serving_cache_changes_with_issue_validity_and_model_contents(self):
        fixture = archive()
        selected = query("2024-12-31", "2025-01-03")
        manifest, _ = fixture
        artifact = {"modelVersion": "same-declared-version", "methodVersion": manifest["methodVersion"],
                    "datasetVersion": manifest["datasetVersion"], "geometry": manifest["geometry"],
                    "forecastPlatforms": manifest["forecastPlatforms"], "features": FEATURES,
                    "supportPolicy": SUPPORT_POLICY, "promoted": False,
                    "evaluation": {"revision": 1}}
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "model.json"
            model.write_text(json.dumps(artifact))
            first = outlook_document(selected, now=datetime(2025, 1, 1, tzinfo=UTC), archive=fixture, model_path=model)
            cached = outlook_document(selected, now=datetime(2025, 1, 1, 1, tzinfo=UTC), archive=fixture, model_path=model)
            self.assertIs(first, cached)
            model.write_text(json.dumps({**artifact, "evaluation": {"revision": 2}}))
            revised = outlook_document(selected, now=datetime(2025, 1, 1, 1, tzinfo=UTC), archive=fixture, model_path=model)
            self.assertEqual(revised["evaluation"]["revision"], 2)
            self.assertIsNot(first, revised)
            tomorrow = outlook_document(selected, now=datetime(2025, 1, 2, tzinfo=UTC), archive=fixture, model_path=model)
            self.assertNotEqual(tomorrow["issueTime"], first["issueTime"])
            self.assertNotEqual(tomorrow["validEnd"], first["validEnd"])
            self.assertTrue(all(feature["properties"]["probability"] is None for feature in tomorrow["features"]["features"]))

    def test_removed_forecast_route_does_not_silently_substitute_recurrence(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from scientific_routes import register_scientific_routes
        from observation_explorer import remember_snapshot
        selected = query("2024-01-01", "2024-01-02")
        stored = CanonicalStore((row(date(2024, 1, 1)),), (Coverage(date(2024, 1, 1), "suomi-npp", "complete"),), "stored recurrence")
        remember_snapshot(selected, stored)
        app = FastAPI()
        register_scientific_routes(app, None)
        with TestClient(app) as client:
            self.assertEqual(client.post("/analysis/outlook", json={"query": selected}).status_code, 404)
            explicit = client.post("/analysis/recurrence", json={"query": selected})
            self.assertEqual(explicit.status_code, 200, explicit.text)
            self.assertTrue(explicit.json()["features"])
            self.assertTrue(all("probability" not in feature["properties"] for feature in explicit.json()["features"]))

    def test_historical_recurrence_uses_full_stored_interval_and_never_revives_expired_selection(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from scientific_routes import register_scientific_routes
        from observation_explorer import SelectionInvalid
        manifest, stored = archive()
        stored = replace(stored, generation=manifest["generation"], coverage_geometry=manifest["geometry"])
        selected = query("2024-01-01", "2024-04-01")
        app = FastAPI()
        register_scientific_routes(app, None)
        with TestClient(app) as client, patch("scientific_routes.cached_snapshot", side_effect=SelectionInvalid("No full interval cached")), patch("scientific_routes.load_query_archive", return_value=(manifest, stored)) as loaded:
            response = client.post("/analysis/recurrence", json={"query": selected, "options": {"sourceGeneration": manifest["generation"]}})
            self.assertEqual(response.status_code, 200)
            cell = response.json()["features"][0]["properties"]
            self.assertEqual(cell["selectedDays"], 91)
            self.assertGreater(cell["distinctDates"], 31)
            self.assertEqual(client.post("/analysis/recurrence", json={"query": selected, "options": {"sourceGeneration": "old-generation"}}).status_code, 409)
            loaded.reset_mock()
            self.assertEqual(client.post("/analysis/recurrence", json={"query": selected, "options": {"selectionToken": "expired"}}).status_code, 409)
            loaded.assert_not_called()


if __name__ == "__main__":
    unittest.main()
