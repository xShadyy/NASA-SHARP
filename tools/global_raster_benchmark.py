"""Explicit read-only PNG serving measurements, never imported by unit tests."""
import threading
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor

from global_point_benchmark import ReadOnlyGlobalStore
from global_raster import GlobalRasterPresentation, RASTER_STYLE, prewarm_global_raster, raster_cache_statistics


class MeasuredReadOnlyStore(ReadOnlyGlobalStore):
    def __init__(self, path):
        super().__init__(path)
        self.query_lock = threading.Lock()
        self.select_queries = 0

    def connect(self):
        connection = super().connect()
        def counted(statement):
            if statement.lstrip().upper().startswith("SELECT"):
                with self.query_lock:
                    self.select_queries += 1
        connection.set_trace_callback(counted)
        return connection


def run(database, window="24h", viewers=100):
    store = MeasuredReadOnlyStore(database)
    service = GlobalRasterPresentation(store)
    manifest = service.manifest(window)
    snapshot = manifest.get("snapshotId")
    if not snapshot:
        raise ValueError("No ready stored snapshot exists for this interval.")
    result = {"kind": "Read-only real immutable snapshot; local PNG rendering and serving, no upstream requests or new ingestion",
              "snapshotId": snapshot, "window": window, "interval": manifest["interval"],
              "status": manifest["status"], "canonicalCount": manifest["count"], "polarCount": manifest["polarCount"],
              "databaseBytes": store.path.stat().st_size, "upstreamRequests": 0, "upstreamTransactions": 0,
              "limits": "Uninstrumented local serving time; no browser frame/memory or external network measurement. All SQL SELECTs including per-request snapshot validation are counted."}
    for label, zoom, x, y in (("world", 0, 0, 0), ("denseRegion", 2, 2, 1), ("region", 5, 18, 16), ("closeZoom", 12, 2257, 1797)):
        query_start = store.select_queries
        started, cpu = time.perf_counter(), time.process_time()
        tile = service.tile(snapshot, window, RASTER_STYLE, zoom, x, y)
        cold, cpu_ms = (time.perf_counter() - started) * 1000, (time.process_time() - cpu) * 1000
        cold_queries = store.select_queries - query_start
        query_start = store.select_queries
        started = time.perf_counter()
        service.tile(snapshot, window, RASTER_STYLE, zoom, x, y)
        result[label] = {**tile[2], "coldMs": round(cold, 3), "coldCpuMs": round(cpu_ms, 3),
                         "coldSelectQueries": cold_queries, "warmMs": round((time.perf_counter() - started) * 1000, 3),
                         "warmSelectQueries": store.select_queries - query_start}
    for label, zoom, x, y in (("concurrentColdReaders", 1, 0, 0), ("concurrentWarmReaders", 0, 0, 0)):
        before, query_start = raster_cache_statistics(), store.select_queries
        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=min(20, viewers)) as pool:
            records = list(pool.map(lambda _: service.tile(snapshot, window, RASTER_STYLE, zoom, x, y), range(viewers)))
        after = raster_cache_statistics()
        result[label] = {"readers": viewers, "wallMs": round((time.perf_counter() - started) * 1000, 3),
                         "consistentCount": len({record[2]["observations"] for record in records}) == 1,
                         "generatedTiles": after["generated"] - before["generated"], "cacheHits": after["hits"] - before["hits"],
                         "selectQueries": store.select_queries - query_start,
                         "bytesPerResponse": len(records[0][0]), "responsesBytes": sum(len(record[0]) for record in records)}
    before = raster_cache_statistics()
    result["overviewPrewarm"] = prewarm_global_raster(store, snapshot, window)
    after = raster_cache_statistics()
    result["overviewPrewarm"].update(generatedTiles=after["generated"] - before["generated"],
                                      cacheHits=after["hits"] - before["hits"])
    result["cache"] = raster_cache_statistics()
    _manifest, _snapshot, source, clauses, parameters, _filters, _interval = service._base(snapshot, window)
    tracemalloc.start()
    started = time.perf_counter()
    service._build(snapshot, source, clauses, parameters, 0, 0, 0)
    result["pythonAllocationMeasurement"] = {
        "peakIncrementalTracedBytes": tracemalloc.get_traced_memory()[1],
        "tracedRebuildMs": round((time.perf_counter() - started) * 1000, 3),
        "note": "Separate allocation-traced rebuild; normal cold/warm timings above are uninstrumented."}
    tracemalloc.stop()
    return result
