
from __future__ import annotations

import hashlib
import json
import math
import struct
import threading
import time
import zlib
from collections import OrderedDict
from contextlib import closing

from global_point_tiles import _spatial_predicate
from global_tiles import GlobalPresentation, MERCATOR_LIMIT, SnapshotUnavailable, _filter_sql
from harmonize import RejectedQuery

RASTER_STYLE = "red-pixels-3"
RASTER_SIZE = 512
RASTER_MAX_ZOOM = 18
MAX_CACHE_BYTES = 32 * 1024 * 1024
MAX_CACHE_ENTRIES = 256
_CACHE = OrderedDict()
_CACHE_BYTES = 0
_LOCK = threading.RLock()
_BUILD_LOCKS = [threading.Lock() for _ in range(32)]
_RENDER_SLOTS = threading.BoundedSemaphore(2)
_STATS = {"requests": 0, "hits": 0, "generated": 0, "renderSqlQueries": 0,
          "rendering": 0, "peakRendering": 0}
_RED = b"\xff\x00\x00\xff"
_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def raster_cache_statistics():
    with _LOCK:
        return {**_STATS, "entries": len(_CACHE), "bytes": _CACHE_BYTES,
                "scope": "current serving process", "style": RASTER_STYLE,
                "tileSize": RASTER_SIZE, "renderConcurrency": 2}


def raster_pixel_size(zoom):
    if zoom >= 13:
        return 14
    if zoom >= 10:
        return 10
    if zoom >= 6:
        return 6
    return 4


def _chunk(name, payload):
    return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload))


def _png(pixels):
    header = struct.pack(">IIBBBBB", RASTER_SIZE, RASTER_SIZE, 8, 6, 0, 0, 0)
    return (_SIGNATURE + _chunk(b"IHDR", header) +
            _chunk(b"IDAT", zlib.compress(pixels, 6)) + _chunk(b"IEND", b""))


