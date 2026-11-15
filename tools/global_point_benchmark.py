
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend_api"))

from global_point_tiles import GlobalPointPresentation, point_cache_statistics
from global_store import GlobalStore


class ReadOnlyGlobalStore(GlobalStore):
    def __init__(self, path):
        self.path = Path(path).resolve()
        if not self.path.is_file():
            raise ValueError("The existing global database was not found.")

    def connect(self):
        db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        return db


def run(database, window="24h", viewers=100):
    service = GlobalPointPresentation(ReadOnlyGlobalStore(database))
    manifest = service.manifest(window)
    snapshot = manifest.get("snapshotId")
    if not snapshot:
        raise ValueError("No ready stored snapshot exists for this interval.")
    result = {"kind": "Read-only real stored snapshot; local serving only, no upstream requests or new ingestion",
              "snapshotId": snapshot, "window": window, "interval": manifest["interval"],
              "status": manifest["status"], "canonicalCount": manifest["count"],
              "polarCount": manifest["polarCount"], "databaseBytes": Path(database).stat().st_size,
              "upstreamRequests": 0, "upstreamTransactions": 0,
              "limits": "No browser frame/memory measurement, network latency, or new-source ingestion benchmark"}
    for label, zoom, x, y in (("world", 0, 0, 0), ("regional", 5, 18, 16)):
        started, cpu = time.perf_counter(), time.process_time()
        tile = service.tile(snapshot, window, zoom, x, y)
        cold, cpu_ms = (time.perf_counter() - started) * 1000, (time.process_time() - cpu) * 1000
        started = time.perf_counter()
        service.tile(snapshot, window, zoom, x, y)
        result[label] = {**tile[3], "coldMs": round(cold, 3), "coldCpuMs": round(cpu_ms, 3),
                         "warmMs": round((time.perf_counter() - started) * 1000, 3)}
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(20, viewers)) as pool:
        records = list(pool.map(lambda _: service.tile(snapshot, window, 0, 0, 0)[3]["observations"], range(viewers)))
    result["concurrentWarmReaders"] = {"readers": viewers, "wallMs": round((time.perf_counter() - started) * 1000, 3),
                                        "consistentCount": len(set(records)) == 1}
    result["cache"] = point_cache_statistics()
    
    
    
    _manifest, _snapshot, source, clauses, parameters, _filters, _interval = service._base(snapshot, window)
    tracemalloc.start()
    started = time.perf_counter()
    service._build(snapshot, source, clauses, parameters, 0, 0, 0, 32 * 1024 * 1024)
    result["pythonAllocationMeasurement"] = {
        "peakIncrementalTracedBytes": tracemalloc.get_traced_memory()[1],
        "tracedRebuildMs": round((time.perf_counter() - started) * 1000, 3),
        "note": "Separate allocation-traced rebuild; normal cold/warm timings above are uninstrumented. Existing cache bytes are reported separately."}
    tracemalloc.stop()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=os.environ.get("SHARP_GLOBAL_DB_PATH", str(ROOT / "src/backend_api/data/global-hotspots.sqlite")))
    parser.add_argument("--window", choices=("24h", "48h", "7d"), default="24h")
    parser.add_argument("--viewers", type=int, default=100)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if not 1 <= arguments.viewers <= 1000:
        parser.error("viewers must be between 1 and 1000")
    output = json.dumps(run(arguments.database, arguments.window, arguments.viewers), indent=2)
    if arguments.output:
        arguments.output.write_text(output + "\n", encoding="utf-8")
    print(output)
