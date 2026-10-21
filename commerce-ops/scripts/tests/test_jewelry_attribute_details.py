import importlib.util
import json
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "seed", ROOT / "commerce-ops/scripts/demo/seed-grocery-recommendation-attributes.py"
)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
MANIFEST = json.loads(
    (ROOT / "commerce-assets/demo/jewelry-attributes-20260930/manifest.json").read_text()
)


class DetailsTests(unittest.TestCase):
    def test_dimensions_are_only_from_titles(self):
        for row in MANIFEST["products"]:
            if "size" in row["attributes"]:
                self.assertIn("US Size " + row["attributes"]["size"], row["name"])
            if "jewelry_length" in row["attributes"]:
                self.assertIn("— " + row["attributes"]["jewelry_length"], row["name"])
        self.assertEqual(
            sum("size" in p["attributes"] for p in MANIFEST["products"]), 27
        )
        self.assertEqual(
            sum("jewelry_length" in p["attributes"] for p in MANIFEST["products"]), 17
        )

    def test_mixed_scalar_and_multi_select_validate_without_overwriting(self):
        data = {
            "definitions": [],
            "sets": [{"name": "Default", "id": "default", "members": []}],
            "products": [
                {
                    "id": str(i),
                    "sku": p["sku"],
                    "name": p["name"],
                    "slug": p["slug"],
                    "attributes": {"existing": "preserved"},
                    "attribute_set_id": None,
                    "active": True,
                }
                for i, p in enumerate(MANIFEST["products"])
            ],
        }
        _, changes, _ = seed.plan(data, MANIFEST, group_name="Jewelry recommendations")
        self.assertEqual(len(changes), 71)
        data["sets"][0]["members"] = [
            {
                "definition_id": "existing-id",
                "group_name": "Jewelry recommendations",
                "position": 40,
            }
        ]
        _, _, updated = seed.plan(data, MANIFEST, group_name="Jewelry recommendations")
        positions = [m["position"] for m in updated["members"]]
        self.assertEqual(positions, [40, 50, 60, 70, 80])

        for _, p in changes:
            self.assertEqual(p["attributes"]["existing"], "preserved")
        invalid = deepcopy(MANIFEST)
        invalid["products"][0]["attributes"]["jewelry_length"] = ["24cm"]
        with self.assertRaises(ValueError):
            seed.plan(data, invalid)
        invalid = deepcopy(MANIFEST)
        invalid["products"][0]["attributes"]["jewelry_design"] = "chain"
        with self.assertRaises(ValueError):
            seed.plan(data, invalid)


if __name__ == "__main__":
    unittest.main()
