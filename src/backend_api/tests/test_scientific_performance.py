"""Repeatable local synthetic-fixture timings, never scientific validation."""
import json
import sys
import tempfile
import time
import unittest
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from historical_activity import history_document
from activity_outlook import outlook_document, train_archive
from harmonize import CanonicalStore
from test_historical_activity import archive, query


class ScientificPerformanceTests(unittest.TestCase):
    def test_measure_synthetic_scientific_paths(self):
        fixture = archive()
        manifest, store = fixture
        dense = tuple(replace(row, longitude=row.longitude + i * .00001) for row in store.rows for i in range(60))
        dense_store = CanonicalStore(dense, store.coverage, "synthetic performance fixture")
        results = {"kind": "synthetic test fixtures, not production measurements", "historicalYears": 5,
                   "historicalObservations": len(dense), "forecastDomainCells": 1}
        started = time.perf_counter()
        historical = history_document(query(), archive=(manifest, dense_store), now=datetime(2025, 1, 1, tzinfo=UTC))
        results["multiYearSummaryMs"] = round((time.perf_counter() - started) * 1000, 3)
        self.assertEqual(len(historical["months"]), 60)
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.json"
            started = time.perf_counter()
            model = train_archive(fixture, model_path, iterations=150)
            results["offlineTrainingAndEvaluationMs"] = round((time.perf_counter() - started) * 1000, 3)
            results["fixtureModelPromoted"] = model["promoted"]
            results["fixtureEvaluation"] = model["evaluation"]
            selected = query("2024-12-31", "2025-01-02")
            started = time.perf_counter()
            outlook_document(selected, archive=fixture, now=datetime(2025, 1, 1, tzinfo=UTC), model_path=model_path)
            results["forecastServingMs"] = round((time.perf_counter() - started) * 1000, 3)
            started = time.perf_counter()
            for _ in range(30):
                outlook_document(selected, archive=fixture, now=datetime(2025, 1, 1, tzinfo=UTC), model_path=model_path)
            results["cachedForecastServingMeanMs"] = round((time.perf_counter() - started) * 1000 / 30, 3)
        output = Path(__file__).resolve().parents[3] / "tools" / "benchmark-scientific-results.json"
        output.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print("\nScientific fixture timings: " + json.dumps({key: value for key, value in results.items() if key.endswith("Ms")}))
