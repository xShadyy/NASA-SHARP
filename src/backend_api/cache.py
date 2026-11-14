"""Disposable SQLite cache of unfiltered FIRMS product / area / UTC day batches."""

import json
import sqlite3
import time
import zlib
from contextlib import closing
from pathlib import Path

MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
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
            db.execute("CREATE INDEX IF NOT EXISTS batches_expires ON batches(expires)")
            db.execute("CREATE INDEX IF NOT EXISTS batches_accessed ON batches(accessed)")

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

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
