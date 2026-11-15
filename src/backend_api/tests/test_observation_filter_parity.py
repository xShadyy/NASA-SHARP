
import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

os.environ["SHARP_GLOBAL_INGEST_ENABLED"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harmonize import CanonicalStore, Detection, detection_id
from global_store import GlobalStore
from global_tiles import GlobalPresentation
from observation_explorer import _matching


class ObservationFilterParityTest(unittest.TestCase):
    def test_shared_typescript_python_and_global_sql_contract(self):
        contract = json.loads((Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "observation-filter-parity.json").read_text(encoding="utf-8-sig"))
        rows = tuple(Detection(
            platform=item["platform"], latitude=item["latitude"], longitude=item["longitude"],
            acquired_at=datetime.fromisoformat(item["acquiredAt"].replace("Z", "+00:00")), frp_mw=item["frpMw"],
            confidence_pct=item["confidence"]["value"] if item["sensor"] == "MODIS" else None,
            confidence_class=item["confidence"]["value"] if item["sensor"] == "VIIRS" else None,
            day_night={"day": "D", "night": "N"}.get(item["dayNight"]), source_product=item["sourceProduct"],
            processing_tier="NRT",
        ) for item in contract["observations"])
        self.assertEqual([detection_id(row) for row in rows], [item["id"] for item in contract["observations"]])
        canonical = CanonicalStore(rows, (), "Shared offline filter fixture")
        anchor = datetime(2026, 11, 15, 13, tzinfo=UTC)
        with tempfile.TemporaryDirectory() as directory:
            store = GlobalStore(Path(directory) / "global.sqlite")
            sources = sorted({row.source_product for row in rows})
            for source in sources:
                store.replace_source(source, [row for row in rows if row.source_product == source], anchor-timedelta(days=7), anchor, retrieved=anchor.timestamp())
            snapshot = store.publish(anchor, sources)["snapshot"]
            service = GlobalPresentation(store)
            for case in contract["cases"]:
                with self.subTest(case=case["name"]):
                    expected = sorted(case["expectedIds"])
                    self.assertEqual(sorted(detection_id(row) for row in _matching(list(rows), canonical, case["options"])), expected)
                    self.assertEqual(sorted(item["id"] for item in service.observations(snapshot, "24h", options=case["options"])["data"]["rows"]), expected)
            for case in contract["sortCases"]:
                with self.subTest(sort=case["name"]):
                    options = case["options"]
                    sort = options["sort"]
                    python_rows = list(rows)
                    python_rows.sort(key=lambda row: (row.frp_mw is None, -(row.frp_mw or 0), detection_id(row)) if sort == "frp" else ((-1 if sort == "newest" else 1)*row.acquired_at.timestamp(), detection_id(row)))
                    self.assertEqual([detection_id(row) for row in python_rows], case["expectedIds"])
                    
                    pages = [service.observations(snapshot, "24h", options={**options, "pageSize": 2, "page": page})["data"]["rows"] for page in range(1, 5)]
                    self.assertEqual([row["id"] for page in pages for row in page], case["expectedIds"])


if __name__ == "__main__":
    unittest.main()
