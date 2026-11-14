import sys
import unittest
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dashboard_summary import DashboardSummary


def detection(day, hour, source, sensor, confidence, frp, longitude=-68.1, latitude=-13.1, daynight="D"):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {
            "source": source,
            "sensor": sensor,
            "satellite": "Terra" if sensor == "MODIS" else "NOAA-20",
            "acquired_at": f"{day}T{hour:02}:30:00Z",
            "confidence": confidence,
            "frp_mw": frp,
            "daynight": daynight,
        },
    }


class DashboardSummaryTest(unittest.TestCase):
    def test_summary_covers_full_data_but_caps_recent_feature_sample(self):
        summary = DashboardSummary(sample_limit=2)
        summary.add_many([
            detection("2026-11-13", 23, "MODIS_NRT", "MODIS", 90, 0),
            detection("2026-11-14", 1, "VIIRS_NOAA20_NRT", "VIIRS", "h", 10),
            detection("2026-11-14", 2, "VIIRS_NOAA20_NRT", "VIIRS", "n", None, daynight="N"),
            detection("2026-11-14", 13, "MODIS_NRT", "MODIS", 60, 100),
        ])

        payload = summary.payload([date(2026, 11, 13), date(2026, 11, 14)], ZoneInfo("UTC"))

        self.assertEqual(summary.count, 4)
        self.assertEqual([row["count"] for row in payload["daily"]], [1, 3])
        self.assertEqual(sum(bucket["count"] for bucket in payload["products"]), 4)
        self.assertEqual(payload["frpReported"], 3)
        self.assertEqual(payload["medianFrp"], 10)
        self.assertEqual(payload["highestFrp"]["properties"]["frp_mw"], 100)
        self.assertEqual(payload["latest"]["properties"]["acquired_at"], "2026-11-14T13:30:00Z")
        self.assertEqual(len(payload["features"]), 2)
        self.assertEqual(
            [feature["properties"]["acquired_at"] for feature in payload["features"]],
            ["2026-11-14T13:30:00Z", "2026-11-14T02:30:00Z"],
        )
        self.assertEqual(sum(bucket["count"] for bucket in payload["daynight"]), 4)
        self.assertEqual(sum(bucket["count"] for bucket in payload["confidence"]), 4)
        self.assertEqual(sum(bucket["count"] for bucket in payload["frp"]), 4)
        self.assertEqual(sum(hour["count"] for hour in payload["hourly"]), 4)
        self.assertEqual(sum(cell["count"] for cell in payload["topCells"]), 4)
        self.assertIn("acquired_at_local", payload["features"][0]["properties"])

    def test_merge_preserves_totals_and_global_recent_sample(self):
        earlier = DashboardSummary(sample_limit=2)
        later = DashboardSummary(sample_limit=2)
        earlier.add_many([
            detection("2026-11-13", 1, "MODIS_NRT", "MODIS", 80, 5),
            detection("2026-11-13", 2, "MODIS_NRT", "MODIS", 80, 15),
        ])
        later.add_many([
            detection("2026-11-14", 1, "VIIRS_NOAA21_NRT", "VIIRS", "h", 25),
            detection("2026-11-14", 2, "VIIRS_NOAA21_NRT", "VIIRS", "n", 35),
        ])
        earlier.merge(later)

        payload = earlier.payload(
            [date(2026, 11, 13), date(2026, 11, 14)], ZoneInfo("UTC")
        )
        self.assertEqual(earlier.count, 4)
        self.assertEqual([row["count"] for row in payload["daily"]], [2, 2])
        self.assertEqual(len(payload["features"]), 2)
        self.assertTrue(all(
            feature["properties"]["acquired_at"].startswith("2026-11-14")
            for feature in payload["features"]
        ))

    def test_summary_cache_round_trip_keeps_exact_median_and_recent_sample(self):
        summary = DashboardSummary(sample_limit=2)
        summary.add_many([
            detection("2026-11-14", 1, "MODIS_NRT", "MODIS", 90, 1),
            detection("2026-11-14", 2, "MODIS_NRT", "MODIS", 90, 3),
            detection("2026-11-14", 3, "MODIS_NRT", "MODIS", 90, 5),
        ])

        restored = DashboardSummary.from_cache(summary.to_cache())
        payload = restored.payload([date(2026, 11, 14)], ZoneInfo("UTC"))

        self.assertEqual(restored.count, 3)
        self.assertEqual(payload["medianFrp"], 3)
        self.assertEqual(payload["highestFrp"]["properties"]["frp_mw"], 5)
        self.assertEqual(len(payload["features"]), 2)
        self.assertEqual(
            [feature["properties"]["acquired_at"] for feature in payload["features"]],
            ["2026-11-14T03:30:00Z", "2026-11-14T02:30:00Z"],
        )

    def test_summary_filters_iso_timestamps_at_exact_exclusive_boundaries(self):
        before = detection("2026-11-14", 1, "VIIRS_NOAA20_NRT", "VIIRS", "n", 1)
        before["properties"]["acquired_at"] = "2026-11-14T01:30:00Z"
        at_upper = detection("2026-11-14", 1, "VIIRS_NOAA20_NRT", "VIIRS", "n", 1)
        at_upper["properties"]["acquired_at"] = "2026-11-14T01:30:01Z"
        summary = DashboardSummary()

        summary.add_filtered(
            [before, at_upper],
            "2026-11-14T01:30:00.500000Z",
            "2026-11-14T01:30:01.000000Z",
            "all",
            0,
            0,
        )

        self.assertEqual(summary.count, 0)

    def test_summary_filters_source_confidence_and_daynight(self):
        features = [
            detection("2026-11-14", 1, "VIIRS_NOAA20_NRT", "VIIRS", "l", 1, daynight="D"),
            detection("2026-11-14", 2, "VIIRS_NOAA20_NRT", "VIIRS", "h", 1, daynight="N"),
        ]
        summary = DashboardSummary()

        summary.add_filtered(
            features,
            "2026-11-14T00:00:00.000000Z",
            "2026-11-15T00:00:00.000000Z",
            "night",
            0,
            2,
        )

        self.assertEqual(summary.count, 1)
        self.assertEqual(summary.confidence["VIIRS H"], 1)
        self.assertEqual(summary.daynight["Night"], 1)


if __name__ == "__main__":
    unittest.main()
