
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import threading
import time
from collections import OrderedDict
from contextlib import closing

from global_tiles import GlobalPresentation, MERCATOR_LIMIT, SnapshotUnavailable, _filter_sql, severity
from harmonize import RejectedQuery

POINT_SCHEMA = "global-observation-points-1"
POINT_LAYER = "observations"
POINT_EXTENT = 65536
POINT_MAX_ZOOM = 18


POINT_BUFFER = 1024
MAX_CACHE_BYTES = 32 * 1024 * 1024
MAX_CACHE_ENTRIES = 128
_CACHE = OrderedDict()
_CACHE_BYTES = 0
_LOCK = threading.RLock()
_BUILD_LOCKS = [threading.Lock() for _ in range(32)]
_STATS = {"requests": 0, "hits": 0, "generated": 0}
_SEVERITIES = ("unknown", "low", "moderate", "high")
_SEVERITY_INDEX = {value: index for index, value in enumerate(_SEVERITIES)}


class PointTileTooLarge(RejectedQuery):
    pass


def point_cache_statistics():
    with _LOCK:
        return {**_STATS, "entries": len(_CACHE), "bytes": _CACHE_BYTES,
                "scope": "current serving process", "schema": POINT_SCHEMA}


def _varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def _message(field, body):
    return _varint((field << 3) | 2) + _varint(len(body)) + body


def _zigzag(value):
    return (value << 1) ^ (value >> 31)


def _feature(row_id, power, points):
    
    
    geometry = bytearray(_varint((len(points) << 3) | 1))
    previous_x = previous_y = 0
    for x, y in points:
        geometry.extend(_varint(_zigzag(x - previous_x)))
        geometry.extend(_varint(_zigzag(y - previous_y)))
        previous_x, previous_y = x, y
    tags = b"\x00" + _varint(_SEVERITY_INDEX[severity(power)])
    return (b"\x08" + _varint(row_id) + _message(2, tags) +
            b"\x18\x01" + _message(4, geometry))


def _latitude(normalized_y):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * normalized_y))))


def _tile_bounds(z, x, y):
    scale = 2 ** z
    padding = POINT_BUFFER / POINT_EXTENT
    return ((x - padding) / scale, max(0., (y - padding) / scale),
            (x + 1 + padding) / scale, min(1., (y + 1 + padding) / scale))


def _spatial_predicate(bounds):
    
    west, north, east, south = bounds
    if east - west >= 1:
        intervals = [(0., 1.)]
    elif west < 0:
        intervals = [(0., east), (west + 1, 1.)]
    elif east > 1:
        intervals = [(west, 1.), (0., east - 1)]
    else:
        intervals = [(west, east)]
    longitude = " OR ".join("(max_lon>=? AND min_lon<=?)" for _ in intervals)
    values = [coordinate * 360 - 180 for interval in intervals for coordinate in interval]
    
    
    values.extend([_latitude(south), _latitude(north)])
    return ("o.id IN (SELECT id FROM global_spatial WHERE (" + longitude +
            ") AND max_lat>=? AND min_lat<=?)", values)


