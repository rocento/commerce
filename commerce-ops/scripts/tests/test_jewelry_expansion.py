import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "jewelry_seed", ROOT / "commerce-ops/scripts/expand-jewelry-catalog.py"
)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
MANIFEST = json.loads(
    (ROOT / "commerce-assets/demo/jewelry-expansion-20260929/manifest.json").read_text()
)


def snapshot():
    return {
        "products": [
            {
                "id": str(i),
                "sku": p["sku"],
                "slug": p["slug"],
                "name": p["name"],
                "attributes": {"original": "kept"},
                "attribute_set_id": None,
                "active": True,
            }
            for i, p in enumerate(MANIFEST["existing_products"])
        ],
        "definitions": [{"attribute_code": "color", "input_type": "text"}],
        "sets": [{"id": "default", "name": "Default", "members": [], "version": 1}],
        "categories": [
            {"id": str(i), "slug": c}
            for i, c in enumerate(sorted({p["category"] for p in MANIFEST["products"]}))
        ],
    }


class JewelryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.assets = Path(self.temp.name)
        for p in MANIFEST["products"]:
            (self.assets / p["image"]).write_bytes(b"image fixture")

    def tearDown(self):
        self.temp.cleanup()

    def test_twenty_distinct_designs_and_existing_attribute_preservation(self):
        data = snapshot()
        before = copy.deepcopy(data)
        _, defs, changes, attribute_set = seed.preflight(data, MANIFEST, self.assets)
        self.assertEqual(len(defs), 4)
        self.assertEqual(len(changes), 51)
        self.assertTrue(
            all(payload["attributes"]["original"] == "kept" for _, payload in changes)
        )
        self.assertTrue(
            all(
                m["group_name"] == "Jewelry recommendations"
                for m in attribute_set["members"]
            )
        )
        self.assertEqual(data, before)

    def test_wrong_installation_rejected(self):
        data = snapshot()
        data["products"][0]["sku"] = "DEMO-GRO-001"
        with self.assertRaises(AssertionError):
            seed.preflight(data, MANIFEST, self.assets)

    def test_existing_name_collision_rejected(self):
        data = snapshot()
        data["products"][0]["name"] = MANIFEST["products"][0]["name"]
        with self.assertRaises(AssertionError):
            seed.preflight(data, MANIFEST, self.assets)

    def test_missing_image_prevents_all_writes(self):
        (self.assets / MANIFEST["products"][-1]["image"]).unlink()
        with self.assertRaises(AssertionError):
            seed.preflight(snapshot(), MANIFEST, self.assets)

    def test_unsupported_unit_is_rejected_before_apply(self):
        manifest = copy.deepcopy(MANIFEST)
        manifest["products"][0]["unit"] = "pair"
        with self.assertRaises(AssertionError):
            seed.preflight(snapshot(), manifest, self.assets)

    def test_unknown_option_rejected(self):
        manifest = copy.deepcopy(MANIFEST)
        manifest["products"][0]["attributes"]["jewelry_occasion"] = ["unlisted"]
        with self.assertRaises(AssertionError):
            seed.preflight(snapshot(), manifest, self.assets)

    def test_merchant_edit_is_not_overwritten(self):
        data = snapshot()
        data["products"][0]["attributes"]["jewelry_style"] = ["edited"]
        with self.assertRaises(ValueError):
            seed.preflight(data, MANIFEST, self.assets)


if __name__ == "__main__":
    unittest.main()
