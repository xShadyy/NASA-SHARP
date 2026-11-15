"""Persistent shared MAP_KEY reservations and provider-status reconciliation.

Estimated transaction costs intentionally exceed the official examples. They
remain estimates: provider usage, other applications and unknown pricing can
close the circuit. No key, keyed URL or response body is persisted/logged.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import random
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx


class QuotaUnavailable(Exception):
    def __init__(self, reason, retry_after=60):
        super().__init__(reason)
        self.retry_after = max(1, int(retry_after))


def retry_seconds(header, now=None):
    now = time.time() if now is None else now
    try:
        return max(1, int(float(header)))
    except (ValueError, TypeError):
        try:
            return max(1, int(parsedate_to_datetime(header).timestamp() - now))
        except (ValueError, TypeError, OverflowError):
            return 600


def estimated_cost(path):
    if "/data_availability/" in path:
        return max(5, int(os.environ.get("SHARP_FIRMS_AVAILABILITY_COST", "10")))
    if "/mapkey_status/" in path:
        return 5
    if "/area/" in path:
        try:
            segments = path.split("/")
            index = segments.index("csv")
            bounds, days = segments[index + 3], int(segments[index + 4])
            if bounds == "world":
                fraction = 1.
            else:
                west, south, east, north = map(float, bounds.split(","))
                fraction = abs((east - west) * (north - south)) / 64800
            return max(5, math.ceil((5 + fraction * int(os.environ.get("SHARP_FIRMS_WORLD_DAY_COST", "1200"))) * days))
        except (ValueError, IndexError):
            return 1200
    return max(10, int(os.environ.get("SHARP_FIRMS_OTHER_COST", "100")))


class QuotaGovernor:
    def __init__(self, path, key):
        self.path = Path(path)
        self.fingerprint = hashlib.sha256(str(key).encode()).hexdigest()
        self.limit = min(5000, max(50, int(os.environ.get("SHARP_FIRMS_TRANSACTION_LIMIT", "5000"))))
        self.headroom = max(1, int(os.environ.get("SHARP_FIRMS_HEADROOM", "1000")))
        self.local_limit = min(self.limit - self.headroom, int(os.environ.get("SHARP_FIRMS_LOCAL_BUDGET", "3000")))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS quota_reservations(key_hash TEXT,at REAL,cost INTEGER);
              CREATE INDEX IF NOT EXISTS quota_by_key_time ON quota_reservations(key_hash,at);
              CREATE TABLE IF NOT EXISTS quota_state(key_hash TEXT PRIMARY KEY,payload TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS quota_queue(token TEXT PRIMARY KEY,key_hash TEXT,started REAL);
              CREATE TABLE IF NOT EXISTS quota_responses(key_hash TEXT PRIMARY KEY,fetched REAL,body TEXT);
              CREATE TABLE IF NOT EXISTS quota_locks(name TEXT PRIMARY KEY,expires REAL);
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        return db

    def _read(self, db):
        row = db.execute("SELECT payload FROM quota_state WHERE key_hash=?", (self.fingerprint,)).fetchone()
        return json.loads(row[0]) if row else {}

    def _save(self, db, state):
        db.execute("INSERT OR REPLACE INTO quota_state VALUES(?,?)", (self.fingerprint, json.dumps(state)))

    def reserve(self, cost, now=None, status_check=False):
        now = time.time() if now is None else now
        if not 0 < cost <= self.local_limit:
            raise QuotaUnavailable("Estimated FIRMS transaction cost exceeds the permitted shared budget.", 600)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            state = self._read(db)
            if state.get("blockedUntil", 0) > now and not status_check:
                raise QuotaUnavailable(state.get("reason", "FIRMS acquisition is temporarily delayed."), state["blockedUntil"] - now)
            db.execute("DELETE FROM quota_reservations WHERE at<=?", (now - 600,))
            local = db.execute("SELECT COALESCE(SUM(cost),0) FROM quota_reservations WHERE key_hash=?", (self.fingerprint,)).fetchone()[0]
            # Reconcile observations conservatively: usage reported by another app
            # plus every local reservation made after that observation.
            reported = state.get("reportedUsed", 0) if state.get("reportedAt", 0) > now - 600 else 0
            subsequent = db.execute("SELECT COALESCE(SUM(cost),0) FROM quota_reservations WHERE key_hash=? AND at>=?", (self.fingerprint, state.get("reportedAt", now - 600))).fetchone()[0]
            if local + cost > self.local_limit or reported + subsequent + cost > min(self.limit, state.get("providerLimit", self.limit)) - self.headroom:
                raise QuotaUnavailable("FIRMS shared transaction budget is reserved; serving stored observations.", 600)
            if not status_check and state.get("requireStatus", True) and state.get("reportedAt", 0) < now - 120:
                raise QuotaUnavailable("FIRMS quota status is not fresh enough for safe acquisition.", 60)
            db.execute("INSERT INTO quota_reservations VALUES(?,?,?)", (self.fingerprint, now, cost))
        return cost

    def reconcile(self, report, now=None):
        now = time.time() if now is None else now
        used, limit = int(report["current_transactions"]), int(report["transaction_limit"])
        if used < 0 or not 1 <= limit <= 1000000:
            raise ValueError("Invalid quota status.")
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            state = self._read(db)
            state.update(reportedUsed=used, reportedAt=now, providerLimit=limit, statusLeaseUntil=0)
            if used >= min(self.limit, limit) - self.headroom:
                state.update(blockedUntil=now + 600, reason="Provider-reported shared transaction usage is unsafe.")
            self._save(db, state)

    def circuit(self, reason, seconds, now=None):
        now = time.time() if now is None else now
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            state = self._read(db)
            state.update(blockedUntil=max(state.get("blockedUntil", 0), now + seconds), reason=reason)
            self._save(db, state)

    def begin_status(self, now=None):
        now = time.time() if now is None else now
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            state = self._read(db)
            if state.get("reportedAt", 0) > now - 60:
                return False
            if state.get("statusLeaseUntil", 0) > now:
                return False
            state["statusLeaseUntil"] = now + 30
            self._save(db, state)
            return True

    def enter_queue(self, now=None):
        now = time.time() if now is None else now
        token = uuid.uuid4().hex
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM quota_queue WHERE started<?", (now - 180,))
            count = db.execute("SELECT COUNT(*) FROM quota_queue WHERE key_hash=?", (self.fingerprint,)).fetchone()[0]
            if count >= max(1, int(os.environ.get("SHARP_FIRMS_MAX_QUEUED", "64"))):
                raise QuotaUnavailable("The shared FIRMS acquisition queue is full.", 60)
            db.execute("INSERT INTO quota_queue VALUES(?,?,?)", (token, self.fingerprint, now))
        return token

    def leave_queue(self, token):
        with closing(self.connect()) as db, db:
            db.execute("DELETE FROM quota_queue WHERE token=?", (token,))

    def status(self):
        with closing(self.connect()) as db:
            state = self._read(db)
            local = db.execute("SELECT COALESCE(SUM(cost),0) FROM quota_reservations WHERE key_hash=? AND at>?", (self.fingerprint, time.time() - 600)).fetchone()[0]
        return {"estimatedReservedTransactions": local, "reportedTransactions": state.get("reportedUsed"), "reportedAt": state.get("reportedAt"), "limit": self.limit, "localBudget": self.local_limit, "headroom": self.headroom, "blockedUntil": state.get("blockedUntil"), "reason": state.get("reason"), "costsAreEstimates": True}

    def provider_status(self):
        """Persisted status lets different workers await the same cold check."""
        with closing(self.connect()) as db:
            return self._read(db)

    def availability_cache(self, body=None):
        with closing(self.connect()) as db, db:
            if body is not None:
                if len(body.encode()) > 128 * 1024:
                    return None
                db.execute("INSERT OR REPLACE INTO quota_responses VALUES(?,?,?)", (self.fingerprint, time.time(), body))
                return body
            row = db.execute("SELECT body FROM quota_responses WHERE key_hash=? AND fetched>?", (self.fingerprint, time.time() - 3600)).fetchone()
            return row[0] if row else None

    def availability_lease(self, release=False):
        name = "availability:" + self.fingerprint
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if release:
                db.execute("DELETE FROM quota_locks WHERE name=?", (name,))
                return True
            row = db.execute("SELECT expires FROM quota_locks WHERE name=?", (name,)).fetchone()
            if row and row[0] > time.time():
                return False
            db.execute("INSERT OR REPLACE INTO quota_locks VALUES(?,?)", (name, time.time() + 150))
            return True


async def reconcile_provider(app, governor):
    deadline = time.monotonic() + 30
    while True:
        state = governor.provider_status()
        now = time.time()
        if state.get("blockedUntil", 0) > now:
            raise QuotaUnavailable(state.get("reason", "FIRMS acquisition is temporarily delayed."), state["blockedUntil"] - now)
        if state.get("reportedAt", 0) > now - 60:
            return
        if governor.begin_status():
            try:
                governor.reserve(5, status_check=True)
                response = await app.state.firms.get(f"/mapserver/mapkey_status/?MAP_KEY={app.state.key}", timeout=15)
                if response.status_code == 429:
                    delay = retry_seconds(response.headers.get("Retry-After"))
                    governor.circuit("FIRMS quota status was rate limited; acquisition is delayed.", delay)
                    raise QuotaUnavailable("FIRMS quota status was rate limited; acquisition is delayed.", delay)
                if response.status_code in (401, 403):
                    governor.circuit("FIRMS credentials were rejected; check server configuration.", 3600)
                    raise QuotaUnavailable("FIRMS credentials were rejected; check server configuration.", 3600)
                if response.status_code != 200:
                    raise ValueError("Quota status service failed.")
                governor.reconcile(response.json())
                return
            except QuotaUnavailable:
                raise
            except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
                governor.circuit("FIRMS quota status is unavailable; acquisition is delayed safely.", 120)
                raise QuotaUnavailable("FIRMS quota status is unavailable; acquisition is delayed safely.", 120) from None
        if time.monotonic() >= deadline:
            raise QuotaUnavailable("Shared FIRMS quota status check is still pending; retry shortly.", 30)
        # No keyed caller reserves acquisition transactions before the persisted
        # owner's result is visible. Waiting never performs another status call.
        await asyncio.sleep(.05)


async def governed_csv(app, path, started, raw_fetch):
    """Install as app.fetch_csv; all keyed API work shares durable reservations."""
    governor = getattr(app.state, "quota", None)
    if governor is None:
        # Lightweight fake apps in existing tests provide a mocked fetch function;
        # production startup always installs a governor on the shared database.
        from global_store import GlobalStore
        governor = QuotaGovernor(GlobalStore().path, app.state.key)
        app.state.quota = governor
    token = governor.enter_queue()
    availability = "/data_availability/" in path
    availability_owner = False
    try:
        if availability:
            cached = governor.availability_cache()
            if cached is not None:
                return cached
            availability_owner = governor.availability_lease()
            if not availability_owner:
                for _ in range(30):
                    await asyncio.sleep(.5)
                    cached = governor.availability_cache()
                    if cached is not None:
                        return cached
                raise QuotaUnavailable("Shared FIRMS availability check is pending; retry shortly.", 30)
        await reconcile_provider(app, governor)
        for attempt in range(3):
            governor.reserve(estimated_cost(path))
            try:
                body = await raw_fetch(app, path, started)
                required = ("data_id", "min_date", "max_date") if availability else ("latitude", "longitude", "acq_date") if "/area/" in path else ()
                header = body.splitlines()[0].lower().split(",") if body else []
                if required and any(field not in header for field in required):
                    governor.circuit("FIRMS returned error text or an unsupported CSV schema; check provider status and configuration.", 600)
                    raise QuotaUnavailable("FIRMS did not return the expected CSV. Stored observations remain available.", 600)
                if availability:
                    governor.availability_cache(body)
                return body
            except Exception as exc:
                text = str(exc)
                if "rejected" in text.lower() or "map key" in text.lower():
                    governor.circuit("FIRMS rejected the configured credential; check server configuration.", 3600)
                    raise
                if "rate limit" in text.lower():
                    governor.circuit("FIRMS rate limit reached; waiting before any retry.", getattr(exc, "retry_after", 600))
                    raise
                if attempt == 2 or not any(term in text.lower() for term in ("timed out", "http 50", "http 502", "http 503")):
                    raise
                await asyncio.sleep(min(8, 2 ** attempt) + random.random())
    finally:
        if availability_owner:
            governor.availability_lease(release=True)
        governor.leave_queue(token)
