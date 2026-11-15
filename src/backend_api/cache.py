"""Disposable SQLite cache of unfiltered FIRMS product / area / UTC day batches."""

import json
import sqlite3
import time
import zlib
from contextlib import closing
from pathlib import Path

MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
MAX_SUMMARY_COMPRESSED_BYTES = 32 * 1024 * 1024
SCHEMA_VERSION = 1


class BatchCache:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS batches (
                    key TEXT PRIMARY KEY,
                    fetched REAL NOT NULL,
                    expires REAL NOT NULL,
                    accessed REAL NOT NULL,
                    body BLOB NOT NULL
                )
            """)
            old_summary_table = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_summaries'"
            ).fetchone()
            new_summary_table = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'area_analytics_summaries'"
            ).fetchone()
            if old_summary_table and new_summary_table:
                db.execute("""
                    INSERT OR IGNORE INTO area_analytics_summaries
                    SELECT * FROM dashboard_summaries
                """)
                db.execute("DROP TABLE dashboard_summaries")
            elif old_summary_table:
                db.execute(
                    "ALTER TABLE dashboard_summaries RENAME TO area_analytics_summaries"
                )
            db.execute("DROP INDEX IF EXISTS dashboard_summaries_batch")
            db.execute("DROP INDEX IF EXISTS dashboard_summaries_accessed")
            db.execute("""
                CREATE TABLE IF NOT EXISTS area_analytics_summaries (
                    key TEXT PRIMARY KEY,
                    batch_key TEXT NOT NULL REFERENCES batches(key) ON DELETE CASCADE,
                    fetched REAL NOT NULL,
                    accessed REAL NOT NULL,
                    body BLOB NOT NULL
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS batches_expires ON batches(expires)")
            db.execute("CREATE INDEX IF NOT EXISTS batches_accessed ON batches(accessed)")
            db.execute(
                "CREATE INDEX IF NOT EXISTS area_analytics_summaries_batch "
                "ON area_analytics_summaries(batch_key, fetched)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS area_analytics_summaries_accessed "
                "ON area_analytics_summaries(accessed)"
            )

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @staticmethod
    def key(source: str, area: str, day: str) -> str:
        return json.dumps([SCHEMA_VERSION, source, area, day], separators=(",", ":"))

    def get(self, key: str) -> tuple[list[dict], float] | None:
        now = time.time()
        with closing(self.connect()) as db, db:
            row = db.execute(
                "SELECT body, fetched FROM batches WHERE key = ? AND expires > ?", (key, now)
            ).fetchone()
            if row is None:
                return None
            db.execute("UPDATE batches SET accessed = MAX(accessed, ?) WHERE key = ?", (now, key))
        body, fetched = row
        return json.loads(zlib.decompress(body)), fetched

    def expires_at(self, key: str, fetched: float) -> float | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT expires FROM batches WHERE key = ? AND fetched = ?", (key, fetched)).fetchone()
        return float(row[0]) if row is not None else None

    def put(self, key: str, features: list[dict], fetched: float, ttl: int):
        body = zlib.compress(json.dumps(features, separators=(",", ":")).encode())
        if len(body) > MAX_COMPRESSED_BYTES:
            return
        with closing(self.connect()) as db, db:
            db.execute(
                """
                INSERT INTO batches VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    fetched = excluded.fetched, expires = excluded.expires,
                    accessed = excluded.accessed, body = excluded.body
                WHERE excluded.fetched >= batches.fetched
                """,
                (key, fetched, fetched + ttl, fetched, body),
            )
            db.execute("DELETE FROM batches WHERE expires <= ?", (time.time(),))
            db.execute(
                """
                DELETE FROM batches WHERE key IN (
                    SELECT key FROM (
                        SELECT key, SUM(length(body)) OVER (
                            ORDER BY accessed DESC, key
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS running_bytes FROM batches
                    ) WHERE running_bytes > ?
                )
                """,
                (MAX_COMPRESSED_BYTES,),
            )
            db.execute(
                """
                DELETE FROM area_analytics_summaries
                WHERE batch_key = ? AND fetched != ?
                """,
                (key, fetched),
            )
            db.execute("""
                DELETE FROM area_analytics_summaries AS s
                WHERE NOT EXISTS (
                    SELECT 1 FROM batches AS b
                    WHERE b.key = s.batch_key AND b.fetched = s.fetched
                )
            """)
            self._prune_summaries(db)

    def get_summary(self, key: str, batch_key: str) -> tuple[str, float] | None:
        now = time.time()
        with closing(self.connect()) as db, db:
            row = db.execute(
                """
                SELECT s.body, s.fetched
                FROM area_analytics_summaries AS s
                JOIN batches AS b ON b.key = s.batch_key AND b.fetched = s.fetched
                WHERE s.key = ? AND s.batch_key = ? AND b.expires > ?
                """,
                (key, batch_key, now),
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE area_analytics_summaries SET accessed = MAX(accessed, ?) WHERE key = ?",
                (now, key),
            )
            db.execute(
                "UPDATE batches SET accessed = MAX(accessed, ?) WHERE key = ?",
                (now, batch_key),
            )
        body, fetched = row
        try:
            return zlib.decompress(body).decode("utf-8"), fetched
        except (UnicodeError, zlib.error):
            with closing(self.connect()) as db, db:
                db.execute("DELETE FROM area_analytics_summaries WHERE key = ?", (key,))
            return None

    def put_summary(self, key: str, batch_key: str, payload: str, fetched: float) -> None:
        body = zlib.compress(payload.encode())
        if len(body) > MAX_SUMMARY_COMPRESSED_BYTES:
            return
        with closing(self.connect()) as db, db:
            db.execute(
                """
                INSERT INTO area_analytics_summaries (key, batch_key, fetched, accessed, body)
                SELECT ?, ?, ?, ?, ?
                WHERE EXISTS (
                    SELECT 1 FROM batches WHERE key = ? AND fetched = ?
                )
                ON CONFLICT(key) DO UPDATE SET
                    batch_key = excluded.batch_key, fetched = excluded.fetched,
                    accessed = excluded.accessed, body = excluded.body
                WHERE excluded.fetched >= area_analytics_summaries.fetched
                """,
                (key, batch_key, fetched, fetched, body, batch_key, fetched),
            )
            self._prune_summaries(db)

    @staticmethod
    def _prune_summaries(db: sqlite3.Connection) -> None:
        db.execute(
            """
            DELETE FROM area_analytics_summaries WHERE key IN (
                SELECT key FROM (
                    SELECT key, SUM(length(body)) OVER (
                        ORDER BY accessed DESC, key
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS running_bytes FROM area_analytics_summaries
                ) WHERE running_bytes > ?
            )
            """,
            (MAX_SUMMARY_COMPRESSED_BYTES,),
        )
