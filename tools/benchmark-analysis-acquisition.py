import asyncio
import argparse
import json
import sys
import tempfile
import time
import tracemalloc
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend_api"))

import app as service
from cache import BatchCache
from harmonize import map_source_document, overview_document
from harmonize import detection_id
from observation_explorer import observations_document, freeze_document, export_document


async def benchmark(label, days, observations_per_day):
    with tempfile.TemporaryDirectory() as directory:
        cache_path = Path(directory) / "cache.sqlite3"
        application = SimpleNamespace(state=SimpleNamespace(
            cache=BatchCache(cache_path), batch_locks=[asyncio.Lock() for _ in range(8)],
            batch_fetches={}, slots=asyncio.Semaphore(8), key="isolated-synthetic-key",
        ))
        today = datetime.now(UTC).date()
        first = today - timedelta(days=days + 1)
        end = first + timedelta(days=days)
        request = {
            "id": label, "processingMode": "harmonized",
            "aoi": {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]]}},
            "interval": {"start": f"{first}T00:00:00Z", "endExclusive": f"{end}T00:00:00Z"},
            "filters": {"platforms": ["aqua"], "dayNight": "all", "modisConfidenceMin": 0, "viirsConfidence": ["low", "nominal", "high"]},
        }
        header = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,scan,track,version\n"
        upstream_calls = 0

        async def upstream(_application, path, started=None):
            nonlocal upstream_calls
            if started:
                started.set()
            upstream_calls += 1
            requested_day = path.rsplit("/", 1)[-1]
            return header + "".join(
                f"{0.5 + index // 1000 / 1000:.6f},{0.5 + index % 1000 / 10000:.6f},{requested_day},1230,Aqua,80,{index % 80 + 1},D,1.1,1.2,6.1\n"
                for index in range(observations_per_day)
            )

        service._FIRMS_STORES.clear()
        service._FIRMS_TASKS.clear()
        tracemalloc.start()
        measurements = {}
        with patch("app.product_windows", new=AsyncMock(return_value={"MODIS_NRT": (date(2000, 11, 1), today)})), patch("app.fetch_csv", new=AsyncMock(side_effect=upstream)):
            for phase in ("cold", "warm", "disk"):
                if phase == "disk":
                    service._FIRMS_STORES.clear()
                calls_before = upstream_calls
                start = time.perf_counter()
                store = await service.shared_firms_store(application, request, (0, 0, 3, 3))
                acquired_ms = (time.perf_counter() - start) * 1000
                map_document = map_source_document(request, store)
                summary = overview_document(request, store)
                body = json.dumps(map_document, separators=(",", ":")).encode()
                measurements[phase] = {
                    "acquisition_ms": round(acquired_ms, 2),
                    "query_and_serialization_ms": round((time.perf_counter() - start) * 1000, 2),
                    "upstream_mock_calls": upstream_calls - calls_before,
                    "map_bytes": len(body),
                    "detection_count": summary["data"]["detectionCount"]["value"],
                    "acquisition_cache_hit": store.cache_hit,
                }
                del map_document, body, summary
        started = time.perf_counter()
        observations = observations_document(request, store, {"options": {"pageSize": 25, "sort": "frp", "groupBy": "hour"}})
        explorer_ms = (time.perf_counter() - started) * 1000
        frozen_ids = [detection_id(row) for row in store.rows[:20_000]]
        started = time.perf_counter()
        token = None
        for offset in range(0, len(frozen_ids), 2000):
            selected = freeze_document(request, store, {"options": {"observationIds": frozen_ids[offset:offset + 2000], "selectionToken": token}})
            token = selected["data"]["selectionToken"]
        frozen_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        popup_page = observations_document(request, store, {"options": {"selectionToken": token, "pageSize": 10, "groupBy": "hour", "sort": "frp"}})
        popup_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        exported = export_document(request, store, {"format": "geojson"})
        export_bytes = 0
        async for chunk in exported.body_iterator:
            export_bytes += len(chunk.encode() if isinstance(chunk, str) else chunk)
        processing = {"complete_query_count": observations["data"]["total"],
            "query_filter_sort_group_page_ms": round(explorer_ms, 2),
            "frozen_selection_count": len(frozen_ids), "bounded_freeze_ms": round(frozen_ms, 2),
            "frozen_popup_page_count": len(popup_page["data"]["rows"]),
            "frozen_popup_global_query_ms": round(popup_ms, 2),
            "complete_geojson_export_ms": round((time.perf_counter() - started) * 1000, 2),
            "complete_geojson_export_bytes": export_bytes,
            "instrumentation": "tracemalloc enabled; includes canonical filtering/aggregation, excludes network latency"}
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        return {
            "scenario": label, "fixture": "isolated synthetic NASA-format daily CSV; no external requests",
            "days": days, "observations_per_day": observations_per_day,
            "peak_tracemalloc_bytes": peak,
            "sqlite_bytes": sum(path.stat().st_size for path in Path(directory).glob("cache.sqlite3*")),
            "measurements": measurements,
            "observation_processing": processing,
        }


