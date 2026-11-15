import os
os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harmonize import (
    MIN_OVERLAP_DAYS,
    Coverage,
    Detection,
    Filters,
    RejectedQuery,
    calendar_document,
    capabilities_payload,
    cell_id,
    geometry_contains,
    harmonized_daily_activity,
    load_csv_store,
    parse_utc_interval,
)

AREA = {
    "type": "Polygon",
    "coordinates": [
        [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]],
        [[1, 1], [1.4, 1], [1.4, 1.4], [1, 1.4], [1, 1]],
    ],
}
FILTERS = Filters(
    frozenset({"terra", "aqua", "suomi-npp", "noaa-20", "noaa-21"}),
    "all",
    0,
    frozenset({"low", "nominal", "high"}),
    None,
    None,
)


def at(platform: str, longitude: float, latitude: float, day: date, **overrides) -> Detection:
    viirs = platform not in {"terra", "aqua"}
    acquired = datetime(day.year, day.month, day.day, 13, 30, tzinfo=__import__("datetime").UTC)
    return Detection(
        platform,
        latitude,
        longitude,
        acquired,
        overrides.get("frp_mw", 10.0),
        overrides.get("confidence_class", "high" if viirs else None),
        overrides.get("confidence_pct", None if viirs else 90),
        overrides.get("day_night", "D"),
    )


def archive():
    rows = []
    coverage = []
    for offset in range(14):
        day = date(2012, 1, 1) + timedelta(days=offset)
        for index in range(4):
            rows.append(at("aqua", 0.5 + index * 0.0001, 0.5, day))
        for index in range(5):
            rows.append(at("suomi-npp", 0.5 + index * 0.0001, 0.5, day))
        rows.append(at("noaa-20", 0.5, 0.5, day, confidence_class="nominal"))
        coverage.extend([
            Coverage(day, "aqua", "complete"),
            Coverage(day, "suomi-npp", "complete"),
            Coverage(day, "noaa-20", "complete"),
        ])
    hole = date(2012, 1, 20)
    for index in range(4):
        rows.append(at("aqua", 0.5 + index * 0.0001, 0.5, hole))
    for index in range(5):
        rows.append(at("suomi-npp", 0.5 + index * 0.0001, 0.5, hole))
    rows.append(at("suomi-npp", 1.2, 1.2, hole))
    coverage.extend([Coverage(hole, "aqua", "complete"), Coverage(hole, "suomi-npp", "complete")])
    split = date(2012, 1, 21)
    for latitude in (0.5, 0.7, 0.9, 1.1, 1.3):
        rows.append(at("aqua", 0.5, latitude, split))
    rows.append(at("suomi-npp", 0.5, 0.5, split))
    coverage.extend([Coverage(split, "aqua", "complete"), Coverage(split, "suomi-npp", "complete")])
    terra_day = date(2012, 1, 22)
    rows.append(at("terra", 0.5, 0.5, terra_day, confidence_pct=95))
    coverage.append(Coverage(terra_day, "suomi-npp", "complete"))
    early = date(2005, 7, 1)
    rows.extend([at("aqua", 0.5, 0.5, early), at("aqua", 0.5, 0.7, early)])
    coverage.extend([
        Coverage(early, "aqua", "complete"),
        Coverage(date(2005, 7, 2), "aqua", "complete"),
        Coverage(date(2005, 8, 1), "aqua", "unknown"),
    ])
    return rows, coverage


class HarmonizedActivityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows, cls.coverage = archive()

    def activity(self, start: date, end: date):
        return harmonized_daily_activity(self.rows, AREA, start, end, self.coverage, FILTERS)

    def test_partial_utc_interval_covers_only_touched_days(self):
        self.assertEqual(parse_utc_interval({"start": "2026-11-14T14:25:00Z", "endExclusive": "2026-11-15T14:25:00Z"}), (date(2026, 11, 14), date(2026, 11, 16)))
        self.assertEqual(parse_utc_interval({"start": "2026-11-14T00:00:00Z", "endExclusive": "2026-11-15T00:00:00Z"}), (date(2026, 11, 14), date(2026, 11, 15)))
        with self.assertRaises(ValueError):
            parse_utc_interval({"start": "2026-11-15T00:00:00Z", "endExclusive": "2026-11-14T00:00:00Z"})

    def test_cell_union_and_satellite_double_count(self):
        self.assertEqual(cell_id(0.5, 0.5), cell_id(0.5003, 0.5))
        result = self.activity(date(2012, 1, 1), date(2012, 1, 2))
        self.assertEqual(result.days[0].count, 1)
        self.assertEqual(result.days[0].state, "complete")
        self.assertLess(result.scaled_error, result.raw_pixel_error)

    def test_hole_is_excluded(self):
        self.assertFalse(geometry_contains(1.2, 1.2, AREA))
        self.assertTrue(geometry_contains(0.5, 0.5, AREA))
        result = self.activity(date(2012, 1, 20), date(2012, 1, 21))
        self.assertEqual(result.days[0].count, 1)

    def test_viirs_era_does_not_add_aqua(self):
        result = self.activity(date(2012, 1, 21), date(2012, 1, 22))
        self.assertEqual(result.days[0].count, 1)

    def test_terra_is_excluded(self):
        result = self.activity(date(2012, 1, 22), date(2012, 1, 23))
        self.assertEqual(result.days[0].count, 0)
        self.assertEqual(result.days[0].state, "complete")

    def test_pre_viirs_days_use_the_stored_overlap_scale(self):
        result = self.activity(date(2005, 7, 1), date(2005, 7, 4))
        self.assertGreaterEqual(result.overlap_days, MIN_OVERLAP_DAYS)
        self.assertEqual(result.scale, 1)
        self.assertEqual(result.days[0].count, 2)
        self.assertEqual(result.days[1].count, 0)
        self.assertEqual(result.days[1].state, "complete")
        self.assertIsNone(result.days[2].count)
        self.assertEqual(result.days[2].state, "unavailable")

    def test_unknown_coverage_is_not_reported_as_zero(self):
        result = self.activity(date(2005, 8, 1), date(2005, 8, 2))
        self.assertIsNone(result.days[0].count)
        self.assertEqual(result.days[0].state, "unknown")

    def test_thin_overlap_withholds_harmonized_counts(self):
        rows, coverage = archive()
        short = [row for row in rows if row.acquired_at.date() < date(2012, 1, 4)]
        short_coverage = [record for record in coverage if record.day < date(2012, 1, 4) or record.day.year == 2005]
        result = harmonized_daily_activity(short, AREA, date(2005, 7, 1), date(2005, 7, 2), short_coverage, FILTERS)
        self.assertIsNone(result.scale)
        self.assertLess(result.overlap_days, MIN_OVERLAP_DAYS)
        self.assertIsNone(result.days[0].count)
        self.assertEqual(result.days[0].state, "unavailable")
        self.assertTrue(any(str(MIN_OVERLAP_DAYS) in note for note in result.notes))

    def test_area_outside_registered_reporting_geometry_is_unavailable(self):
        elsewhere = {"type": "Polygon", "coordinates": [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]}
        result = harmonized_daily_activity(self.rows, elsewhere, date(2005, 7, 2), date(2005, 7, 3), self.coverage, FILTERS, coverage_geometry=AREA)
        self.assertIsNone(result.days[0].count)
        self.assertEqual(result.days[0].state, "unavailable")

    def test_csv_store_and_calendar_document(self):
        with tempfile.TemporaryDirectory() as directory:
            detections = Path(directory) / "detections.csv"
            coverage = Path(directory) / "coverage.csv"
            detections.write_text(
                "platform_code,latitude,longitude,acquired_at,frp_mw,confidence_class,confidence_pct,day_night\n"
                "A,0.5,0.5,2012-01-01T13:30:00Z,12.5,,90,D\n",
                encoding="utf-8",
            )
            coverage.write_text("date,platform_code,state\n2012-01-01,A,complete\n", encoding="utf-8")
            store = load_csv_store(detections, coverage)
        self.assertEqual(store.rows[0].platform, "aqua")
        described = capabilities_payload(store, date(2026, 11, 14))
        self.assertEqual(described["processingModes"], ["harmonized"])
        self.assertFalse(described["seasonal"])
        self.assertFalse(described["anomalies"])
        self.assertEqual(described["exportFormats"], [])
        with self.assertRaises(RejectedQuery):
            calendar_document({
                "id": "query-1",
                "processingMode": "raw",
                "aoi": {"geometry": AREA},
                "interval": {"start": "2012-01-01T00:00:00.000Z", "endExclusive": "2012-01-02T00:00:00.000Z"},
                "filters": FILTERS_PAYLOAD,
            }, store)


