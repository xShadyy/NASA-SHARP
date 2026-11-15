import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app import Source, app, area_boxes_for_geometry


def feature(day: date, frp: float, longitude=-68.1, latitude=-13.1):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {
            "source": Source.MODIS_NRT.value,
            "sensor": "MODIS",
            "satellite": "Terra",
            "processing": "NRT",
            "nominal_resolution_m": 1000,
            "acquired_at": f"{day.isoformat()}T13:30:00Z",
            "acquired_at_local": f"{day.isoformat()}T13:30:00+00:00",
            "confidence": 90,
            "confidence_scale": "0-100",
            "confidence_class": None,
            "frp_mw": frp,
            "brightness_k": 310.0,
            "daynight": "D",
        },
    }


class HotspotsSummaryRouteTest(unittest.TestCase):
    def test_summary_endpoint_returns_full_metrics_and_bounded_records(self):
        first_day = date(2026, 11, 12)
        second_day = date(2026, 11, 13)

        async def fake_load_batch(test_app, product, bounds, day, _today):
            features = [feature(day, 10.0)] if day in (first_day, second_day) else []
            fetched = time.time()
            key = test_app.state.cache.key(product.value, bounds, day.isoformat())
            await asyncio.to_thread(
                test_app.state.cache.put, key, features, fetched, 3600
            )
            return features, fetched, True

        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "FIRMS_MAP_KEY": "test-key",
                "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite3"),
            }
            with patch.dict(os.environ, environment):
                with TestClient(app) as client:
                    with patch("app.load_batch", new=AsyncMock(side_effect=fake_load_batch)):
                        response = client.get(
                            "/hotspots",
                            params={
                                "area": "world",
                                "start_date": first_day.isoformat(),
                                "days": 2,
                                "source": Source.MODIS_NRT.value,
                                "summary": "true",
                            },
                        )
                        with patch(
                            "app.load_batch",
                            new=AsyncMock(side_effect=AssertionError("cache should avoid batch load")),
                        ):
                            cached_response = client.get(
                                "/hotspots",
                                params={
                                    "area": "world",
                                    "start_date": first_day.isoformat(),
                                    "days": 2,
                                    "source": Source.MODIS_NRT.value,
                                    "summary": "true",
                                },
                            )
                        full_response = client.get(
                            "/hotspots",
                            params={
                                "area": "world",
                                "start_date": first_day.isoformat(),
                                "days": 2,
                                "source": Source.MODIS_NRT.value,
                            },
                        )
                        self.assertEqual(full_response.status_code, 200, full_response.text)
                        self.assertNotIn("summary", full_response.json())
                        self.assertEqual(full_response.json()["count"], 2)
                        self.assertEqual(len(full_response.json()["features"]), 2)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["summary"]["daily"], [
            {"date": first_day.isoformat(), "count": 1},
            {"date": second_day.isoformat(), "count": 1},
        ])
        self.assertEqual(payload["summary"]["frpReported"], 2)
        self.assertEqual(len(payload["features"]), 2)
        self.assertEqual(payload["sources"][0]["successful_days"], 2)
        self.assertEqual(cached_response.status_code, 200, cached_response.text)
        self.assertEqual(cached_response.json()["count"], payload["count"])
        self.assertEqual(
            cached_response.json()["summary"]["daily"], payload["summary"]["daily"]
        )
        self.assertEqual(
            cached_response.json()["summary"]["frpReported"],
            payload["summary"]["frpReported"],
        )
        self.assertEqual(
            cached_response.json()["summary"]["highestFrp"]["properties"]["frp_mw"],
            payload["summary"]["highestFrp"]["properties"]["frp_mw"],
        )
        self.assertEqual(
            [feature["properties"]["acquired_at"] for feature in cached_response.json()["features"]],
            [feature["properties"]["acquired_at"] for feature in payload["features"]],
        )

    def test_netherlands_area_clips_summary_and_full_features_to_country(self):
        day = date(2026, 11, 13)

        async def fake_load_batch(_app, _product, _bounds, _day, _today):
            return (
                [
                    feature(day, 10.0, 5.1, 52.1),
                    feature(day, 20.0, 7.0, 51.5),
                ],
                time.time(),
                True,
            )

        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "FIRMS_MAP_KEY": "test-key",
                "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite3"),
            }
            with patch.dict(os.environ, environment):
                with TestClient(app) as client:
                    with patch("app.load_batch", new=AsyncMock(side_effect=fake_load_batch)):
                        summary_response = client.get(
                            "/hotspots",
                            params={
                                "area": "netherlands",
                                "start_date": day.isoformat(),
                                "days": 1,
                                "source": Source.MODIS_NRT.value,
                                "summary": "true",
                            },
                        )
                        full_response = client.get(
                            "/hotspots",
                            params={
                                "area": "netherlands",
                                "start_date": day.isoformat(),
                                "days": 1,
                                "source": Source.MODIS_NRT.value,
                            },
                        )

        self.assertEqual(summary_response.status_code, 200, summary_response.text)
        self.assertEqual(summary_response.json()["count"], 1)
        self.assertEqual(summary_response.json()["summary"]["products"][0]["count"], 1)
        self.assertEqual(
            summary_response.json()["features"][0]["geometry"]["coordinates"],
            [5.1, 52.1],
        )
        self.assertEqual(full_response.status_code, 200, full_response.text)
        self.assertEqual(full_response.json()["count"], 1)
        self.assertEqual(
            full_response.json()["features"][0]["geometry"]["coordinates"],
            [5.1, 52.1],
        )

    def test_analysis_area_clips_summary_and_features_to_confirmed_geometry(self):
        day = date(2026, 11, 13)
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [4.8, 51.8],
                [5.3, 51.8],
                [5.3, 52.3],
                [4.8, 52.3],
                [4.8, 51.8],
            ]],
        }
        requested_bounds = []

        async def fake_load_batch(_app, _product, bounds, _day, _today):
            requested_bounds.append(bounds)
            return (
                [
                    feature(day, 10.0, 5.0, 52.0),
                    feature(day, 20.0, 5.5, 52.0),
                ],
                time.time(),
                True,
            )

        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "FIRMS_MAP_KEY": "test-key",
                "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite3"),
            }
            with patch.dict(os.environ, environment):
                with TestClient(app) as client:
                    with patch("app.load_batch", new=AsyncMock(side_effect=fake_load_batch)):
                        summary_response = client.post(
                            "/hotspots/area",
                            json={
                                "geometry": geometry,
                                "start_date": day.isoformat(),
                                "days": 1,
                                "source": [Source.MODIS_NRT.value],
                                "summary": True,
                            },
                        )
                        full_response = client.post(
                            "/hotspots/area",
                            json={
                                "geometry": geometry,
                                "start_date": day.isoformat(),
                                "days": 1,
                                "source": [Source.MODIS_NRT.value],
                                "summary": False,
                            },
                        )

        self.assertEqual(summary_response.status_code, 200, summary_response.text)
        self.assertEqual(summary_response.json()["count"], 1)
        self.assertEqual(summary_response.json()["features"][0]["geometry"]["coordinates"], [5.0, 52.0])
        self.assertEqual(full_response.status_code, 200, full_response.text)
        self.assertEqual(full_response.json()["count"], 1)
        self.assertEqual(requested_bounds, ["4.8,51.8,5.3,52.3"] * 2)

    def test_analysis_area_crossing_antimeridian_uses_two_small_firms_boxes(self):
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [179.0, -1.0],
                [-179.0, -1.0],
                [-179.0, 1.0],
                [179.0, 1.0],
                [179.0, -1.0],
            ]],
        }
        self.assertEqual(
            area_boxes_for_geometry(geometry),
            ["179.0,-1.0,180,1.0", "-180,-1.0,-179.0,1.0"],
        )
        western_geometry = {
            "type": "Polygon",
            "coordinates": [[
                [-5.3, 1.0],
                [-4.8, 1.0],
                [-4.8, 2.0],
                [-5.3, 2.0],
                [-5.3, 1.0],
            ]],
        }
        self.assertEqual(area_boxes_for_geometry(western_geometry), ["-5.3,1.0,-4.8,2.0"])

    def test_analysis_area_crossing_antimeridian_filters_points_on_both_sides(self):
        day = date(2026, 11, 13)
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [179.0, -1.0],
                [-179.0, -1.0],
                [-179.0, 1.0],
                [179.0, 1.0],
                [179.0, -1.0],
            ]],
        }

        async def fake_load_batch(_app, _product, bounds, _day, _today):
            longitudes = [179.5] if bounds.startswith("179") else [-179.5, 0.0]
            return (
                [feature(day, 10.0, longitude, 0.0) for longitude in longitudes],
                time.time(),
                True,
            )

        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "FIRMS_MAP_KEY": "test-key",
                "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite3"),
            }
            with patch.dict(os.environ, environment):
                with TestClient(app) as client:
                    with patch("app.load_batch", new=AsyncMock(side_effect=fake_load_batch)):
                        response = client.post(
                            "/hotspots/area",
                            json={
                                "geometry": geometry,
                                "start_date": day.isoformat(),
                                "days": 1,
                                "source": [Source.MODIS_NRT.value],
                                "summary": True,
                            },
                        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["count"], 2)
        self.assertEqual(
            {tuple(item["geometry"]["coordinates"]) for item in response.json()["features"]},
            {(179.5, 0.0), (-179.5, 0.0)},
        )

    def test_area_analytics_stream_reports_completed_days_before_the_result(self):
        first_day = date(2026, 11, 12)
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [4.8, 51.8],
                [5.3, 51.8],
                [5.3, 52.3],
                [4.8, 52.3],
                [4.8, 51.8],
            ]],
        }

        async def fake_load_batch(_app, _product, _bounds, day, _today):
            return [feature(day, 10.0, 5.0, 52.0)], time.time(), True

        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "FIRMS_MAP_KEY": "test-key",
                "FIRMS_CACHE_PATH": str(Path(directory) / "cache.sqlite3"),
            }
            with patch.dict(os.environ, environment):
                with TestClient(app) as client:
                    with patch("app.load_batch", new=AsyncMock(side_effect=fake_load_batch)):
                        response = client.post(
                            "/hotspots/stream",
                            json={
                                "geometry": geometry,
                                "start_date": first_day.isoformat(),
                                "days": 2,
                                "source": [Source.MODIS_NRT.value],
                            },
                        )

        self.assertEqual(response.status_code, 200, response.text)
        events = [json.loads(line) for line in response.text.splitlines()]
        progress = [event for event in events if event["type"] == "progress"]
        self.assertEqual([event["processed_days"] for event in progress], [1, 2])
        self.assertTrue(all(event["total_days"] == 2 for event in progress))
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["data"]["count"], 2)


if __name__ == "__main__":
    unittest.main()
