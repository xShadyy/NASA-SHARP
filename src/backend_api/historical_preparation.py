from __future__ import annotations

import asyncio
import calendar
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import closing
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta

from harmonize import AFTERNOON_IDS, METHOD_VERSION, detection_id, parse_utc_interval, prepared_area
from historical_activity import automatic_archive_path, geometry_key, load_archive, supports_geometry


class PreparationLimit(ValueError):
    pass


def _connect(path):
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA busy_timeout=30000")
    return db


def _metadata(db):
    return json.loads(db.execute("SELECT payload FROM metadata WHERE id=1").fetchone()[0])


def _save(db, manifest):
    db.execute("INSERT OR REPLACE INTO metadata VALUES(1,?)", (json.dumps(manifest),))


def _months(query, options):
    start, end = parse_utc_interval(query["interval"])
    today = datetime.now(UTC).date()
    count = max(3, min(5, int(os.environ.get("SHARP_HISTORY_BASELINE_YEARS", "3"))))
    selected = []
    cursor = start.replace(day=1)
    while cursor < end:
        selected.append((cursor.year, cursor.month))
        cursor = date(cursor.year + int(cursor.month == 12), cursor.month % 12 + 1, 1)
    if len(selected) > 12:
        raise PreparationLimit("Automatic loading is bounded to one selected year; existing multi-year historical data remains available.")
    result = []
    for offset in range(count + 1):
        for year, month in selected:
            if year-offset >= 2002 and date(year-offset, month, 1) <= today:
                result.append((year-offset, month))
    month = options.get("month")
    year = options.get("year", end.year)
    if month is not None:
        if type(month) is not int or not 1 <= month <= 12 or type(year) is not int or not 2002 <= year <= today.year:
            raise ValueError("Choose a valid historical month and year.")
        result.extend((start.year-offset, month) for offset in range(count+1)
                      if start.year-offset >= 2002 and date(start.year-offset, month, 1) <= today)
        if date(year, month, 1) <= today:
            result.append((year, month))
    if start.year < 2012:
        prior = today - timedelta(days=31)
        result.extend([(prior.year, prior.month), (today.year, today.month)])
    return list(dict.fromkeys(result))