class GlobalRasterPresentation(GlobalPresentation):
    def tile(self, snapshot, window, style, z, x, y, filters=None, aggregate=None, interval=None):
        if style != RASTER_STYLE:
            raise RejectedQuery("The requested global pixel style is unsupported.")
        if (any(type(value) is not int for value in (z, x, y)) or
                not 0 <= z <= RASTER_MAX_ZOOM or
                not 0 <= x < 2 ** z or not 0 <= y < 2 ** z):
            raise RejectedQuery("Invalid global raster tile coordinates.")
        filters = {} if filters is None else filters
        if not isinstance(filters, dict):
            raise RejectedQuery("Observation filters must be an object.")
        _manifest, snapshot, source, clauses, parameters, _filters, _interval = self._base(
            snapshot, window, aggregate=aggregate, display_filters=filters, interval=interval)
        if aggregate:
            additional, values = _filter_sql(filters)
            clauses.extend(additional)
            parameters.extend(values)
        cache_key = (str(self.store.path), snapshot, window, style, z, x, y,
                     json.dumps(filters, sort_keys=True, separators=(",", ":")), aggregate,
                     _interval["start"], _interval["endExclusive"])
        with _LOCK:
            _STATS["requests"] += 1
            remembered = _CACHE.get(cache_key)
            if remembered is not None:
                _STATS["hits"] += 1
                _CACHE.move_to_end(cache_key)
                return remembered
        with _BUILD_LOCKS[hash(cache_key) % len(_BUILD_LOCKS)]:
            with _LOCK:
                remembered = _CACHE.get(cache_key)
                if remembered is not None:
                    _STATS["hits"] += 1
                    _CACHE.move_to_end(cache_key)
                    return remembered
            with _RENDER_SLOTS:
                with _LOCK:
                    _STATS["rendering"] += 1
                    _STATS["peakRendering"] = max(_STATS["peakRendering"], _STATS["rendering"])
                try:
                    result = self._build(snapshot, source, clauses, parameters, z, x, y)
                finally:
                    with _LOCK:
                        _STATS["rendering"] -= 1
            global _CACHE_BYTES
            with _LOCK:
                _STATS["generated"] += 1
                _CACHE[cache_key] = result
                _CACHE_BYTES += len(result[0])
                while len(_CACHE) > MAX_CACHE_ENTRIES or _CACHE_BYTES > MAX_CACHE_BYTES:
                    _old_key, old = _CACHE.popitem(last=False)
                    _CACHE_BYTES -= len(old[0])
            return result

    def _build(self, snapshot, source, clauses, parameters, z, x, y):
        started = time.perf_counter()
        scale = 2 ** z
        size = raster_pixel_size(z)
        padding = size / RASTER_SIZE
        bounds = ((x - padding) / scale, max(0., (y - padding) / scale),
                  (x + 1 + padding) / scale, min(1., (y + 1 + padding) / scale))
        if z > 2:
            spatial, values = _spatial_predicate(bounds)
            clauses.append(spatial)
            parameters.extend(values)
        elif z:
            
            
            
            west, north, east, south = bounds
            if west < 0:
                intervals = [(0., east), (west + 1, 1.)]
            elif east > 1:
                intervals = [(west, 1.), (0., east - 1)]
            else:
                intervals = [(west, east)]
            clauses.append("(" + " OR ".join("(o.mx>=? AND o.mx<=?)" for _ in intervals) + ")")
            parameters.extend(coordinate for interval in intervals for coordinate in interval)
            clauses.extend(["o.my>=?", "o.my<=?"])
            parameters.extend([north, south])
        clauses.extend(["o.latitude>=?", "o.latitude<=?"])
        parameters.extend([-MERCATOR_LIMIT, MERCATOR_LIMIT])
        statement = ("SELECT o.mx,o.my FROM " + source + " WHERE " +
                     " AND ".join(clauses))
        
        
        stride = RASTER_SIZE * 4 + 1
        pixels = bytearray(stride * RASTER_SIZE)
        observations = visited = 0
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                raise SnapshotUnavailable("Global snapshot expired before its raster tile could load; refresh the dataset manifest.")
            with _LOCK:
                _STATS["renderSqlQueries"] += 2
            for mx, my in db.execute(statement, parameters):
                if mx is None or my is None:
                    raise RejectedQuery("Stored observations need their Mercator index rebuilt before pixel rendering.")
                if not bounds[1] <= my <= bounds[3]:
                    continue
                positions = [mx + shift for shift in (-1, 0, 1)
                             if bounds[0] <= mx + shift <= bounds[2]]
                if not positions:
                    continue
                visited += 1
                if x / scale <= mx < (x + 1) / scale and y / scale <= my < (y + 1) / scale:
                    observations += 1
                center_y = (my * scale - y) * RASTER_SIZE
                top = math.floor(center_y - size / 2)
                first_y, last_y = max(0, top), min(RASTER_SIZE, top + size)
                if first_y >= last_y:
                    continue
                for position in positions:
                    center_x = (position * scale - x) * RASTER_SIZE
                    left = math.floor(center_x - size / 2)
                    first_x, last_x = max(0, left), min(RASTER_SIZE, left + size)
                    if first_x >= last_x:
                        continue
                    run = _RED * (last_x - first_x)
                    for row in range(first_y, last_y):
                        offset = row * stride + 1 + first_x * 4
                        pixels[offset:offset + len(run)] = run
        body = _png(pixels)
        return (body, hashlib.sha256(body).hexdigest(),
                {"generationMs": (time.perf_counter() - started) * 1000,
                 "bytes": len(body), "observations": observations, "visitedRecords": visited,
                 "pixelSize": size, "snapshotId": snapshot, "renderSqlQueries": 2})


def prewarm_global_raster(store, snapshot, window="24h"):
    
    started = time.perf_counter()
    service = GlobalRasterPresentation(store)
    tiles = [(0, 0, 0), *( (1, x, y) for x in range(2) for y in range(2) )]
    results = [service.tile(snapshot, window, RASTER_STYLE, *tile) for tile in tiles]
    return {"snapshotId": snapshot, "window": window, "tiles": len(results),
            "bytes": sum(len(result[0]) for result in results),
            "elapsedMs": (time.perf_counter() - started) * 1000}