async def main(output=None):
    results = []
    for label, days, count in (("small-region-day", 1, 500), ("dense-country-week", 7, 3000), ("large-region-31-days", 31, 1000)):
        result = await benchmark(label, days, count)
        results.append(result)
        print(json.dumps(result), flush=True)
    target = output or ROOT / ".cache" / "benchmark-analysis-acquisition-results.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"recorded_at": datetime.now(UTC).isoformat(), "results": results}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Explicit offline acquisition and serving measurements")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--global-schema", action="store_true", help="Benchmark all configured bulk schemas and local global serving")
    modes.add_argument("--global-points", action="store_true", help="Read-only native point-tile benchmark using the existing stored global snapshot")
    modes.add_argument("--global-raster", action="store_true", help="Read-only transparent PNG benchmark using the existing stored global snapshot")
    modes.add_argument("--scientific", action="store_true", help="Benchmark the five-year synthetic summary, offline training and serving fixtures")
    parser.add_argument("--records-per-source", type=int, default=5000)
    parser.add_argument("--database", type=Path, help="Existing global SQLite database for --global-points; read-only")
    parser.add_argument("--window", choices=("24h", "48h", "7d"), default="24h")
    parser.add_argument("--viewers", type=int, default=100)
    parser.add_argument("--output", type=Path, help="Output file; AOI/scientific modes default to .cache and global mode defaults to stdout")
    arguments = parser.parse_args()
    if arguments.global_points or arguments.global_raster:
        import os
        if arguments.global_raster:
            from global_raster_benchmark import run
        else:
            from global_point_benchmark import run
        if not 1 <= arguments.viewers <= 1000:
            parser.error("--viewers must be from 1 to 1000")
        database = arguments.database or Path(os.environ.get("SHARP_GLOBAL_DB_PATH", str(ROOT / "src/backend_api/data/global-hotspots.sqlite")))
        result = run(database, arguments.window, arguments.viewers)
        encoded = json.dumps(result, indent=2) + "\n"
        if arguments.output:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(encoded, encoding="utf-8")
        print(encoded)
    elif arguments.global_schema:
        from global_benchmark import benchmark_global
        if not 100 <= arguments.records_per_source <= 100000:
            parser.error("--records-per-source must be from 100 to 100000")
        result = asyncio.run(benchmark_global(arguments.records_per_source))
        encoded = json.dumps(result, indent=2) + "\n"
        if arguments.output:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(encoded, encoding="utf-8")
        print(encoded)
    elif arguments.scientific:
        from scientific_benchmark import benchmark_scientific
        result = benchmark_scientific()
        encoded = json.dumps(result, indent=2) + "\n"
        target = arguments.output or ROOT / ".cache" / "benchmark-scientific-results.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(encoded, encoding="utf-8")
        print(encoded)
    else:
        asyncio.run(main(arguments.output))
