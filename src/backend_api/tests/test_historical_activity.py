import os
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
import csv
import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harmonize import CanonicalStore, Coverage, Detection, METHOD_VERSION
from historical_activity import history_document, import_archive, load_archive, method_evidence, recurrence_document
from activity_outlook import feature_values, metrics, outlook_document, train_archive

AREA = {"type": "Polygon", "coordinates": [[[0, 0], [.1, 0], [.1, .1], [0, .1], [0, 0]]]}


def query(start="2024-01-01", end="2024-02-01"):
    return {"id": "test-history", "processingMode": "harmonized", "aoi": {"geometry": AREA},
            "interval": {"start": start + "T00:00:00Z", "endExclusive": end + "T00:00:00Z"},
            "filters": {"platforms": ["aqua", "suomi-npp"], "dayNight": "all", "modisConfidenceMin": 0,
                        "viirsConfidence": ["low", "nominal", "high"]}}


def row(day, lon=.05, platform="suomi-npp"):
    return Detection(platform, .05, lon, datetime.combine(day, datetime.min.time(), UTC) + timedelta(hours=13),
                     None, "high" if platform != "aqua" else None, 90 if platform == "aqua" else None, None,
                     source_product="archive-product", product_version="v1", processing_tier="standard")


def archive(start=date(2020, 1, 1), end=date(2025, 1, 1), missing=()):
    rows, coverage = [], []
    day = start
    while day < end:
        if day not in missing:
            coverage.append(Coverage(day, "suomi-npp", "complete"))
            
            if day.day % 3:
                rows.append(row(day))
        day += timedelta(days=1)
    manifest = {"regionId": "fixture", "regionName": "Test fixture", "geometry": AREA,
                "datasetVersion": "test-only-v1", "methodVersion": METHOD_VERSION, "generation": "fixture-generation",
                "sources": ["test-only"], "forecastPlatforms": ["suomi-npp"], "importedAt": "2025-01-01T00:00:00Z"}
    return manifest, CanonicalStore(tuple(rows), tuple(coverage), "test-only")


