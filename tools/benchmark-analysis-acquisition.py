import asyncio
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
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        return {
            "scenario": label, "fixture": "isolated synthetic NASA-format daily CSV; no external requests",
            "days": days, "observations_per_day": observations_per_day,
            "peak_tracemalloc_bytes": peak,
            "sqlite_bytes": sum(path.stat().st_size for path in Path(directory).glob("cache.sqlite3*")),
            "measurements": measurements,
        }


async def main():
    results = []
    for label, days, count in (("small-region-day", 1, 500), ("dense-country-week", 7, 3000), ("large-region-31-days", 31, 1000)):
        result = await benchmark(label, days, count)
        results.append(result)
        print(json.dumps(result), flush=True)
    target = ROOT / "tools" / "benchmark-analysis-acquisition-results.json"
    target.write_text(json.dumps({"recorded_at": datetime.now(UTC).isoformat(), "results": results}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
