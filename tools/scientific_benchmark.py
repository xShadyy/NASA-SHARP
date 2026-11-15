
import sys
import tempfile
import time
import tracemalloc
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend_api"))
sys.path.insert(0, str(ROOT / "src" / "backend_api" / "tests"))

from activity_outlook import outlook_document, train_archive
from historical_activity import history_document
from test_historical_activity import archive, query


def benchmark_scientific():
    
    tracemalloc.start()
    fixture = archive()
    manifest, store = fixture
    dense = tuple(replace(row, longitude=row.longitude + index*.00001) for row in store.rows for index in range(60))
    dense_store = replace(store, rows=dense, source="Explicit synthetic scientific software benchmark")
    results = {"kind": "Synthetic test fixtures; software performance only, not production history or scientific validation", "historicalYears": 5, "historicalObservations": len(dense), "forecastDomainCells": 1, "actualNASARequests": 0, "actualMAPKEYTransactions": 0}
    started, cpu = time.perf_counter(), time.process_time()
    historical = history_document(query(), archive=(manifest, dense_store), now=datetime(2025, 1, 1, tzinfo=UTC))
    results.update(multiYearSummaryMs=round((time.perf_counter()-started)*1000, 3), multiYearSummaryCpuMs=round((time.process_time()-cpu)*1000, 3), summarizedMonths=len(historical["months"]), metricUnit=historical["unit"])
    with tempfile.TemporaryDirectory() as directory:
        model_path = Path(directory) / "model.json"
        started, cpu = time.perf_counter(), time.process_time()
        model = train_archive(fixture, model_path, iterations=150)
        results.update(offlineTrainingAndEvaluationMs=round((time.perf_counter()-started)*1000, 3), offlineTrainingAndEvaluationCpuMs=round((time.process_time()-cpu)*1000, 3), fixtureModelPromoted=model["promoted"], fixturePromotionChecks=model["promotionChecks"], fixtureEvaluation=model["evaluation"], modelArtifactBytes=model_path.stat().st_size)
        selected = query("2024-12-31", "2025-01-02")
        started = time.perf_counter()
        served = outlook_document(selected, archive=fixture, now=datetime(2025, 1, 1, tzinfo=UTC), model_path=model_path)
        results.update(forecastServingMs=round((time.perf_counter()-started)*1000, 3), servedState=served["state"], servedCells=len(served["features"]["features"]), probabilitiesExposed=any(item["properties"]["probability"] is not None for item in served["features"]["features"]))
        started = time.perf_counter()
        for _ in range(30):
            outlook_document(selected, archive=fixture, now=datetime(2025, 1, 1, tzinfo=UTC), model_path=model_path)
        results["cachedForecastServingMeanMs"] = round((time.perf_counter()-started)*1000/30, 3)
    results["peakTracemallocBytes"] = tracemalloc.get_traced_memory()[1]
    results["instrumentation"] = "Python allocation tracing enabled; local CPU/storage only; no browser or production forecast metrics"
    tracemalloc.stop()
    return results