class HistoryTests(unittest.TestCase):
    def test_multiyear_summary_and_active_cell_day_units(self):
        result = history_document(query(), now=datetime(2025, 1, 2, tzinfo=UTC), archive=archive())
        self.assertGreater(len(result["daily"]), 31)
        self.assertEqual(len(result["months"]), 60)
        self.assertEqual(result["unit"], "active-cell-days")
        self.assertEqual(result["months"][0]["expectedDays"], 31)
        self.assertEqual(result["months"][0]["coveredDays"], 31)
        self.assertEqual(result["months"][0]["value"], 21)
        self.assertEqual(result["baseline"]["minimumYears"], 3)
        self.assertEqual(result["comparison"]["state"], "available")

    def test_missing_days_stay_unknown_and_exclude_baseline_year(self):
        result = history_document(query(), now=datetime(2025, 1, 2, tzinfo=UTC), archive=archive(missing=[date(2021, 1, 5)]))
        month = next(m for m in result["months"] if m["year"] == 2021 and m["month"] == 1)
        self.assertIsNone(month["value"])
        self.assertEqual(month["coveredDays"], 30)
        self.assertIn(2021, result["baseline"]["months"][0]["excludedYears"])
        day = next(d for d in result["daily"] if d["date"] == "2021-01-05")
        self.assertIsNone(day["value"])

    def test_partial_current_month_compares_equivalent_elapsed_days(self):
        result = history_document(query("2024-01-01", "2024-02-01"), now=datetime(2024, 1, 10, 14, tzinfo=UTC), archive=archive())
        self.assertTrue(result["comparison"]["partialPeriod"])
        self.assertEqual(result["comparison"]["expectedDays"], 9)
        self.assertEqual(result["comparison"]["endExclusive"], "2024-01-10")
        current = next(d for d in result["daily"] if d["date"] == "2024-01-10")
        self.assertEqual(current["state"], "partial")
        month = next(m for m in result["months"] if m["year"] == 2024 and m["month"] == 1)
        self.assertIsNone(month["value"])

    def test_leap_day_retained_in_observed_month_excluded_from_comparison(self):
        result = history_document(query("2024-02-01", "2024-03-01"), now=datetime(2025, 1, 2, tzinfo=UTC), archive=archive())
        month = next(m for m in result["months"] if m["year"] == 2024 and m["month"] == 2)
        self.assertEqual(month["expectedDays"], 29)
        self.assertEqual(result["comparison"]["expectedDays"], 28)
        self.assertEqual(len(result["comparison"]["eligibleYears"]), 4)

    def test_partial_utc_boundary_days_are_not_compared_as_full_days(self):
        selected = query()
        selected["interval"] = {"start": "2024-01-01T06:00:00Z", "endExclusive": "2024-01-31T06:00:00Z"}
        result = history_document(selected, now=datetime(2025, 1, 2, tzinfo=UTC), archive=archive())
        self.assertEqual(result["comparison"]["expectedDays"], 29)
        self.assertTrue(result["comparison"]["partialPeriod"])

    def test_successful_zero_is_not_missing(self):
        result = history_document(query(), now=datetime(2025, 1, 2, tzinfo=UTC), archive=archive())
        zero = next(d for d in result["daily"] if d["date"] == "2024-01-03")
        self.assertEqual(zero["value"], 0)
        self.assertEqual(zero["state"], "complete")

    def test_no_archive_truthful_unavailable(self):
        result = history_document(query(), archive=(None, None))
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["months"], [])

    def test_unsupported_region_unavailable(self):
        selected = query()
        selected["aoi"]["geometry"] = {"type": "Polygon", "coordinates": [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]]}
        result = history_document(selected, archive=archive())
        self.assertEqual(result["status"], "unavailable")

    def test_recurrence_counts_distinct_dates_and_exact_interval(self):
        d1, d2 = date(2024, 1, 1), date(2024, 1, 2)
        store = CanonicalStore((row(d1), row(d1), row(d2), row(date(2024, 2, 1))), (), "fixture")
        result = recurrence_document(query(), store)
        self.assertEqual(len(result["features"]), 1)
        self.assertEqual(result["features"][0]["properties"]["distinctDates"], 2)
        self.assertEqual(result["features"][0]["properties"]["observationCount"], 3)

    def test_method_evidence_does_not_claim_validation(self):
        _manifest, store = archive()
        evidence = method_evidence(query(), store)
        self.assertEqual(evidence["methodVersion"], METHOD_VERSION)
        self.assertEqual(evidence["agreement"]["kind"], "calibration-fit")
        self.assertIsNone(evidence["independentValidation"])
        self.assertEqual(evidence["gridSizeM"], 2000)

    def test_real_import_roundtrip_preserves_provenance_and_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "rows.csv").write_text("platform_code,latitude,longitude,acquired_at,frp_mw,source_product,product_version,processing_tier\nN,.05,.05,2024-01-01T13:00:00Z,,VNP14,v2,standard\n", encoding="utf-8")
            (path / "coverage.csv").write_text("date,platform_code,state\n2024-01-01,N,complete\n2024-01-02,N,unknown\n", encoding="utf-8")
            manifest, _ = archive()
            result = import_archive(path / "history.sqlite", path / "rows.csv", path / "coverage.csv", manifest)
            saved, store = load_archive(path / "history.sqlite")
            self.assertEqual(result["observations"], 1)
            self.assertEqual(store.rows[0].source_product, "VNP14")
            self.assertEqual(store.rows[0].product_version, "v2")
            self.assertEqual(store.rows[0].processing_tier, "standard")
            self.assertIsNone(store.rows[0].frp_mw)
            self.assertEqual(store.coverage[1].state, "unknown")
            self.assertEqual(saved["methodVersion"], METHOD_VERSION)