FILTERS_PAYLOAD = {
    "platforms": ["terra", "aqua", "suomi-npp", "noaa-20", "noaa-21"],
    "dayNight": "all",
    "modisConfidenceMin": 0,
    "viirsConfidence": ["low", "nominal", "high"],
    "frpMin": None,
    "frpMax": None,
}


class CalendarRouteTest(unittest.TestCase):
    def test_capabilities_and_calendar_round_trip(self):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi is not installed")
        from app import app
        with tempfile.TemporaryDirectory() as directory:
            detections = Path(directory) / "detections.csv"
            coverage_path = Path(directory) / "coverage.csv"
            detection_lines = ["platform_code,latitude,longitude,acquired_at,frp_mw,confidence_class,confidence_pct,day_night"]
            coverage_lines = ["date,platform_code,state"]
            rows, coverage = archive()
            for row in rows:
                detection_lines.append(",".join([
                    {"terra": "T", "aqua": "A", "suomi-npp": "N", "noaa-20": "N20", "noaa-21": "N21"}[row.platform],
                    str(row.latitude),
                    str(row.longitude),
                    row.acquired_at.isoformat().replace("+00:00", "Z"),
                    "" if row.frp_mw is None else str(row.frp_mw),
                    row.confidence_class or "",
                    "" if row.confidence_pct is None else str(row.confidence_pct),
                    row.day_night or "",
                ]))
            for record in coverage:
                coverage_lines.append(",".join([
                    record.day.isoformat(),
                    {"terra": "T", "aqua": "A", "suomi-npp": "N", "noaa-20": "N20", "noaa-21": "N21"}[record.platform],
                    record.state,
                ]))
            detections.write_text("\n".join(detection_lines) + "\n", encoding="utf-8")
            coverage_path.write_text("\n".join(coverage_lines) + "\n", encoding="utf-8")
            previous = {name: os.environ.get(name) for name in ("FIRE_DATA_CSV", "FIRE_COVERAGE_CSV", "DATABASE_URL", "FIRMS_MAP_KEY", "SHARP_GLOBAL_DB_PATH")}
            os.environ["SHARP_GLOBAL_DB_PATH"] = str(Path(directory) / "global.sqlite")
            os.environ["FIRE_DATA_CSV"] = str(detections)
            os.environ["FIRE_COVERAGE_CSV"] = str(coverage_path)
            os.environ.pop("DATABASE_URL", None)
            os.environ.pop("FIRMS_MAP_KEY", None)
            try:
                with TestClient(app) as client:
                    capabilities = client.get("/capabilities")
                    self.assertEqual(capabilities.status_code, 200)
                    self.assertEqual(capabilities.json()["processingModes"], ["harmonized"])
                    self.assertFalse(capabilities.json()["seasonal"])
                    self.assertFalse(capabilities.json()["anomalies"])
                    rejected = client.post("/analysis/calendar", json={"query": {"id": "query-1", "processingMode": "raw"}})
                    self.assertEqual(rejected.status_code, 422)
                    self.assertIn("message", rejected.json())
                    payload = {"query": {
                        "id": "query-1",
                        "processingMode": "harmonized",
                        "aoi": {"geometry": AREA},
                        "interval": {"start": "2005-07-01T00:00:00.000Z", "endExclusive": "2005-07-04T00:00:00.000Z"},
                        "filters": FILTERS_PAYLOAD,
                    }}
                    accepted = client.post("/analysis/calendar", json=payload)
                    self.assertEqual(accepted.status_code, 200, accepted.text)
                    body = accepted.json()
                    self.assertEqual(body["meta"]["queryId"], "query-1")
                    self.assertEqual(body["meta"]["mode"], "live")
                    self.assertEqual(body["meta"]["units"]["count"], "harmonized active cells")
                    self.assertEqual(body["data"][0]["count"], 2)
                    self.assertEqual(body["data"][1]["count"], 0)
                    self.assertEqual(body["data"][1]["state"], "complete")
                    self.assertIsNone(body["data"][2]["count"])
                    self.assertEqual(body["data"][2]["state"], "unavailable")
                    for path in ("/analysis/overview", "/analysis/time-series", "/analysis/observations", "/analysis/map-source"):
                        response = client.post(path, json=payload)
                        self.assertEqual(response.status_code, 200, response.text)
                        self.assertEqual(response.json()["meta"]["queryId"], "query-1")
                    overview = client.post("/analysis/overview", json=payload).json()
                    self.assertEqual(overview["data"]["detectionCount"]["value"], 2)
                    self.assertEqual(overview["data"]["daysWithDetections"]["value"], 1)
                    self.assertEqual(overview["data"]["peakDate"]["value"], "2005-07-01")
                    self.assertEqual(overview["data"]["medianFrp"]["value"], 10)
                    self.assertEqual(overview["meta"]["completeness"], "partial")
                    series = client.post("/analysis/time-series", json=payload).json()
                    aqua = [bucket for bucket in series["data"] if bucket["platform"] == "aqua" and bucket["date"] == "2005-07-01"]
                    self.assertEqual(aqua[0]["count"], 2)
                    self.assertEqual(aqua[0]["state"], "complete")
                    page = client.post("/analysis/observations", json={**payload, "options": {"page": 1, "pageSize": 10}}).json()
                    self.assertEqual(page["data"]["total"], 2)
                    self.assertEqual(len(page["data"]["rows"]), 2)
                    mapped = client.post("/analysis/map-source", json=payload).json()
                    self.assertEqual(len(mapped["data"]["data"]["features"]), 2)
                    partial = {"query": {**payload["query"], "interval": {"start": "2005-07-01T13:31:00Z", "endExclusive": "2005-07-02T13:31:00Z"}}}
                    excluded = client.post("/analysis/map-source", json=partial)
                    self.assertEqual(excluded.status_code, 200, excluded.text)
                    self.assertEqual(excluded.json()["data"]["data"]["features"], [])
                    summary = client.post("/analysis/overview", json=partial)
                    self.assertEqual(summary.json()["data"]["detectionCount"]["value"], 0)
                    partial["query"]["interval"]["start"] = "2005-07-01T13:30:00Z"
                    included = client.post("/analysis/map-source", json=partial)
                    self.assertEqual(len(included.json()["data"]["data"]["features"]), 2)
                    partial["query"]["interval"]["endExclusive"] = "2005-07-01T13:30:00Z"
                    partial["query"]["interval"]["start"] = "2005-07-01T00:00:00Z"
                    excluded_end = client.post("/analysis/map-source", json=partial)
                    self.assertEqual(excluded_end.json()["data"]["data"]["features"], [])
                    blocked = client.get("/hotspots", params={"area": "0,0,1,1", "days": 1})
                    self.assertEqual(blocked.status_code, 503)
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