class GlobalPointPresentation(GlobalPresentation):
    def tile(self, snapshot, window, z, x, y, filters=None, aggregate=None):
        if (any(type(value) is not int for value in (z, x, y)) or
                not 0 <= z <= POINT_MAX_ZOOM or
                not 0 <= x < 2 ** z or not 0 <= y < 2 ** z):
            raise RejectedQuery("Invalid global point tile coordinates.")
        filters = {} if filters is None else filters
        if not isinstance(filters, dict):
            raise RejectedQuery("Observation filters must be an object.")
        temporary_filters = filters
        _manifest, snapshot, source, clauses, parameters, _filters, _interval = self._base(
            snapshot, window, aggregate=aggregate, display_filters=filters)
        if aggregate:
            
            
            additional, values = _filter_sql(temporary_filters)
            clauses.extend(additional)
            parameters.extend(values)
        max_bytes = int(os.environ.get("SHARP_GLOBAL_POINT_TILE_MAX_BYTES", str(32 * 1024 * 1024)))
        if not 1024 <= max_bytes <= 128 * 1024 * 1024:
            raise RejectedQuery("Point tile byte budget must be between 1024 and 134217728 bytes.")
        cache_key = (str(self.store.path), snapshot, window, z, x, y,
                     json.dumps(filters, sort_keys=True, separators=(",", ":")), aggregate,
                     POINT_SCHEMA, max_bytes)
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
            result = self._build(snapshot, source, clauses, parameters, z, x, y, max_bytes)
            global _CACHE_BYTES
            with _LOCK:
                _STATS["generated"] += 1
                result_bytes = len(result[0]) + len(result[1])
                if result_bytes <= MAX_CACHE_BYTES:
                    _CACHE[cache_key] = result
                    _CACHE_BYTES += result_bytes
                    while len(_CACHE) > MAX_CACHE_ENTRIES or _CACHE_BYTES > MAX_CACHE_BYTES:
                        _old_key, old = _CACHE.popitem(last=False)
                        _CACHE_BYTES -= len(old[0]) + len(old[1])
            return result

    def _build(self, snapshot, source, clauses, parameters, z, x, y, max_bytes):
        started = time.perf_counter()
        scale = 2 ** z
        bounds = _tile_bounds(z, x, y)
        if z > 0:
            
            
            
            spatial, values = _spatial_predicate(bounds)
            clauses.append(spatial)
            parameters.extend(values)
        clauses.extend(["o.latitude>=?", "o.latitude<=?"])
        parameters.extend([-MERCATOR_LIMIT, MERCATOR_LIMIT])
        statement = ("SELECT o.id,o.mx,o.my,o.frp FROM " + source +
                     " WHERE " + " AND ".join(clauses) + " ORDER BY o.id")
        
        
        layer = bytearray(b"\x78\x02" + _message(1, POINT_LAYER.encode()))
        features = core_count = geometries = 0
        with closing(self.store.connect()) as db:
            
            
            
            db.execute("BEGIN")
            if db.execute("SELECT 1 FROM global_snapshots WHERE snapshot=?", (snapshot,)).fetchone() is None:
                raise SnapshotUnavailable("Global snapshot expired before its point tile could load; refresh the dataset manifest.")
            for row_id, mx, my, power in db.execute(statement, parameters):
                if mx is None or my is None:
                    raise RejectedQuery("Stored observations need their Mercator index rebuilt before point rendering.")
                if not bounds[1] <= my <= bounds[3]:
                    continue
                positions = [mx + shift for shift in (-1, 0, 1)
                             if bounds[0] <= mx + shift <= bounds[2]]
                if not positions:
                    continue
                
                
                if x / scale <= mx < (x + 1) / scale and y / scale <= my < (y + 1) / scale:
                    core_count += 1
                points = [(round((position * scale - x) * POINT_EXTENT),
                           round((my * scale - y) * POINT_EXTENT)) for position in positions]
                feature = _message(2, _feature(row_id, power, points))
                if len(layer) + len(feature) + 160 > max_bytes:
                    raise PointTileTooLarge(
                        "Individual observation tile exceeds its configured byte budget. "
                        "No records were sampled or omitted; increase the serving budget or use a shorter supported interval.")
                layer.extend(feature)
                features += 1
                geometries += len(points)
        layer.extend(_message(3, b"severity"))
        for value in _SEVERITIES:
            layer.extend(_message(4, _message(1, value.encode())))
        layer.extend(b"\x28" + _varint(POINT_EXTENT))
        body = _message(3, layer)
        compressed = gzip.compress(body, compresslevel=5, mtime=0)
        return (body, compressed, hashlib.sha256(body).hexdigest(),
                {"generationMs": (time.perf_counter() - started) * 1000,
                 "bytes": len(body), "gzipBytes": len(compressed),
                 "observations": core_count, "features": features,
                 "bufferedGeometries": geometries, "snapshotId": snapshot})