class OutlookTests(unittest.TestCase):
    def test_features_have_conservative_issue_time_cutoff(self):
        issue = date(2024, 1, 10)
        complete = {issue - timedelta(days=i) for i in range(1, 12)}
        activity = __import__("collections").defaultdict(set)
        activity[issue - timedelta(days=1)].add((0, 0))
        activity[issue].add((0, 0))
        values = feature_values(issue, (0, 0), complete, activity)
        self.assertEqual(values[1], 0)
        self.assertEqual(values[2], 0)
        activity[issue - timedelta(days=2)].add((0, 0))
        self.assertEqual(feature_values(issue, (0, 0), complete, activity)[1], 1)

    def test_unknown_reporting_window_masks_features(self):
        issue = date(2024, 1, 10)
        self.assertIsNone(feature_values(issue, (0, 0), {issue - timedelta(days=2)}, {}))

    def test_average_precision_ties_deterministic(self):
        self.assertEqual(metrics([1, 0, 1, 0], [.5] * 4)["prAuc"], .5)
        self.assertEqual(metrics([0, 1, 0, 1], [.5] * 4)["prAuc"], .5)

    def test_ranked_area_is_selected_per_issue_without_label_tiebreak(self):
        labels = [0] * 5 + [1] * 5 + [0] * 5 + [1] * 5
        result = metrics(labels, [.5] * 20, [date(2024, 1, 1)] * 10 + [date(2024, 1, 2)] * 10)
        area = result["highestRankedArea"]
        self.assertEqual(area["examples"], 2)
        self.assertEqual(area["precision"], 0)
        self.assertEqual(area["meanSelectedAreaKm2"], 100)
        self.assertEqual(area["actualSelectedFraction"], .1)

    def test_neighbors_outside_reporting_domain_are_not_labeled_as_covered(self):
        issue = date(2024, 1, 10)
        complete = {issue - timedelta(days=i) for i in range(1, 12)}
        activity = __import__("collections").defaultdict(set)
        values = feature_values(issue, (0, 0), complete, activity, frozenset({(0, 0)}))
        self.assertEqual(values[-1], 0)

    def test_historical_map_does_not_show_current_forecast(self):
        result = outlook_document(query(), now=datetime(2025, 1, 1, tzinfo=UTC), archive=archive())
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("historical", result["reason"])

    def test_unvalidated_fallback_never_contains_probabilities(self):
        result = outlook_document(query("2024-12-31", "2025-01-02"), now=datetime(2025, 1, 1, tzinfo=UTC), archive=archive(), model_path="missing-model.json")
        self.assertEqual(result["state"], "historical-activity")
        self.assertTrue(result["features"]["features"])
        self.assertTrue(all(f["properties"]["probability"] is None for f in result["features"]["features"]))

    def test_stale_input_unavailable(self):
        result = outlook_document(query("2025-01-31", "2025-02-02"), now=datetime(2025, 2, 1, tzinfo=UTC), archive=archive())
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("old", result["reason"])

    def test_input_generation_invalidates_serving_cache(self):
        first_fixture = archive()
        first = outlook_document(query("2024-12-31", "2025-01-02"), now=datetime(2025, 1, 1, tzinfo=UTC), archive=first_fixture, model_path="missing.json")
        manifest, store = first_fixture
        changed = ({**manifest, "generation": "changed-generation"}, store)
        second = outlook_document(query("2024-12-31", "2025-01-02"), now=datetime(2025, 1, 1, tzinfo=UTC), archive=changed, model_path="missing.json")
        self.assertNotEqual(first["inputGeneration"], second["inputGeneration"])

    def test_offline_training_partitions_evaluation_and_reproducibility(self):
        fixture = archive(date(2023, 1, 1), date(2024, 1, 1))
        with tempfile.TemporaryDirectory() as directory:
            first = train_archive(fixture, Path(directory) / "first.json", iterations=20)
            second = train_archive(fixture, Path(directory) / "second.json", iterations=20)
            self.assertEqual(first["weights"], second["weights"])
            self.assertEqual(first["modelVersion"], second["modelVersion"])
            self.assertEqual(first["evaluation"], second["evaluation"])
            self.assertGreaterEqual(first["partitionGapDays"], 2)
            self.assertLess(first["partitions"]["train"]["endInclusive"], first["partitions"]["calibration"]["start"])
            self.assertLess(first["partitions"]["calibration"]["endInclusive"], first["partitions"]["test"]["start"])
            self.assertIn("seasonal", first["evaluation"]["baselines"])
            self.assertIn("persistence", first["evaluation"]["baselines"])
            self.assertEqual(first["promoted"], all(first["promotionChecks"].values()))
            self.assertEqual(first["horizonHours"], 24)
            self.assertEqual(first["publicationLatencyHours"], 24)


