"""Durable, immutable global FIRMS partitions; no network work in readers.

All timestamps concern reports. Complete extraction does not imply cloud-free
observation coverage or confirmed absence of fire. Snapshot rows never mutate.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time
from itertools import islice
from contextlib import closing
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harmonize import CanonicalStore, Coverage, Detection, detection_id

WINDOWS = {"24h": 24, "48h": 48, "7d": 168}


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value


def utc(value):
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z") if isinstance(value, (int, float)) else value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def encode_detection(row):
    return json.dumps({**asdict(row), "acquired_at": utc(row.acquired_at)}, sort_keys=True, separators=(",", ":"), allow_nan=False)


def decode_detection(payload):
    values = json.loads(payload)
    values["acquired_at"] = instant(values["acquired_at"])
    return Detection(**values)


class GlobalStore:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get("SHARP_GLOBAL_DB_PATH", Path(__file__).parent / "data" / "global-hotspots.sqlite"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
              CREATE TABLE IF NOT EXISTS global_partition_versions(version TEXT PRIMARY KEY,source TEXT,day TEXT,start REAL,end REAL,retrieved REAL,coverage TEXT);
              CREATE TABLE IF NOT EXISTS global_current_partitions(source TEXT,day TEXT,version TEXT,PRIMARY KEY(source,day));
              CREATE TABLE IF NOT EXISTS global_observations(id INTEGER PRIMARY KEY,version TEXT NOT NULL,observation_id TEXT NOT NULL,acquired REAL NOT NULL,longitude REAL NOT NULL,latitude REAL NOT NULL,platform TEXT NOT NULL,frp REAL,payload TEXT NOT NULL,mx REAL,my REAL,UNIQUE(version,observation_id));
              CREATE INDEX IF NOT EXISTS global_rows_version_time ON global_observations(version,acquired);
              CREATE INDEX IF NOT EXISTS global_rows_identity ON global_observations(observation_id);
              CREATE VIRTUAL TABLE IF NOT EXISTS global_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
              CREATE TABLE IF NOT EXISTS global_sources(source TEXT PRIMARY KEY,payload TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS global_snapshots(snapshot TEXT PRIMARY KEY,published REAL NOT NULL,manifest TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS global_snapshot_partitions(snapshot TEXT,version TEXT,PRIMARY KEY(snapshot,version));
              CREATE TABLE IF NOT EXISTS global_snapshot_observations(snapshot TEXT,observation_id TEXT,row_id INTEGER,PRIMARY KEY(snapshot,observation_id));
              CREATE INDEX IF NOT EXISTS global_snapshot_rows ON global_snapshot_observations(snapshot,row_id);
              CREATE INDEX IF NOT EXISTS global_snapshot_version ON global_snapshot_partitions(version,snapshot);
              CREATE TABLE IF NOT EXISTS global_metadata(key TEXT PRIMARY KEY,value TEXT);
              CREATE TABLE IF NOT EXISTS global_leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS global_metrics(name TEXT PRIMARY KEY,value REAL NOT NULL);
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(global_observations)")}
            for field in ("mx", "my"):
                if field not in columns:
                    db.execute(f"ALTER TABLE global_observations ADD COLUMN {field} REAL")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        return db

    def metric(self, name, amount=1):
        with closing(self.connect()) as db, db:
            db.execute("INSERT INTO global_metrics VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value", (name, amount))

    def metrics(self):
        with closing(self.connect()) as db:
            return dict(db.execute("SELECT name,value FROM global_metrics"))

    def lease(self, name, owner, seconds=900, now=None):
        now = time.time() if now is None else now
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT owner,expires FROM global_leases WHERE name=?", (name,)).fetchone()
            if existing and existing["expires"] > now and existing["owner"] != owner:
                return False
            db.execute("INSERT OR REPLACE INTO global_leases VALUES(?,?,?)", (name, owner, now + seconds))
            return True

    def release(self, name, owner):
        with closing(self.connect()) as db, db:
            db.execute("DELETE FROM global_leases WHERE name=? AND owner=?", (name, owner))

    def source_state(self, source):
        with closing(self.connect()) as db:
            row = db.execute("SELECT payload FROM global_sources WHERE source=?", (source,)).fetchone()
        return json.loads(row[0]) if row else None

    def update_source_state(self, source, state):
        with closing(self.connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO global_sources VALUES(?,?)", (source, json.dumps(state, separators=(",", ":"))))

    def replace_source(self, source, rows, start, end, retrieved=None, metadata=None):
        """Replace whole retrieved windows atomically, retaining immutable old versions.

        Canonical ID = satellite+acquisition+original coordinate. For a collision,
        SP supersedes NRT supersedes RT supersedes URT; distinct satellites stay.
        Shifted-coordinate revisions cannot safely be inferred and are retained.
        """
        start, end = instant(start), instant(end)
        retrieved = time.time() if retrieved is None else retrieved
        grouped = {}
        day = start.date()
        while day <= (end - timedelta(microseconds=1)).date():
            grouped[day.isoformat()] = {}
            day += timedelta(days=1)
        rank = {"SP": 4, "standard": 4, "NRT": 3, "RT": 2, "URT": 1}
        guaranteed_start = instant((metadata or {}).get("coverageStart", start))
        guaranteed_end = instant((metadata or {}).get("coverageEndExclusive", end))
        for row in rows:
            if not start <= row.acquired_at < end:
                continue
            if row.frp_mw is not None and (not math.isfinite(row.frp_mw) or row.frp_mw < 0):
                row = replace(row, frp_mw=None)
            key, day = detection_id(row), row.acquired_at.date().isoformat()
            previous = grouped[day].get(key)
            if previous is None or rank.get(row.processing_tier, 0) >= rank.get(previous.processing_tier, 0):
                grouped[day][key] = row
        versions = []
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            for day, identities in sorted(grouped.items()):
                payloads = [(key, row, encode_detection(row)) for key, row in sorted(identities.items())]
                lower = max(start, datetime.fromisoformat(day).replace(tzinfo=UTC))
                upper = min(end, datetime.fromisoformat(day).replace(tzinfo=UTC) + timedelta(days=1))
                covered_lower, covered_upper = max(lower, guaranteed_start), min(upper, guaranteed_end)
                digest = hashlib.sha256(json.dumps([source, day, utc(lower), utc(upper), utc(min(covered_lower, upper)), utc(max(covered_upper, lower)), [p[2] for p in payloads]], separators=(",", ":")).encode()).hexdigest()
                versions.append(digest)
                exists = db.execute("SELECT 1 FROM global_partition_versions WHERE version=?", (digest,)).fetchone()
                if not exists:
                    coverage = "unknown" if covered_upper <= covered_lower else "complete" if covered_lower.hour == covered_lower.minute == covered_lower.second == covered_lower.microsecond == 0 and covered_upper - covered_lower == timedelta(days=1) else "partial"
                    db.execute("INSERT INTO global_partition_versions VALUES(?,?,?,?,?,?,?)", (digest, source, day, min(covered_lower, upper).timestamp(), max(covered_upper, lower).timestamp(), retrieved, coverage))
                    for key, row, payload in payloads:
                        mx = ((row.longitude + 180) / 360) % 1
                        lat = max(-85.0511287798066, min(85.0511287798066, row.latitude))
                        my = min(math.nextafter(1., 0.), max(0., (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2))
                        cursor = db.execute("INSERT INTO global_observations(version,observation_id,acquired,longitude,latitude,platform,frp,payload,mx,my) VALUES(?,?,?,?,?,?,?,?,?,?)", (digest, key, row.acquired_at.timestamp(), row.longitude, row.latitude, row.platform, row.frp_mw, payload, mx, my))
                        db.execute("INSERT INTO global_spatial VALUES(?,?,?,?,?)", (cursor.lastrowid, row.longitude, row.longitude, row.latitude, row.latitude))
                # Never replace a fully stored UTC day with a later partial download.
                old = db.execute("SELECT p.start,p.end FROM global_current_partitions c JOIN global_partition_versions p ON p.version=c.version WHERE c.source=? AND c.day=?", (source, day)).fetchone()
                if old and old["start"] < lower.timestamp() and old["end"] >= upper.timestamp():
                    continue
                db.execute("INSERT OR REPLACE INTO global_current_partitions VALUES(?,?,?)", (source, day, digest))
            state = {"source": source, "status": "ok", "retrievedAt": utc(retrieved), "coverageStart": utc(start), "coverageEndExclusive": utc(end), "latestAcquisition": max((utc(row.acquired_at) for rows in grouped.values() for row in rows.values()), default=None), **(metadata or {})}
            db.execute("INSERT OR REPLACE INTO global_sources VALUES(?,?)", (source, json.dumps(state, separators=(",", ":"))))
        return versions

    def record_failure(self, source, reason, now=None):
        state = self.source_state(source) or {"source": source}
        state.update(status="stale" if state.get("retrievedAt") else "unavailable", failure=reason, failedAt=utc(time.time() if now is None else now))
        self.update_source_state(source, state)
        self.metric("source_failures")

    def publish(self, anchor, sources, now=None):
        anchor = instant(anchor)
        now = time.time() if now is None else now
        lower = (anchor - timedelta(days=7)).timestamp()
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            partitions = [dict(row) for row in db.execute("SELECT p.* FROM global_current_partitions c JOIN global_partition_versions p ON p.version=c.version WHERE p.end>? AND p.start<? ORDER BY p.source,p.day", (lower, anchor.timestamp())) if row["source"] in sources]
            states = [json.loads(row[0]) for source in sources for row in db.execute("SELECT payload FROM global_sources WHERE source=?", (source,))]
            known = {state["source"] for state in states}
            states += [{"source": source, "status": "unavailable", "failure": "No successful global extraction stored."} for source in sources if source not in known]
            windows = {}
            for label, hours in WINDOWS.items():
                start = anchor - timedelta(hours=hours)
                complete = True
                for state in states:
                    cursor = start.timestamp()
                    for partition in sorted((p for p in partitions if p["source"] == state["source"] and p["coverage"] != "unknown"), key=lambda p: p["start"]):
                        if partition["start"] <= cursor and partition["end"] > cursor:
                            cursor = partition["end"]
                    if state.get("status") != "ok" or cursor < anchor.timestamp():
                        complete = False
                available = any(p["end"] > start.timestamp() for p in partitions)
                windows[label] = {"startUtc": utc(start), "endUtcExclusive": utc(anchor), "status": "ready" if complete else "partial" if available else "unavailable", "hours": hours}
            identity = {"anchorUtc": utc(anchor), "partitions": [{"source": p["source"], "day": p["day"], "generation": p["version"]} for p in partitions], "sources": states, "windows": windows}
            snapshot = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]
            status = windows["24h"]["status"]
            manifest = {**identity, "snapshot": snapshot, "generation": snapshot, "schemaVersion": "global-hotspots-1", "status": status, "completeness": "complete" if status == "ready" else "partial" if partitions else "unavailable", "publishedAt": utc(now), "retrievedAt": max((s.get("retrievedAt", "") for s in states), default=None) or None, "latestAcquisition": max((s.get("latestAcquisition") or "" for s in states), default=None) or None, "stale": any(s["status"] != "ok" for s in states), "processingTier": "NRT bulk extract; RT/URT not included unless explicitly imported", "supportedDisplayFilters": ["platform", "sensor", "dayNight", "frpMin", "frpMax"], "renderingExtent": {"latitude": [-85.05112878, 85.05112878], "polarObservationsRetained": True}, "coverageMeaning": "Retrieved reporting extraction, not cloud-free coverage or confirmed no-fire."}
            db.execute("INSERT OR IGNORE INTO global_snapshots VALUES(?,?,?)", (snapshot, now, json.dumps(manifest, separators=(",", ":"))))
            db.executemany("INSERT OR IGNORE INTO global_snapshot_partitions VALUES(?,?)", [(snapshot, p["version"]) for p in partitions])
            db.execute("""INSERT OR IGNORE INTO global_snapshot_observations(snapshot,observation_id,row_id)
                SELECT ?,observation_id,id FROM (
                  SELECT o.observation_id,o.id,ROW_NUMBER() OVER(PARTITION BY o.observation_id ORDER BY
                  CASE UPPER(COALESCE(json_extract(o.payload,'$.processing_tier'),'')) WHEN 'SP' THEN 4 WHEN 'STANDARD' THEN 4 WHEN 'NRT' THEN 3 WHEN 'RT' THEN 2 WHEN 'URT' THEN 1 ELSE 0 END DESC,o.id DESC) AS position
                  FROM global_observations o JOIN global_snapshot_partitions p ON p.version=o.version WHERE p.snapshot=?
                ) WHERE position=1""", (snapshot, snapshot))
            db.execute("INSERT OR REPLACE INTO global_metadata VALUES('current_snapshot',?)", (snapshot,))
        self.metric("snapshot_publications")
        self.prune(anchor)
        return manifest

    def prune(self, anchor=None):
        """Bound retained immutable snapshots and unreferenced partition history."""
        with closing(self.connect()) as db, db:
            db.execute("DELETE FROM global_snapshots WHERE snapshot IN (SELECT snapshot FROM global_snapshots ORDER BY published DESC,rowid DESC LIMIT -1 OFFSET ?)", (max(2, int(os.environ.get("SHARP_GLOBAL_RETAIN_SNAPSHOTS", "8"))),))
            db.execute("DELETE FROM global_snapshot_partitions WHERE snapshot NOT IN (SELECT snapshot FROM global_snapshots)")
            db.execute("DELETE FROM global_snapshot_observations WHERE snapshot NOT IN (SELECT snapshot FROM global_snapshots)")
            db.execute("DELETE FROM global_current_partitions WHERE day < ?", (((anchor or datetime.now(UTC)) - timedelta(days=max(8, int(os.environ.get("SHARP_GLOBAL_RETAIN_DAYS", "14"))))).date().isoformat(),))
            unused = "SELECT version FROM global_partition_versions WHERE version NOT IN (SELECT version FROM global_current_partitions) AND version NOT IN (SELECT version FROM global_snapshot_partitions)"
            db.execute("DELETE FROM global_spatial WHERE id IN (SELECT id FROM global_observations WHERE version IN (" + unused + "))")
            db.execute("DELETE FROM global_observations WHERE version IN (" + unused + ")")
            db.execute("DELETE FROM global_partition_versions WHERE version IN (" + unused + ")")

    def snapshot_manifest(self, snapshot_id, window="24h"):
        if window not in WINDOWS:
            raise ValueError("Supported stored windows are 24h, 48h and 7d.")
        with closing(self.connect()) as db:
            row = db.execute("SELECT manifest FROM global_snapshots WHERE snapshot=?", (snapshot_id,)).fetchone()
        if row is None:
            raise ValueError("Global snapshot is unavailable; reload the dataset manifest.")
        manifest = json.loads(row[0])
        selected = manifest["windows"][window]
        stale_seconds = int(os.environ.get("SHARP_GLOBAL_STALE_SECONDS", "3600"))
        stale = manifest["stale"] or time.time() - instant(manifest["publishedAt"]).timestamp() > stale_seconds or time.time() - instant(manifest["anchorUtc"]).timestamp() > stale_seconds
        return {**manifest, "window": window, "interval": selected, "status": selected["status"], "stale": stale}

    def current_manifest(self, window="24h"):
        with closing(self.connect()) as db:
            row = db.execute("SELECT value FROM global_metadata WHERE key='current_snapshot'").fetchone()
        if not row:
            return {"status": "unavailable", "snapshot": None, "window": window, "reason": "Global observations have not been published. The designated ingestion worker must complete its first refresh.", "windows": {}, "sources": []}
        return self.snapshot_manifest(row[0], window)

    def iter_observations(self, snapshot_id, window="24h", bbox=None, filters=None):
        manifest = self.snapshot_manifest(snapshot_id, window)
        start, end = (instant(manifest["interval"][key]).timestamp() for key in ("startUtc", "endUtcExclusive"))
        params = [snapshot_id, start, end]
        where = ["s.snapshot=?", "o.acquired>=?", "o.acquired<?"]
        if bbox:
            west, south, east, north = bbox
            if west <= east:
                where += ["o.longitude>=?", "o.longitude<=?"]
                params += [west, east]
            else:
                where += ["(o.longitude>=? OR o.longitude<=?)"]
                params += [west, east]
            where += ["o.latitude>=?", "o.latitude<=?"]
            params += [south, north]
        with closing(self.connect()) as db:
            # Snapshot partitions are disjoint source/day windows; ID tie collapse
            # prevents exact cross-product duplicates while preserving platforms.
            cursor = db.execute("SELECT o.observation_id,o.payload FROM global_observations o JOIN global_snapshot_observations s ON s.row_id=o.id WHERE " + " AND ".join(where) + " ORDER BY o.observation_id", params)
            previous = None
            for row in cursor:
                if row[0] == previous:
                    continue
                previous = row[0]
                detection = decode_detection(row[1])
                if filters:
                    if filters.get("platform") and detection.platform != filters["platform"]: continue
                    if filters.get("platforms") and detection.platform not in filters["platforms"]: continue
                    sensor = "MODIS" if detection.platform in {"terra", "aqua"} else "VIIRS"
                    if filters.get("sensor") and filters["sensor"] != sensor: continue
                    daynight = "day" if detection.day_night == "D" else "night" if detection.day_night == "N" else "unknown"
                    if filters.get("dayNight") and filters["dayNight"] != daynight: continue
                    if filters.get("frpMin") is not None and (detection.frp_mw is None or detection.frp_mw < float(filters["frpMin"])): continue
                    if filters.get("frpMax") is not None and (detection.frp_mw is None or detection.frp_mw > float(filters["frpMax"])): continue
                yield detection

    def canonical_store(self, snapshot_id=None, window="24h", bbox=None, filters=None, max_rows=None):
        snapshot_id = snapshot_id or self.current_manifest(window).get("snapshot")
        if not snapshot_id:
            return CanonicalStore((), (), "Global observations unavailable")
        manifest = self.snapshot_manifest(snapshot_id, window)
        records = self.iter_observations(snapshot_id, window, bbox, filters)
        rows = tuple(islice(records, max_rows + 1)) if max_rows is not None else tuple(records)
        if max_rows is not None and len(rows) > max_rows:
            records.close()
            raise ValueError(f"Stored AOI exceeds the budget of {max_rows:,} canonical observations; choose a smaller area or shorter interval.")
        with closing(self.connect()) as db:
            coverage = []
            for p in db.execute("SELECT p.* FROM global_partition_versions p JOIN global_snapshot_partitions s ON s.version=p.version WHERE s.snapshot=?", (snapshot_id,)):
                platforms = {row.platform for row in rows if row.source_product == p["source"]}
                # Explicit source identity supplies coverage even for valid zeroes.
                platforms.update({"MODIS_NRT": {"terra", "aqua"}, "VIIRS_NOAA20_NRT": {"noaa-20"}, "VIIRS_NOAA21_NRT": {"noaa-21"}, "VIIRS_SNPP_NRT": {"suomi-npp"}}.get(p["source"], set()))
                coverage.extend(Coverage(datetime.fromisoformat(p["day"]).date(), platform, p["coverage"]) for platform in platforms)
        return CanonicalStore(rows, tuple(coverage), "Published global snapshot " + snapshot_id, instant(manifest["retrievedAt"]).timestamp() if manifest.get("retrievedAt") else None, instant(manifest["publishedAt"]).timestamp() + 3600, True)
