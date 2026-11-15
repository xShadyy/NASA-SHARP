
import os
import io
import runpy
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from dataclasses import replace
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
import app as service
import observation_explorer as explorer
from harmonize import CanonicalStore, Coverage, coverage_from_rows, detection_id, evaluate_query
from historical_preparation import _commit, _initialize, _metadata, _progress, _seed, history_status
from scientific_routes import register_scientific_routes
from test_historical_activity import AREA, archive, query, row


class SubmissionRepairTests(unittest.TestCase):
    def test_health_identifies_backend_with_bounded_dense_country_presentation(self):
        result = service.health()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["implementation"], "sharp-backend-2")
        self.assertEqual(result["mapSource"], {"representation": "individuals-or-bounded-display-aggregates", "individualLimit": 100_000, "aggregateLimit": 25_000})

    def test_operator_cli_help_parses_without_acquisition_or_store_creation(self):
        tools = Path(__file__).resolve().parents[3] / "tools"
        commands = [("sharp-history.py", ["--help"], ["import", "train"]),
                    ("sharp-history.py", ["import", "--help"], ["--detections", "--coverage", "--manifest", "--output"]),
                    ("global-hotspots.py", ["--help"], ["refresh", "status", "import", "--database", "--window"])]
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARP_GLOBAL_INGEST_ENABLED": "0", "SHARP_GLOBAL_DB_PATH": str(Path(directory) / "global.sqlite"), "SHARP_HISTORY_CACHE_DIR": directory, "FIRMS_MAP_KEY": ""}), patch("global_store.GlobalStore", side_effect=AssertionError("Help must not create a store")), patch("global_ingestion.refresh_global", side_effect=AssertionError("Help must not acquire")), patch("historical_activity.import_archive", side_effect=AssertionError("Help must not import")), patch("activity_outlook.train_archive", side_effect=AssertionError("Help must not train")):
            for name, arguments, expected in commands:
                with self.subTest(command=[name, *arguments]):
                    output = io.StringIO()
                    with patch.object(sys, "argv", [str(tools / name), *arguments]), patch.object(sys, "path", sys.path.copy()), redirect_stdout(output):
                        with self.assertRaises(SystemExit) as result:
                            runpy.run_path(str(tools / name), run_name="__main__")
                    self.assertEqual(result.exception.code, 0)
                    self.assertIn("usage:", output.getvalue())
                    for argument in expected:
                        self.assertIn(argument, output.getvalue())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_inferred_reporting_coverage_is_unknown_and_never_creates_a_reported_zero(self):
        detection = row(date(2024, 1, 1), lon=.01)
        inferred = coverage_from_rows([detection, detection])
        self.assertEqual(inferred, (Coverage(date(2024, 1, 1), "suomi-npp", "unknown"),))
        scope = query("2024-01-01", "2024-01-02")
        scope["aoi"]["geometry"] = {"type": "Polygon", "coordinates": [[[.07, .07], [.09, .07], [.09, .09], [.07, .09], [.07, .07]]]}
        unknown = CanonicalStore((detection,), inferred, "row-only fixture", coverage_geometry=AREA)
        result = evaluate_query(scope, unknown)[0].days[0]
        self.assertIsNone(result.count)
        self.assertEqual(result.state, "unknown")
        explicit = replace(unknown, coverage=(Coverage(date(2024, 1, 1), "suomi-npp", "complete"),))
        self.assertEqual(evaluate_query(scope, explicit)[0].days[0].count, 0)

    def test_structured_provenance_survives_seed_and_commit_without_losing_native_fields(self):
        scope = query("2024-01-01", "2024-01-02")
        manifest, stored = archive(date(2024, 1, 1), date(2024, 1, 2))
        provenance = {"product": "VNP14IMG", "processingTier": "standard", "version": "002", "retrievedAt": "2024-02-01T00:00:00Z", "coverage": {"state": "complete"}}
        manifest["sources"] = ["legacy-product", provenance, dict(reversed(list(provenance.items())))]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite"
            _initialize(path, scope, [(2024, 1)])
            with patch("historical_preparation.load_archive", return_value=(manifest, stored)):
                _seed(path, scope)
                _seed(path, scope)
            _commit(path, "regional-partition", [], date(2024, 1, 2), {"suomi-npp"}, "complete", provenance, True)
            _commit(path, "regional-partition", [], date(2024, 1, 2), {"suomi-npp"}, "complete", "legacy-product", True)
            with closing(sqlite3.connect(path)) as db:
                result = _metadata(db)
            self.assertEqual(len(result["sources"]), 2)
            self.assertIn(provenance, result["sources"])
            self.assertIn("legacy-product", result["sources"])

    def test_frozen_expiry_is_fixed_despite_reads_and_membership_batches(self):
        scope = query("2024-01-01", "2024-01-02")
        stored = CanonicalStore((row(date(2024, 1, 1)),), (Coverage(date(2024, 1, 1), "suomi-npp", "complete"),), "finite selection fixture")
        explorer.remember_snapshot(scope, stored)
        ids = [detection_id(stored.rows[0])]
        with patch("observation_explorer.time.monotonic", return_value=100):
            first = explorer.freeze_document(scope, stored, {"options": {"observationIds": ids}})
        token = first["data"]["selectionToken"]
        self.assertIn("expiresAt", first["data"])
        with patch("observation_explorer.time.monotonic", return_value=100 + explorer.SELECTION_TTL - 1):
            explorer.cached_snapshot(scope, {"selectionToken": token})
            explorer.freeze_document(scope, stored, {"options": {"selectionToken": token, "observationIds": ids}})
            page = explorer.observations_document(scope, stored, {"options": {"selectionToken": token}})
            self.assertEqual(page["meta"]["selectionExpiresInSeconds"], 1)
        with patch("observation_explorer.time.monotonic", return_value=100 + explorer.SELECTION_TTL):
            with self.assertRaises(explorer.SelectionInvalid) as expired:
                explorer.cached_snapshot(scope, {"selectionToken": token})
        self.assertEqual(expired.exception.code, "selection-expired")
        self.assertEqual(expired.exception.action, "refresh-selected-group")

    def test_authoritative_coverage_geometry_participates_in_source_identity(self):
        stored = CanonicalStore((row(date(2024, 1, 1)),), (), "geometry identity")
        self.assertNotEqual(explorer.source_generation(stored), explorer.source_generation(replace(stored, coverage_geometry=AREA)))
        self.assertEqual(explorer.source_generation(stored), explorer.source_generation(replace(stored, fetched_at=123, expires_at=999)))

    def test_history_reads_and_status_never_start_preparation_or_create_an_archive(self):
        app = FastAPI()
        register_scientific_routes(app, None)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARP_HISTORY_CACHE_DIR": directory}), patch("scientific_routes.load_query_archive", return_value=(None, None)), patch("scientific_routes.prepare_history", new=AsyncMock(return_value={"state": "queued", "active": True})) as prepare, TestClient(app) as client:
            selected = query()
            self.assertEqual(client.post("/analysis/history", json={"query": selected}).status_code, 200)
            status = client.post("/analysis/history/status", json={"query": selected})
            self.assertEqual(status.json()["state"], "idle")
            self.assertFalse(status.json()["active"])
            self.assertEqual(list(Path(directory).iterdir()), [])
            prepare.assert_not_called()
            self.assertEqual(client.post("/analysis/history/prepare", json={"query": selected}).status_code, 200)
            prepare.assert_awaited_once()

    def test_failed_history_status_is_read_only_and_offers_bounded_explicit_retry(self):
        scope = query()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARP_HISTORY_CACHE_DIR": directory}):
            from historical_activity import automatic_archive_path
            path = automatic_archive_path(scope)
            _initialize(path, scope, [(2024, 1)])
            _progress(path, state="failed", message="Provider unavailable", retryAt=1060)
            app = SimpleNamespace(state=SimpleNamespace())
            with patch("historical_preparation.time.time", return_value=1000):
                status = history_status(app, scope)
            self.assertFalse(status["active"])
            self.assertTrue(status["explicitRetry"])
            self.assertEqual(status["retryAfterSeconds"], 61)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(_metadata(db)["preparation"]["state"], "failed")

    def test_cors_allows_configured_exact_origins_and_rejects_wildcards(self):
        self.assertIn("http://localhost:5173", service.cors_origins("http://localhost:5173,https://sharp.example/"))
        app = FastAPI()
        app.add_middleware(CORSMiddleware, allow_origins=service.cors_origins("https://sharp.example"), allow_methods=["POST"], allow_headers=["Content-Type"])
        with TestClient(app) as client:
            for origin, expected in (("https://sharp.example", 200), ("https://untrusted.example", 400)):
                result = client.options("/analysis/history", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
                self.assertEqual(result.status_code, expected)
                self.assertEqual(result.headers.get("access-control-allow-origin"), origin if expected == 200 else None)
        for invalid in ("*", "https://*.example", "https://example/path", "https://user:pass@example", "https://example:invalid", "https://bad host.example"):
            with self.assertRaises(ValueError):
                service.cors_origins(invalid)

    def test_malformed_analysis_scope_is_rejected_before_any_source_or_network_read(self):
        selected = query()
        malformed = [None, {**selected, "id": ""}, {**selected, "processingMode": "raw"}, {**selected, "filters": []},
            {**selected, "filters": {**selected["filters"], "viirsConfidence": [{}]}},
            {**selected, "interval": {"start": "2024-02-01T00:00:00Z", "endExclusive": "2024-01-01T00:00:00Z"}},
            {**selected, "aoi": {"geometry": {"type": "Polygon", "coordinates": []}}},
            {**selected, "aoi": {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [181, 1], [0, 0]]]}}}]
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARP_GLOBAL_DB_PATH": str(Path(directory) / "global.sqlite"), "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite"), "FIRMS_MAP_KEY": "offline-test-only"}), patch("app.store_from_environment", side_effect=AssertionError("Malformed scope must not read sources")), patch("app.shared_firms_store", side_effect=AssertionError("Malformed scope must not acquire")), TestClient(service.app) as client:
            for invalid in malformed:
                response = client.post("/analysis/map-source", json={"query": invalid})
                self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(client.post("/analysis/map-source", json={"query": selected, "options": ["invalid"]}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