class ScientificRoutesTests(unittest.TestCase):
    def test_explicit_recurrence_keeps_reported_activity_distinct_from_forecasts(self):
        from observation_explorer import remember_snapshot
        selected = query('2024-01-01', '2024-01-03')
        fixture = CanonicalStore((row(date(2024, 1, 1)), row(date(2024, 1, 2))), (Coverage(date(2024, 1, 1), 'suomi-npp', 'complete'), Coverage(date(2024, 1, 2), 'suomi-npp', 'complete')), 'cached test fixture')
        remember_snapshot(selected, fixture)
        result = recurrence_document(selected, fixture)
        self.assertEqual(len(result['features']), 1)
        self.assertEqual(result['features'][0]['properties']['distinctDates'], 2)
        self.assertNotIn('probability', result['features'][0]['properties'])

    def test_imported_history_flows_into_calendar_map_and_full_observation_routes(self):
        from fastapi.testclient import TestClient
        import app as service
        from unittest.mock import AsyncMock
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "rows.csv").write_text("platform_code,latitude,longitude,acquired_at,confidence_class,source_product,product_version,processing_tier\nN,.05,.05,2024-01-01T13:00:00Z,high,VNP14,v2,standard\n", encoding="utf-8")
            (path / "coverage.csv").write_text("date,platform_code,state\n2024-01-01,N,complete\n2024-01-02,N,complete\n", encoding="utf-8")
            manifest, _ = archive()
            import_archive(path / "history.sqlite", path / "rows.csv", path / "coverage.csv", manifest)
            selected = query("2024-01-01", "2024-01-03")
            network = AsyncMock()
            with patch.dict(os.environ, {"SHARP_HISTORY_PATH": str(path / "history.sqlite"), "FIRMS_MAP_KEY": "", "FIRMS_CACHE_PATH": str(path / "cache.sqlite")}), patch("app.store_from_environment", return_value=CanonicalStore((), (), "empty")), patch("app.shared_firms_store", network), TestClient(service.app) as client:
                for route in ("calendar", "map-source", "observations"):
                    response = client.post("/analysis/" + route, json={"query": selected})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["meta"]["datasetVersion"], manifest["datasetVersion"])
                records = client.post("/analysis/observations", json={"query": selected}).json()["data"]
                self.assertEqual(records["total"], 1)
                self.assertEqual(client.post("/analysis/recurrence", json={"query": selected}).status_code, 200)
            network.assert_not_called()

    def test_diagnostics_never_acquire_when_snapshot_missing(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from scientific_routes import register_scientific_routes
        from observation_explorer import SelectionInvalid
        app = FastAPI()
        network = __import__("unittest.mock").mock.AsyncMock()
        register_scientific_routes(app, network)
        with TestClient(app) as client, patch("scientific_routes.cached_snapshot", side_effect=SelectionInvalid("Refresh map source")):
            for path in ("/analysis/recurrence", "/analysis/method"):
                response = client.post(path, json={"query": query()})
                self.assertEqual(response.status_code, 409)
        network.assert_not_called()

    def test_history_is_read_only_and_removed_forecast_routes_stay_unavailable(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from scientific_routes import register_scientific_routes
        app = FastAPI()
        network = __import__("unittest.mock").mock.AsyncMock()
        register_scientific_routes(app, network)
        with TestClient(app) as client, patch("historical_activity.load_archive", return_value=(None, None)), patch("scientific_routes.prepare_history", side_effect=AssertionError("History reads must not start acquisition")):
            for path in ("/analysis/history", "/analysis/history/status"):
                response = client.post(path, json={"query": query()})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(client.post(path, json={"query": None}).status_code, 422)
            self.assertEqual(client.post("/analysis/outlook", json={"query": query()}).status_code, 404)
        network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
