import asyncio
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import Source, load_batch
from cache import BatchCache


class BatchFetchCoalescingTest(unittest.TestCase):
    def test_cancelled_interval_request_leaves_batch_fetch_available_to_next_request(self):
        async def exercise(cache_path: Path):
            cache = BatchCache(cache_path)
            fake_app = SimpleNamespace(
                state=SimpleNamespace(
                    cache=cache,
                    batch_locks=[asyncio.Lock()],
                    batch_fetches={},
                    slots=asyncio.Semaphore(8),
                    key="test-key",
                )
            )
            today = datetime.now(UTC).date()
            day = today - timedelta(days=2)
            features = [{"properties": {"acquired_at": f"{day.isoformat()}T12:00:00Z"}}]
            started = asyncio.Event()
            release = asyncio.Event()

            async def fake_fetch_csv(_app, _path, request_started=None):
                async with _app.state.slots:
                    if request_started is not None:
                        request_started.set()
                    started.set()
                    await release.wait()
                    return "csv"

            with patch(
                "app.fetch_csv",
                new=AsyncMock(side_effect=fake_fetch_csv),
            ) as fetch_csv:
                with patch("app.parse_features", return_value=features):
                    first_request = asyncio.create_task(
                        load_batch(
                            fake_app, Source.MODIS_NRT, "3,50,8,54", day, today
                        )
                    )
                    await asyncio.wait_for(started.wait(), timeout=1)
                    first_request.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await first_request

                    second_request = asyncio.create_task(
                        load_batch(
                            fake_app, Source.MODIS_NRT, "3,50,8,54", day, today
                        )
                    )
                    await asyncio.sleep(0)
                    self.assertEqual(fetch_csv.call_count, 1)
                    release.set()

                    reused = await asyncio.wait_for(second_request, timeout=1)
                    self.assertEqual(reused[0], features)
                    self.assertTrue(reused[2])

                    cached = await load_batch(
                        fake_app, Source.MODIS_NRT, "3,50,8,54", day, today
                    )
                    self.assertEqual(cached[0], features)
                    self.assertTrue(cached[2])
                    self.assertEqual(fetch_csv.call_count, 1)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(exercise(Path(directory) / "cache.sqlite3"))

    def test_cancelled_queued_fetch_does_not_start_a_nasa_request(self):
        async def exercise(cache_path: Path):
            cache = BatchCache(cache_path)
            fetch_started = asyncio.Event()
            fake_app = SimpleNamespace(
                state=SimpleNamespace(
                    cache=cache,
                    batch_locks=[asyncio.Lock()],
                    batch_fetches={},
                    slots=asyncio.Semaphore(0),
                    key="test-key",
                )
            )
            today = datetime.now(UTC).date()
            day = today - timedelta(days=2)

            async def fake_fetch_csv(_app, _path, request_started=None):
                async with _app.state.slots:
                    if request_started is not None:
                        request_started.set()
                    fetch_started.set()
                    return "csv"

            with patch(
                "app.fetch_csv",
                new=AsyncMock(side_effect=fake_fetch_csv),
            ) as fetch_csv:
                request = asyncio.create_task(
                    load_batch(fake_app, Source.MODIS_NRT, "3,50,8,54", day, today)
                )
                await asyncio.sleep(0.01)
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await request
                await asyncio.sleep(0.01)

            self.assertEqual(fetch_csv.call_count, 1)
            self.assertFalse(fetch_started.is_set())
            self.assertFalse(fake_app.state.batch_fetches)


if __name__ == "__main__":
    unittest.main()
