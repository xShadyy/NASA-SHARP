import sys
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cache import BatchCache


class AreaAnalyticsSummaryCacheTest(unittest.TestCase):
    def test_legacy_dashboard_summaries_are_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.sqlite3"
            cache = BatchCache(path)
            batch_key = cache.key("MODIS_NRT", "world", "2026-11-14")
            fetched = time.time()
            cache.put(batch_key, [], fetched, 1000)
            cache.put_summary("query-one", batch_key, '{"count":1}', fetched)

            with closing(cache.connect()) as db, db:
                db.execute(
                    "ALTER TABLE area_analytics_summaries RENAME TO dashboard_summaries"
                )

            migrated_cache = BatchCache(path)
            self.assertEqual(
                migrated_cache.get_summary("query-one", batch_key),
                ('{"count":1}', fetched),
            )
            with closing(migrated_cache.connect()) as db:
                tables = {
                    row[0]
                    for row in db.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
            self.assertIn("area_analytics_summaries", tables)
            self.assertNotIn("dashboard_summaries", tables)

    def test_summary_is_bound_to_the_cached_batch_version(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = BatchCache(Path(directory) / "cache.sqlite3")
            batch_key = cache.key("MODIS_NRT", "world", "2026-11-14")
            fetched = time.time()
            cache.put(batch_key, [], fetched, 1000)
            cache.put_summary("query-one", batch_key, '{"count":1}', fetched)

            self.assertEqual(
                cache.get_summary("query-one", batch_key), ('{"count":1}', fetched)
            )

            cache.put(batch_key, [], fetched + 1, 1000)
            self.assertIsNone(cache.get_summary("query-one", batch_key))

    def test_summary_is_not_cached_without_its_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = BatchCache(Path(directory) / "cache.sqlite3")
            cache.put_summary(
                "query-one",
                cache.key("MODIS_NRT", "world", "2026-11-14"),
                '{"count":1}',
                100,
            )
            self.assertIsNone(
                cache.get_summary(
                    "query-one", cache.key("MODIS_NRT", "world", "2026-11-14")
                )
            )


if __name__ == "__main__":
    unittest.main()