def _initialize(path, query, months):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(_connect(path)) as db, db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
          CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS detections(id INTEGER PRIMARY KEY,record_id TEXT UNIQUE,acquired TEXT,platform TEXT,partition_key TEXT,payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS detection_time ON detections(acquired);
          CREATE INDEX IF NOT EXISTS history_partition ON detections(partition_key);
          CREATE TABLE IF NOT EXISTS coverage(day TEXT,platform TEXT,state TEXT,PRIMARY KEY(day,platform));
          CREATE TABLE IF NOT EXISTS history_requests(key TEXT PRIMARY KEY,state TEXT,fetched REAL,retry_at REAL);
        """)
        existing = db.execute("SELECT payload FROM metadata WHERE id=1").fetchone()
        manifest = json.loads(existing[0]) if existing else {
            "schemaVersion": 1, "methodVersion": METHOD_VERSION,
            "regionId": geometry_key(query["aoi"]["geometry"]),
            "regionName": query["aoi"].get("name") or query["aoi"].get("id") or "Selected area",
            "geometry": query["aoi"]["geometry"], "datasetVersion": "firms-regional-history-1",
            "sources": [], "generation": uuid.uuid4().hex,
            "importedAt": datetime.now(UTC).isoformat(), "automatic": True,
            "requestedMonths": [], "seededMonths": [],
        }
        requested = [tuple(value) for value in manifest.get("requestedMonths", [])]
        requested = list(dict.fromkeys([*months, *requested]))
        if len(requested) > max(12, int(os.environ.get("SHARP_HISTORY_MAX_MONTHS", "60"))):
            raise PreparationLimit("This area has reached its bounded automatic historical window; stored historical data remains available.")
        changed = requested != [tuple(value) for value in manifest.get("requestedMonths", [])]
        manifest["requestedMonths"] = requested
        if changed or not manifest.get("preparation"):
            manifest["preparation"] = {"state": "queued", "completed": 0, "total": 0,
                "message": "Preparing the selected seasonal months and three prior years."}
        elif (manifest["preparation"].get("refreshAfter") or float("inf")) <= time.time():
            manifest["preparation"] = {"state": "queued", "completed": 0, "total": 0,
                "message": "Updating recent reporting windows in the stored history."}
        _save(db, manifest)
    return manifest


def _progress(path, **values):
    with closing(_connect(path)) as db, db:
        manifest = _metadata(db)
        manifest["preparation"] = {**manifest.get("preparation", {}), **values, "updatedAt": datetime.now(UTC).isoformat()}
        _save(db, manifest)
        return manifest["preparation"]


def _seed(path, query):
    imported, store = load_archive()
    if store is None or not supports_geometry(imported, query["aoi"]["geometry"]):
        return
    with closing(_connect(path)) as db:
        manifest = _metadata(db)
    wanted = {tuple(value) for value in manifest["requestedMonths"]} - {tuple(value) for value in manifest.get("seededMonths", [])}
    if not wanted:
        return
    area = prepared_area(query["aoi"]["geometry"])
    rows = [row for row in store.rows if (row.acquired_at.year, row.acquired_at.month) in wanted and area.contains(row.longitude, row.latitude)]
    records = [record for record in store.coverage if (record.day.year, record.day.month) in wanted]
    with closing(_connect(path)) as db, db:
        for row in rows:
            payload = json.dumps({**asdict(row), "acquired_at": row.acquired_at.isoformat()})
            db.execute("INSERT OR REPLACE INTO detections(record_id,acquired,platform,partition_key,payload) VALUES(?,?,?,?,?)",
                       (detection_id(row), row.acquired_at.isoformat(), row.platform, "imported", payload))
        db.executemany("INSERT OR REPLACE INTO coverage VALUES(?,?,?)", [(r.day.isoformat(), r.platform, r.state) for r in records])
        manifest = _metadata(db)
        manifest["seededMonths"] = list({tuple(value) for value in manifest.get("seededMonths", [])} | wanted)
        if rows or records:
            manifest["sources"] = sorted(set(manifest["sources"]) | set(imported.get("sources", [])))
            manifest["generation"] = hashlib.sha256((manifest["generation"] + imported["generation"]).encode()).hexdigest()
        _save(db, manifest)


def _commit(path, key, rows, day, covered, coverage_state, product, complete):
    maximum = max(1000, int(os.environ.get("SHARP_HISTORY_MAX_RECORDS", "2000000")))
    with closing(_connect(path)) as db, db:
        db.execute("DELETE FROM detections WHERE partition_key=?", (key,))
        if db.execute("SELECT COUNT(*) FROM detections").fetchone()[0] + len(rows) > maximum:
            raise ValueError("The stored region reached its historical observation budget; choose a smaller area.")
        db.executemany("INSERT OR REPLACE INTO detections(record_id,acquired,platform,partition_key,payload) VALUES(?,?,?,?,?)",
            [(detection_id(row), row.acquired_at.isoformat(), row.platform, key,
              json.dumps({**asdict(row), "acquired_at": row.acquired_at.isoformat()})) for row in rows])
        if complete:
            db.executemany("INSERT OR REPLACE INTO coverage VALUES(?,?,?)", [(day.isoformat(), platform, coverage_state) for platform in covered])
        db.execute("INSERT OR REPLACE INTO history_requests VALUES(?,?,?,?)", (key, coverage_state, time.time(), 0))
        manifest = _metadata(db)
        manifest["sources"] = sorted(set(manifest["sources"]) | {product})
        manifest["generation"] = hashlib.sha256((manifest["generation"] + key + str(time.time_ns())).encode()).hexdigest()
        manifest["importedAt"] = datetime.now(UTC).isoformat()
        _save(db, manifest)


async def _run(app, query, path):
    from app import analysis_acquisition_boxes, feature_to_detection, load_batch, product_on, product_windows
    slots = getattr(app.state, "history_slots", None)
    if slots is None:
        app.state.history_slots = slots = asyncio.Semaphore(1)
    async with slots:
        owner = uuid.uuid4().hex
        name = "historical-area:" + geometry_key(query["aoi"]["geometry"])
        if not await asyncio.to_thread(app.state.global_store.lease, name, owner, 900):
            return
        async def heartbeat():
            while True:
                await asyncio.sleep(30)
                if not await asyncio.to_thread(app.state.global_store.lease, name, owner, 900):
                    return
        pulse = asyncio.create_task(heartbeat())
        try:
            await asyncio.to_thread(_seed, path, query)
            boxes = analysis_acquisition_boxes(query["aoi"]["geometry"])
            windows = await product_windows(app)
            area = prepared_area(query["aoi"]["geometry"])
            today = datetime.now(UTC).date()
            while True:
                with closing(_connect(path)) as db:
                    manifest = _metadata(db)
                    coverage = {(date.fromisoformat(day), platform): state for day, platform, state in db.execute("SELECT day,platform,state FROM coverage")}
                    completed = {key: state for key, state, fetched in db.execute("SELECT key,state,fetched FROM history_requests") if state in {"complete", "partial"} and fetched > time.time()-300}
                jobs = []
                for year, month in manifest["requestedMonths"]:
                    for number in range(1, calendar.monthrange(year, month)[1]+1):
                        day = date(year, month, number)
                        if day > today:
                            continue
                        products = {}
                        for platform in sorted(AFTERNOON_IDS):
                            if coverage.get((day, platform)) == "complete":
                                continue
                            product = product_on(platform, day, windows)
                            if product is not None:
                                products.setdefault(product, set()).add(platform)
                        for product, covered in products.items():
                            keys = [json.dumps([product.value, day.isoformat(), box]) for box in boxes]
                            if all(key in completed for key in keys):
                                continue
                            jobs.append((product, day, covered, keys))
                if not jobs:
                    has_coverage = any(state in {"complete", "partial"} for state in coverage.values())
                    await asyncio.to_thread(_progress, path, state="complete",
                        message="Available seasonal reporting data is stored." if has_coverage else "No supported historical reporting windows are available for this region and period.",
                        completed=manifest.get("preparation", {}).get("total", 0),
                        refreshAfter=time.time()+3600 if any(day == today and state != "complete" for (day, _), state in coverage.items()) else None)
                    break
                total = len(jobs)
                failures = 0
                paused = False
                await asyncio.to_thread(_progress, path, state="loading", completed=0, total=total,
                    message="Loading real satellite reporting data for this region.")
                for index, (product, day, covered, keys) in enumerate(jobs):
                    source_complete = True
                    states = [completed[key] for key in keys if key in completed]
                    for box, key in zip(boxes, keys):
                        if key in completed:
                            continue
                        try:
                            features, fetched, cached = await load_batch(app, product, box, day, today, require_complete=True)
                            rows = []
                            for feature in features:
                                row = feature_to_detection(feature)
                                if row is not None and row.platform in covered and row.acquired_at.date() == day and area.contains(row.longitude, row.latitude):
                                    rows.append(row)
                            state = "partial" if day == today else getattr(features, "coverage_state", "complete")
                            task = asyncio.create_task(asyncio.to_thread(_commit, path, key, rows, day, covered, state, product.value, False))
                            try:
                                await asyncio.shield(task)
                            except asyncio.CancelledError:
                                await task
                                raise
                            completed[key] = state
                            states.append(state)
                        except Exception as error:
                            if isinstance(error, ValueError):
                                raise
                            source_complete = False
                            failures += 1
                            text = str(error)
                            if any(word in text.lower() for word in ("quota", "budget", "rate limit", "reserved", "status")):
                                paused = True
                                await asyncio.to_thread(_progress, path, state="waiting", completed=index, total=total,
                                    message="Waiting for the shared data allowance; loaded history is retained.")
                                break
                            await asyncio.to_thread(_progress, path, state="partial", message="Some historical reporting dates are unavailable; available dates are retained.")
                    with closing(_connect(path)) as db, db:
                        state = "complete" if source_complete and day != today and states and all(value == "complete" for value in states) else "partial"
                        db.executemany("INSERT OR REPLACE INTO coverage VALUES(?,?,?)", [(day.isoformat(), platform, state) for platform in covered])
                        updated = _metadata(db)
                        updated["generation"] = hashlib.sha256((updated["generation"]+product.value+day.isoformat()+state).encode()).hexdigest()
                        _save(db, updated)
                    await asyncio.to_thread(_progress, path, completed=index+1, total=total, currentDate=day.isoformat())
                    if paused:
                        break
                    await asyncio.sleep(0)
                if failures:
                    await asyncio.to_thread(_progress, path, state="waiting" if paused else "partial", retryAt=time.time()+60,
                        message="Waiting for the shared data allowance; loaded history is retained." if paused else "Available historical dates are loaded. Remaining reporting windows will be retried.")
                    break
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message = "Historical data loading is waiting for the configured data service."
            if isinstance(error, ValueError):
                message = str(error)
            await asyncio.to_thread(_progress, path, state="unavailable", message=message)
        finally:
            pulse.cancel()
            await asyncio.gather(pulse, return_exceptions=True)
            await asyncio.to_thread(app.state.global_store.release, name, owner)


async def prepare_history(app, query, options=None):
    options = options or {}
    geometry = query["aoi"]["geometry"]
    from app import analysis_acquisition_boxes
    boxes = analysis_acquisition_boxes(geometry)
    area_size = sum(abs((float(box.split(",")[2])-float(box.split(",")[0]))*(float(box.split(",")[3])-float(box.split(",")[1]))) for box in boxes)
    if area_size > 60000:
        return {"state": "unavailable", "message": "Select a regional area to load historical seasons; worldwide backfills are not started."}
    try:
        months = _months(query, options)
    except PreparationLimit as error:
        return {"state": "unavailable", "message": str(error)}
    imported, stored = await asyncio.to_thread(load_archive)
    if stored is not None and supports_geometry(imported, geometry):
        complete = {record.day for record in stored.coverage if record.state == "complete" and record.platform in AFTERNOON_IDS}
        today = datetime.now(UTC).date()
        requested = [date(year, month, day) for year, month in months
            for day in range(1, calendar.monthrange(year, month)[1]+1) if date(year, month, day) <= today]
        if requested and all(day in complete for day in requested):
            return {"state": "complete", "message": "Stored seasonal reporting data is ready."}
    root = app.state.global_store.path.parent / "history"
    path = automatic_archive_path(query, root)
    try:
        manifest = await asyncio.to_thread(_initialize, path, query, months)
    except PreparationLimit as error:
        return {"state": "unavailable", "message": str(error)}
    progress = manifest.get("preparation", {})
    if progress.get("retryAt", 0) > time.time():
        return progress
    tasks = getattr(app.state, "history_tasks", None)
    if tasks is None:
        app.state.history_tasks = tasks = {}
    for key in list(tasks):
        if tasks[key].done():
            del tasks[key]
    key = str(path)
    if key not in tasks and progress.get("state") != "complete" and len(tasks) < 2:
        if not getattr(app.state, "key", ""):
            await asyncio.to_thread(_seed, path, query)
            with closing(_connect(path)) as db:
                states = {(date.fromisoformat(day), platform): state for day, platform, state in db.execute("SELECT day,platform,state FROM coverage")}
                manifest = _metadata(db)
            today = datetime.now(UTC).date()
            requested = [date(year, month, day) for year, month in manifest["requestedMonths"]
                for day in range(1, calendar.monthrange(year, month)[1]+1) if date(year, month, day) <= today]
            if requested and all(any(states.get((day, platform)) == "complete" for platform in AFTERNOON_IDS) for day in requested):
                return await asyncio.to_thread(_progress, path, state="complete", message="Stored seasonal reporting data is ready.")
            return await asyncio.to_thread(_progress, path, state="unavailable", message="Historical loading needs an available server data connection.")
        tasks[key] = asyncio.create_task(_run(app, query, path))
    return progress
