"""Deterministic fixture coverage; no upstream data is downloaded by tests."""
import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# All application lifespans in this discovered suite intentionally disable the
# independent real ingestion service. Tests below invoke refresh with MockTransport.
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from global_store import GlobalStore
from global_ingestion import parse_bulk, refresh_global
from harmonize import Detection, detection_id
from quota import QuotaGovernor, QuotaUnavailable, estimated_cost, retry_seconds, governed_csv

ANCHOR = datetime(2026, 11, 15, 12, tzinfo=UTC)
SOURCE = "MODIS_NRT"
HEADER = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,scan,track,version\n"


def record(hours=1, platform="aqua", lon=12, lat=52, power=12, tier="NRT"):
    return Detection(platform, lat, lon, ANCHOR - timedelta(hours=hours), power, None, 75, "D", 1.2, 1.1, 1000, SOURCE, "6.1", tier)


class GlobalStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "global.sqlite"
        self.store = GlobalStore(self.path)
        self.addCleanup(self.directory.cleanup)

    def publish(self, rows=None, end=ANCHOR):
        self.store.replace_source(SOURCE, rows if rows is not None else [record()], end - timedelta(days=7), end, ANCHOR.timestamp())
        return self.store.publish(end, [SOURCE], ANCHOR.timestamp())

    def test_exact_rolling_windows_are_start_inclusive_end_exclusive_across_midnight(self):
        rows = [record(0), record(1), record(24), record(24.01), record(48), record(167.99), record(168)]
        manifest = self.publish(rows)
        self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"], "24h"))), 2)
        self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"], "48h"))), 4)
        self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"], "7d"))), 6)
        self.assertNotEqual(self.store.snapshot_manifest(manifest["snapshot"], "7d")["interval"]["startUtc"], self.store.snapshot_manifest(manifest["snapshot"], "24h")["interval"]["startUtc"])

    def test_restart_retains_snapshot_and_exact_canonical_metadata(self):
        row = replace(record(), frp_mw=None, confidence_pct=None, day_night=None)
        manifest = self.publish([row])
        restarted = GlobalStore(self.path)
        self.assertEqual(restarted.current_manifest()["snapshot"], manifest["snapshot"])
        self.assertEqual(tuple(restarted.iter_observations(manifest["snapshot"])), (row,))
        self.assertEqual(restarted.canonical_store(manifest["snapshot"]).rows, (row,))

    def test_snapshot_membership_does_not_mix_generations_on_refresh(self):
        first = self.publish([record()])
        revised = replace(record(), frp_mw=65)
        second = self.publish([revised])
        self.assertNotEqual(first["snapshot"], second["snapshot"])
        self.assertEqual(tuple(self.store.iter_observations(first["snapshot"]))[0].frp_mw, 12)
        self.assertEqual(tuple(self.store.iter_observations(second["snapshot"]))[0].frp_mw, 65)

    def test_exact_duplicate_records_collapse_but_satellite_observations_remain(self):
        row = record()
        manifest = self.publish([row, row, replace(row, platform="terra")])
        self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"]))), 2)

    def test_revision_precedence_keeps_nrt_instead_of_rt_across_products(self):
        self.store.replace_source("RT_SUPPLEMENT", [record(tier="RT")], ANCHOR - timedelta(days=7), ANCHOR)
        self.store.replace_source(SOURCE, [record(tier="NRT", power=42)], ANCHOR - timedelta(days=7), ANCHOR)
        manifest = self.store.publish(ANCHOR, [SOURCE, "RT_SUPPLEMENT"])
        rows = tuple(self.store.iter_observations(manifest["snapshot"]))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].processing_tier, "NRT")
        self.assertEqual(rows[0].frp_mw, 42)
        with closing(self.store.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM global_snapshot_observations WHERE snapshot=?", (manifest["snapshot"],)).fetchone()[0], 1)

    def test_failures_preserve_last_successful_source_and_mark_partial(self):
        first = self.publish()
        self.store.record_failure(SOURCE, "Timeout", ANCHOR.timestamp() + 900)
        second = self.store.publish(ANCHOR, [SOURCE], ANCHOR.timestamp() + 900)
        self.assertEqual(second["status"], "partial")
        self.assertTrue(second["stale"])
        self.assertEqual(tuple(self.store.iter_observations(first["snapshot"])), tuple(self.store.iter_observations(second["snapshot"])))
        self.assertEqual(second["sources"][0]["failure"], "Timeout")

    def test_absent_source_is_not_inferred_as_successful_zero(self):
        self.publish()
        manifest = self.store.publish(ANCHOR, [SOURCE, "VIIRS_NOAA20_NRT"])
        self.assertEqual(manifest["completeness"], "partial")
        self.assertEqual(manifest["sources"][1]["status"], "unavailable")

    def test_successful_empty_reporting_extract_is_distinct_from_missing(self):
        manifest = self.publish([])
        self.assertEqual(manifest["status"], "ready")
        self.assertEqual(tuple(self.store.iter_observations(manifest["snapshot"])), ())
        self.assertTrue(self.store.canonical_store(manifest["snapshot"]).coverage)

    def test_antimeridian_and_poles_keep_original_coordinates_and_finite_spatial_keys(self):
        rows = [record(lon=180, lat=89), record(lon=-180, lat=-89), record(lon=179.99), record(lon=-179.99)]
        manifest = self.publish(rows)
        selected = tuple(self.store.iter_observations(manifest["snapshot"], bbox=(179, -90, -179, 90)))
        self.assertEqual(len(selected), 4)
        self.assertEqual({row.longitude for row in selected}, {180, -180, 179.99, -179.99})
        with closing(self.store.connect()) as db:
            self.assertTrue(all(0 <= row[0] < 1 and 0 <= row[1] < 1 for row in db.execute("SELECT mx,my FROM global_observations")))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM global_spatial").fetchone()[0], 4)

    def test_display_filter_counts_and_canonical_membership_share_same_rows(self):
        manifest = self.publish([record(lon=10, power=9), record(lon=11, power=10), record(lon=12, power=None)])
        selected = tuple(self.store.iter_observations(manifest["snapshot"], filters={"frpMin": 10, "sensor": "MODIS"}))
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0].frp_mw, 10)

    def test_invalid_negative_and_nonfinite_frp_become_explicit_unknown(self):
        manifest = self.publish([record(lon=10, power=-1), record(lon=11, power=float("nan")), record(lon=12, power=15)])
        rows = tuple(self.store.iter_observations(manifest["snapshot"]))
        self.assertEqual(sum(row.frp_mw is None for row in rows), 2)
        self.assertEqual(max(row.frp_mw for row in rows if row.frp_mw is not None), 15)
        with closing(self.store.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM global_observations WHERE frp IS NULL").fetchone()[0], 2)

    def test_100_concurrent_viewers_read_same_snapshot_without_ingestion(self):
        manifest = self.publish()
        with ThreadPoolExecutor(max_workers=16) as executor:
            snapshots = list(executor.map(lambda _: GlobalStore(self.path).current_manifest()["snapshot"], range(100)))
        self.assertEqual(set(snapshots), {manifest["snapshot"]})
        self.assertNotIn("upstream_bulk_requests", self.store.metrics())

    def test_worker_leases_share_persisted_owner_and_recover_after_expiry(self):
        other = GlobalStore(self.path)
        self.assertTrue(self.store.lease("ingest", "first", 10, now=100))
        self.assertFalse(other.lease("ingest", "second", 10, now=105))
        self.assertTrue(other.lease("ingest", "second", 10, now=111))
        self.store.release("ingest", "first")
        self.assertFalse(self.store.lease("ingest", "third", 10, now=112))

    def test_parser_reuses_native_metadata_unknowns_and_rejects_error_text(self):
        rows = tuple(parse_bulk(HEADER + "52,12,2026-11-15,1100,Aqua,,,D,1.2,1.1,6.1NRT\n", SOURCE))
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].confidence_pct)
        self.assertIsNone(rows[0].frp_mw)
        self.assertEqual(rows[0].product_version, "6.1NRT")
        self.assertEqual(rows[0].processing_tier, "NRT")
        with self.assertRaises(ValueError):
            tuple(parse_bulk("Invalid map key", SOURCE))

    def test_refresh_coalesces_across_worker_instances_and_preserves_outage_data(self):
        async def exercise():
            calls = []
            async def transport(request):
                calls.append(str(request.url))
                await asyncio.sleep(.02)
                return httpx.Response(200, text=HEADER + "52,12,2026-11-15,1100,Aqua,75,12,D,1.2,1.1,6.1NRT\n")
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                first, second = await asyncio.gather(refresh_global(self.store, client, ANCHOR, [SOURCE]), refresh_global(GlobalStore(self.path), client, ANCHOR, [SOURCE]))
                self.assertEqual(len(calls), 1)
                self.assertEqual({first["state"], second["state"]}, {"published", "coalesced"})
            manifest = self.store.current_manifest()
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(429, headers={"Retry-After": "1800"}))) as client:
                failed = await refresh_global(self.store, client, ANCHOR + timedelta(minutes=20), [SOURCE], force=True)
            self.assertEqual(failed["manifest"]["status"], "partial")
            self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"]))), 1)
        asyncio.run(exercise())

    def test_bulk_boundary_coverage_stays_unknown_without_dropping_supplied_reports(self):
        rows = [record(hours=167), record(hours=1)]
        self.store.replace_source(SOURCE, rows, ANCHOR - timedelta(days=7), ANCHOR,
                                  metadata={"coverageStart": "2026-11-09T00:00:00Z"})
        manifest = self.store.publish(ANCHOR, [SOURCE])
        self.assertEqual(manifest["windows"]["24h"]["status"], "ready")
        self.assertEqual(manifest["windows"]["7d"]["status"], "partial")
        self.assertEqual(len(tuple(self.store.iter_observations(manifest["snapshot"], "7d"))), 2)

    def test_owner_heartbeat_renews_during_shared_refresh(self):
        async def exercise():
            real_sleep = asyncio.sleep
            async def accelerated_sleep(seconds):
                await real_sleep(.01 if seconds == 30 else seconds)
            async def transport(_request):
                await real_sleep(.08)
                return httpx.Response(200, text=HEADER + "52,12,2026-11-15,1100,Aqua,75,12,D,1.2,1.1,6.1NRT\n")
            original = self.store.lease
            renewals = []
            def lease(*args, **kwargs):
                renewals.append(args)
                return original(*args, **kwargs)
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                with patch("global_ingestion.asyncio.sleep", accelerated_sleep), patch.object(self.store, "lease", side_effect=lease):
                    result = await refresh_global(self.store, client, ANCHOR, [SOURCE])
            self.assertEqual(result["state"], "published")
            self.assertGreaterEqual(len(renewals), 2)
        asyncio.run(exercise())

    def test_retention_prunes_expired_snapshots_without_mutating_retained_membership(self):
        with patch.dict(os.environ, {"SHARP_GLOBAL_RETAIN_SNAPSHOTS": "2"}):
            first = self.publish([record(power=1)])
            second = self.publish([record(power=2)])
            third = self.publish([record(power=3)])
        with self.assertRaises(ValueError):
            self.store.snapshot_manifest(first["snapshot"])
        self.assertEqual(tuple(self.store.iter_observations(second["snapshot"]))[0].frp_mw, 2)
        self.assertEqual(tuple(self.store.iter_observations(third["snapshot"]))[0].frp_mw, 3)

    def test_shutdown_keeps_lease_until_inflight_partition_transaction_finishes(self):
        async def exercise():
            began, release = threading.Event(), threading.Event()
            original = self.store.replace_source
            def write(*args):
                began.set()
                release.wait(timeout=2)
                return original(*args)
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, text=HEADER + "52,12,2026-11-15,1100,Aqua,75,12,D,1.2,1.1,6.1NRT\n"))) as client:
                with patch.object(self.store, "replace_source", side_effect=write):
                    task = asyncio.create_task(refresh_global(self.store, client, ANCHOR, [SOURCE]))
                    self.assertTrue(await asyncio.to_thread(began.wait, 1))
                    task.cancel()
                    await asyncio.sleep(.02)
                    with closing(self.store.connect()) as db:
                        self.assertIsNotNone(db.execute("SELECT 1 FROM global_leases WHERE name='global-ingestion'").fetchone())
                    release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            with closing(self.store.connect()) as db:
                self.assertIsNone(db.execute("SELECT 1 FROM global_leases WHERE name='global-ingestion'").fetchone())
        asyncio.run(exercise())


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "global.sqlite"
        self.quota = QuotaGovernor(self.path, "test-only-key")
        self.addCleanup(self.directory.cleanup)

    def test_shared_cost_reservations_survive_restart_and_respect_external_usage(self):
        self.quota.reconcile({"current_transactions": 100, "transaction_limit": 5000}, now=1000)
        self.quota.reserve(1000, now=1001)
        other = QuotaGovernor(self.path, "test-only-key")
        other.reserve(1000, now=1002)
        with self.assertRaises(QuotaUnavailable):
            other.reserve(1500, now=1003)
        other.reconcile({"current_transactions": 3900, "transaction_limit": 5000}, now=1004)
        with self.assertRaises(QuotaUnavailable):
            self.quota.reserve(200, now=1005)

    def test_status_unavailable_fails_closed_and_reservations_expire(self):
        with self.assertRaises(QuotaUnavailable):
            self.quota.reserve(5, now=1000)
        self.quota.reconcile({"current_transactions": 0, "transaction_limit": 5000}, now=1000)
        self.quota.reserve(3000, now=1001)
        self.quota.reconcile({"current_transactions": 0, "transaction_limit": 5000}, now=1700)
        self.quota.reserve(3000, now=1701)

    def test_provider_status_checks_coalesce_and_retry_after_and_auth_circuit_persist(self):
        self.assertTrue(self.quota.begin_status(now=100))
        self.assertFalse(QuotaGovernor(self.path, "test-only-key").begin_status(now=101))
        self.quota.circuit("Credential rejected", 3600, now=100)
        self.quota.reconcile({"current_transactions": 0, "transaction_limit": 5000}, now=101)
        with self.assertRaisesRegex(QuotaUnavailable, "Credential rejected"):
            self.quota.reserve(5, now=102)
        self.assertEqual(retry_seconds("120", now=0), 120)
        self.assertEqual(retry_seconds("Thu, 01 Jan 1970 00:02:00 GMT", now=0), 120)

    def test_weighted_cost_does_not_treat_world_or_availability_as_one_transaction(self):
        self.assertGreaterEqual(estimated_cost("/api/data_availability/csv/key/ALL"), 5)
        self.assertGreater(estimated_cost("/api/area/csv/key/VIIRS_NOAA20_NRT/world/1"), 1000)
        self.assertGreater(estimated_cost("/api/area/csv/key/VIIRS_NOAA20_NRT/world/5"), estimated_cost("/api/area/csv/key/VIIRS_NOAA20_NRT/world/1"))

    def test_queue_bound_and_sanitized_status_never_expose_key(self):
        with patch.dict(os.environ, {"SHARP_FIRMS_MAX_QUEUED": "2"}):
            first, second = self.quota.enter_queue(), self.quota.enter_queue()
            with self.assertRaises(QuotaUnavailable): self.quota.enter_queue()
            self.quota.leave_queue(first)
            self.quota.leave_queue(second)
        self.assertNotIn("test-only-key", json.dumps(self.quota.status()))

    def test_governed_availability_checks_coalesce_and_cache_without_per_viewer_requests(self):
        async def exercise():
            requests = []
            def transport(request):
                requests.append(request.url.path)
                return httpx.Response(200, json={"current_transactions": 0, "transaction_limit": 5000})
            async with httpx.AsyncClient(base_url="https://firms.modaps.eosdis.nasa.gov", transport=httpx.MockTransport(transport)) as client:
                app = SimpleNamespace(state=SimpleNamespace(quota=self.quota, firms=client, key="test-only-key"))
                calls = []
                async def raw(_app, _path, _started):
                    calls.append(1)
                    await asyncio.sleep(.01)
                    return "data_id,min_date,max_date\nMODIS_NRT,2026-01-01,2026-11-15\n"
                paths = ["/api/data_availability/csv/test-only-key/ALL"] * 4
                values = await asyncio.gather(*(governed_csv(app, path, None, raw) for path in paths))
                self.assertEqual(len(calls), 1)
                self.assertEqual(len(requests), 1)
                self.assertEqual(len(set(values)), 1)
                restarted = QuotaGovernor(self.path, "test-only-key")
                self.assertEqual(restarted.availability_cache(), values[0])
        asyncio.run(exercise())

    def test_governed_200_error_text_and_429_do_not_retry_or_report_zero(self):
        async def exercise():
            self.quota.reconcile({"current_transactions": 0, "transaction_limit": 5000})
            app = SimpleNamespace(state=SimpleNamespace(quota=self.quota, key="test-only-key"))
            calls = []
            async def malformed(_app, _path, _started):
                calls.append(1)
                return "Error: invalid credential"
            with self.assertRaises(QuotaUnavailable):
                await governed_csv(app, "/api/area/csv/test-only-key/MODIS_NRT/1,1,2,2/1", None, malformed)
            self.assertEqual(len(calls), 1)
            self.assertGreater(self.quota.status()["blockedUntil"], time.time())
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
