
import asyncio
import csv
import io
import json
import sys
import tempfile
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend_api"))

import httpx
from global_ingestion import BULK_SOURCES, refresh_global
from global_store import GlobalStore
from global_tiles import GlobalPresentation, cache_statistics


def source_fixture(filename, count, anchor):
    
    source = ROOT / "src" / "backend_api" / "tests" / "fixtures" / filename
    reader = csv.DictReader(io.StringIO(source.read_text(encoding="utf-8")))
    examples = list(reader)
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=reader.fieldnames)
    writer.writeheader()
    for index in range(count):
        row = dict(examples[index % len(examples)])
        acquired = anchor - timedelta(minutes=1+index % (7*24*60))
        row.update(acq_date=acquired.date().isoformat(), acq_time=acquired.strftime("%H%M"))
        
        row["latitude"] = f"{10+index/100000 if index % 4 == 0 else -65+(index % 130)+index/10000000:.7f}"
        row["longitude"] = f"{10+index/100000 if index % 4 == 0 else -179+(index % 358)+index/10000000:.7f}"
        writer.writerow(row)
    return output.getvalue()


async def benchmark_global(records_per_source=5000):
    anchor = datetime(2026, 11, 15, 13, tzinfo=UTC)
    filenames = {"MODIS_NRT": "firms_modis_bulk.csv", "VIIRS_NOAA20_NRT": "firms_noaa20_bulk.csv", "VIIRS_NOAA21_NRT": "firms_noaa21_bulk.csv"}
    tracemalloc.start()
    payloads = {BULK_SOURCES[source]: source_fixture(filename, records_per_source, anchor) for source, filename in filenames.items()}
    requests = []
    async def transport(request):
        requests.append(str(request.url))
        await asyncio.sleep(.001)
        return httpx.Response(200, text=payloads[str(request.url)], headers={"Content-Type": "text/csv", "Last-Modified": "Sun, 15 Nov 2026 13:00:00 GMT"})
    result = {"kind": "Offline synthetic observations in actual MODIS/NOAA-20/NOAA-21 bulk schemas; mocked HTTP; no scientific validation or live NASA traffic", "recordsPerSource": records_per_source, "configuredSources": list(filenames)}
    with tempfile.TemporaryDirectory() as directory:
        store = GlobalStore(Path(directory) / "global.sqlite")
        size = lambda: sum(path.stat().st_size for path in Path(directory).glob("global.sqlite*"))
        initial_size = size()
        started, cpu = time.perf_counter(), time.process_time()
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            publication = await refresh_global(store, client, now=anchor, sources=list(filenames), force=True)
            result["ingestion"] = {"wallMs": round((time.perf_counter()-started)*1000, 3), "cpuMs": round((time.process_time()-cpu)*1000, 3), "mockedBulkRequests": len(requests), "downloadBytes": sum(len(value.encode()) for value in payloads.values()), "databaseBytes": size(), "databaseGrowthBytes": size()-initial_size, "state": publication["state"]}
            snapshot = publication["manifest"]["snapshot"]
            service = GlobalPresentation(store)
            calls = len(requests)
            for label, window, zoom, x, y in (("worldwide24h", "24h", 0, 0, 0), ("worldwide7d", "7d", 0, 0, 0), ("denseRegionalZoom", "7d", 5, 16, 15)):
                started, cpu = time.perf_counter(), time.process_time()
                tile = service.tile(snapshot, window, zoom, x, y)
                cold, cold_cpu = (time.perf_counter()-started)*1000, (time.process_time()-cpu)*1000
                started = time.perf_counter(); service.tile(snapshot, window, zoom, x, y)
                result[label] = {**tile[3], "coldMs": round(cold, 3), "coldCpuMs": round(cold_cpu, 3), "warmMs": round((time.perf_counter()-started)*1000, 3)}
            world = json.loads(service.tile(snapshot, "7d", 0, 0, 0)[0])
            aggregate = next(item["properties"]["aggregateId"] for item in world["features"] if item["properties"].get("aggregateId"))
            started = time.perf_counter()
            inspected = service.observations(snapshot, "7d", aggregate, {"pageSize": 10, "groupBy": "hour"})
            result["aggregateInspection"] = {"ms": round((time.perf_counter()-started)*1000, 3), "matchingCount": inspected["data"]["total"], "responseBytes": len(json.dumps(inspected).encode())}
            before = cache_statistics(); started = time.perf_counter()
            with ThreadPoolExecutor(max_workers=20) as pool:
                list(pool.map(lambda _: service.tile(snapshot, "7d", 0, 0, 0), range(100)))
            after = cache_statistics()
            result["concurrentWarmReaders"] = {"calls": 100, "threads": 20, "wallMs": round((time.perf_counter()-started)*1000, 3), "cacheHits": after["hits"]-before["hits"], "generatedTiles": after["generated"]-before["generated"], "upstreamRequests": len(requests)-calls}
            started = time.perf_counter()
            with patch("global_ingestion.download_source", new=AsyncMock(side_effect=ValueError("Simulated provider outage"))):
                outage = await refresh_global(store, client, now=anchor+timedelta(minutes=15), sources=list(filenames), force=True)
            retained = service.observations(outage["manifest"]["snapshot"], "7d")["data"]["total"]
            result["upstreamOutage"] = {"kind": "simulated download adapter failure; does not measure network timeout/backoff latency", "wallMs": round((time.perf_counter()-started)*1000, 3), "retainedCount": retained, "sourceStates": [source["status"] for source in outage["manifest"]["sources"]]}
        result["canonicalObservationCount"] = service.observations(snapshot, "7d")["data"]["total"]
    result.update(peakTracemallocBytes=tracemalloc.get_traced_memory()[1], actualNASARequests=0, actualMAPKEYTransactions=0, browserMemory=None, browserFrameTimes=None)
    tracemalloc.stop()
    return result
