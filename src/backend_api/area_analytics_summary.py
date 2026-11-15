"""Compact, exact summaries for Area Analytics."""

import heapq
import json
import math
from collections import Counter
from datetime import date, datetime, tzinfo
from typing import Any

from harmonize import geometry_contains

SAMPLE_LIMIT = 500
FRP_RANGES = (
    ("0-10 MW", 0, 10),
    ("10-50 MW", 10, 50),
    ("50-100 MW", 50, 100),
    ("100+ MW", 100, math.inf),
)


class AreaAnalyticsSummary:
    def __init__(self, sample_limit: int = SAMPLE_LIMIT):
        self.sample_limit = sample_limit
        self.count = 0
        self.daily = Counter()
        self.products = Counter()
        self.daynight = Counter()
        self.confidence = Counter()
        self.frp_buckets = Counter()
        self.frp_values: list[float] = []
        self.frp_reported = 0
        self.hours = Counter()
        self.cells = Counter()
        self.cell_centers: dict[str, tuple[float, float]] = {}
        self.latest: list[tuple[str, int, dict[str, Any]]] = []
        self.sequence = 0
        self.highest_frp: dict[str, Any] | None = None

    def add(self, feature: dict[str, Any]) -> None:
        properties = feature["properties"]
        acquired = properties["acquired_at"]
        self.count += 1
        self.daily[acquired[:10]] += 1
        self.products[properties["source"]] += 1

        daynight = properties.get("daynight")
        self.daynight["Day" if daynight == "D" else "Night" if daynight == "N" else "Unknown"] += 1

        confidence = properties.get("confidence")
        if properties["sensor"] == "VIIRS":
            label = f"VIIRS {confidence.upper()}" if isinstance(confidence, str) else "VIIRS unknown"
        elif isinstance(confidence, (int, float)):
            label = (
                "MODIS 80-100"
                if confidence >= 80
                else "MODIS 30-79" if confidence >= 30 else "MODIS 0-29"
            )
        else:
            label = "MODIS unknown"
        self.confidence[label] += 1

        frp = properties.get("frp_mw")
        if isinstance(frp, (int, float)) and math.isfinite(frp) and frp >= 0:
            self.frp_reported += 1
            self.frp_values.append(frp)
            for label, lower, upper in FRP_RANGES:
                if lower <= frp < upper:
                    self.frp_buckets[label] += 1
                    break
            if self.highest_frp is None or frp > self.highest_frp["properties"]["frp_mw"]:
                self.highest_frp = feature
        else:
            self.frp_buckets["Not reported"] += 1

        self.hours[int(acquired[11:13])] += 1
        longitude, latitude = feature["geometry"]["coordinates"]
        x = min(179, math.floor((longitude + 180) / 2))
        y = min(89, math.floor((latitude + 90) / 2))
        key = f"{x}:{y}"
        west, south = -180 + x * 2, -90 + y * 2
        self.cell_centers[key] = (round(west + 1, 2), round(south + 1, 2))
        self.cells[key] += 1

        self.sequence += 1
        entry = (acquired, self.sequence, feature)
        if len(self.latest) < self.sample_limit:
            heapq.heappush(self.latest, entry)
        elif entry > self.latest[0]:
            heapq.heapreplace(self.latest, entry)

    def add_many(self, features: list[dict[str, Any]]) -> None:
        for feature in features:
            self.add(feature)

    def add_filtered(
        self,
        features: list[dict[str, Any]],
        lower: str,
        upper: str,
        daynight: str,
        modis_min: int,
        viirs_min_rank: int,
        geometry: dict[str, Any] | None = None,
    ) -> None:
        for feature in features:
            properties = feature["properties"]
            acquired = properties["acquired_at"]
            acquired_key = f"{acquired[:19]}.000000Z"
            if not lower <= acquired_key < upper:
                continue
            if geometry and not geometry_contains(
                *feature["geometry"]["coordinates"], geometry
            ):
                continue
            if daynight != "all" and properties["daynight"] != {"day": "D", "night": "N"}[daynight]:
                continue
            confidence = properties["confidence"]
            if properties["sensor"] == "MODIS" and confidence < modis_min:
                continue
            if (
                properties["sensor"] == "VIIRS"
                and {"l": 0, "n": 1, "h": 2}[confidence] < viirs_min_rank
            ):
                continue
            self.add(feature)

    def to_cache(self) -> str:
        return json.dumps(
            {
                "sample_limit": self.sample_limit,
                "count": self.count,
                "daily": dict(self.daily),
                "products": dict(self.products),
                "daynight": dict(self.daynight),
                "confidence": dict(self.confidence),
                "frp_buckets": dict(self.frp_buckets),
                "frp_values": self.frp_values,
                "frp_reported": self.frp_reported,
                "hours": dict(self.hours),
                "cells": dict(self.cells),
                "cell_centers": self.cell_centers,
                "latest": [
                    feature
                    for _, _, feature in sorted(self.latest, key=lambda item: (item[0], item[1]))
                ],
                "highest_frp": self.highest_frp,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_cache(cls, payload: str) -> "AreaAnalyticsSummary":
        saved = json.loads(payload)
        summary = cls(saved["sample_limit"])
        summary.count = saved["count"]
        summary.daily.update(saved["daily"])
        summary.products.update(saved["products"])
        summary.daynight.update(saved["daynight"])
        summary.confidence.update(saved["confidence"])
        summary.frp_buckets.update(saved["frp_buckets"])
        summary.frp_values = saved["frp_values"]
        summary.frp_reported = saved["frp_reported"]
        summary.hours.update({int(hour): count for hour, count in saved["hours"].items()})
        summary.cells.update(saved["cells"])
        summary.cell_centers = {
            key: tuple(center) for key, center in saved["cell_centers"].items()
        }
        summary.highest_frp = saved["highest_frp"]
        for feature in saved["latest"]:
            summary.sequence += 1
            heapq.heappush(
                summary.latest,
                (feature["properties"]["acquired_at"], summary.sequence, feature),
            )
        return summary

    def merge(self, other: "AreaAnalyticsSummary") -> None:
        self.count += other.count
        self.daily.update(other.daily)
        self.products.update(other.products)
        self.daynight.update(other.daynight)
        self.confidence.update(other.confidence)
        self.frp_buckets.update(other.frp_buckets)
        self.frp_values.extend(other.frp_values)
        other.frp_values = []
        self.frp_reported += other.frp_reported
        self.hours.update(other.hours)
        self.cells.update(other.cells)
        self.cell_centers.update(other.cell_centers)
        if other.highest_frp is not None and (
            self.highest_frp is None
            or other.highest_frp["properties"]["frp_mw"]
            > self.highest_frp["properties"]["frp_mw"]
        ):
            self.highest_frp = other.highest_frp
        for _, _, feature in other.latest:
            self.sequence += 1
            entry = (feature["properties"]["acquired_at"], self.sequence, feature)
            if len(self.latest) < self.sample_limit:
                heapq.heappush(self.latest, entry)
            elif entry > self.latest[0]:
                heapq.heapreplace(self.latest, entry)
        other.latest.clear()
        other.highest_frp = None

    def payload(self, days: list[date], zone: tzinfo) -> dict[str, Any]:
        latest = [
            self._with_local_time(feature, zone)
            for _, _, feature in sorted(self.latest, key=lambda entry: entry[0], reverse=True)
        ]
        cells = sorted(self.cells, key=self.cells.get, reverse=True)[:8]
        cell_payload = [
            {
                "label": f"{self.cell_centers[key][1]:.2f}°, {self.cell_centers[key][0]:.2f}°",
                "count": self.cells[key],
                "longitude": self.cell_centers[key][0],
                "latitude": self.cell_centers[key][1],
            }
            for key in cells
        ]
        confidence_order = (
            "VIIRS H",
            "VIIRS N",
            "VIIRS L",
            "VIIRS unknown",
            "MODIS 80-100",
            "MODIS 30-79",
            "MODIS 0-29",
            "MODIS unknown",
        )
        return {
            "features": latest,
            "daily": [
                {"date": day.isoformat(), "count": self.daily[day.isoformat()]} for day in days
            ],
            "products": [
                {"label": label, "count": count} for label, count in self.products.items()
            ],
            "daynight": [
                {"label": label, "count": self.daynight[label]}
                for label in ("Day", "Night", "Unknown")
                if self.daynight[label]
            ],
            "confidence": [
                {"label": label, "count": self.confidence[label]}
                for label in confidence_order
                if self.confidence[label]
            ],
            "frp": [
                {"label": label, "count": self.frp_buckets[label]}
                for label, _, _ in FRP_RANGES
            ]
            + (
                [{"label": "Not reported", "count": self.frp_buckets["Not reported"]}]
                if self.frp_buckets["Not reported"]
                else []
            ),
            "frpReported": self.frp_reported,
            "medianFrp": self._median_frp(),
            "hourly": [{"hour": hour, "count": self.hours[hour]} for hour in range(24)],
            "topCells": cell_payload,
            "latest": latest[0] if latest else None,
            "highestFrp": (
                self._with_local_time(self.highest_frp, zone)
                if self.highest_frp is not None
                else None
            ),
        }

    @staticmethod
    def _with_local_time(feature: dict[str, Any], zone: tzinfo) -> dict[str, Any]:
        properties = feature["properties"]
        acquired = datetime.fromisoformat(properties["acquired_at"])
        return {
            **feature,
            "properties": {
                **properties,
                "acquired_at_local": acquired.astimezone(zone).isoformat(),
            },
        }

    def _median_frp(self) -> float | None:
        if not self.frp_values:
            return None
        self.frp_values.sort()
        middle = len(self.frp_values) // 2
        if len(self.frp_values) % 2:
            return self.frp_values[middle]
        return (self.frp_values[middle - 1] + self.frp_values[middle]) / 2
