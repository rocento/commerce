import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "grocery_attributes", ROOT / "commerce-ops/scripts/demo/seed-grocery-recommendation-attributes.py"
)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
MANIFEST = json.loads(
    (ROOT / "commerce-assets/demo/grocery-recommendation-attributes/manifest.json").read_text()
)


def snapshot():
    return {
        "definitions": [],
        "sets": [{"id": "default", "name": "Default", "version": 1, "members": []}],
        "products": [
            {
                "id": str(i),
                "sku": p["sku"],
                "name": p["name"],
                "slug": p["slug"],
                "attributes": {"existing": "preserved"},
                "active": i % 2 == 0,
                "attribute_set_id": None,
                "price": "3.50",
                "media_ids": ["photo"],
            }
            for i, p in enumerate(MANIFEST["products"])
        ],
    }


class Client:
    def __init__(self, data):
        self.data = copy.deepcopy(data)
        self.writes = []

    def call(self, method, path, body=None):
        if method == "GET":
            if "?offset=" in path:
                offset = int(path.split("=")[-1])
                return copy.deepcopy(self.data["products"][offset : offset + 50])
            return copy.deepcopy(
                next(p for p in self.data["products"] if p["id"] == path.split("/")[-1])
            )
        self.writes.append((method, path))
        if "attribute-definitions" in path:
            self.data["definitions"].append(copy.deepcopy(body))
        elif "attribute-sets" in path:
            self.data["sets"] = [copy.deepcopy(body)]
        else:
            next(
                p for p in self.data["products"] if p["id"] == path.split("/")[-1]
            ).update(copy.deepcopy(body))


class GroceryAttributesTests(unittest.TestCase):
    def test_all_150_products_are_idempotent_and_existing_fields_preserved(self):
        data = snapshot()
        before = copy.deepcopy(data)
        client = Client(data)
        self.assertEqual(seed.apply(client, data, MANIFEST)["updated_products"], 150)
        self.assertEqual(data, before)
        self.assertEqual(seed.plan(client.data, MANIFEST), ([], [], None))
        self.assertEqual(sum(p["active"] for p in client.data["products"]), 75)

    def test_all_conflicts_are_checked_before_writes(self):
        data = snapshot()
        data["products"][-1]["attributes"]["meal_occasion"] = ["unexpected"]
        client = Client(data)
        with self.assertRaises(ValueError):
            seed.apply(client, data, MANIFEST)
        self.assertEqual(client.writes, [])

    def test_no_food_uses_for_soap_and_no_raw_meat_suggestions(self):
        self.assertEqual(len(MANIFEST["products"]), 150)
        for p in MANIFEST["products"]:
            a = p["attributes"]
            if "Dish Soap" in p["name"]:
                self.assertEqual(a, {"grocery_group": ["household"]})
            if a["grocery_group"] == ["meat"]:
                self.assertNotIn("no_cook", a["preparation_method"])

    def test_definition_collision_is_rejected(self):
        data = snapshot()
        data["definitions"] = [copy.deepcopy(MANIFEST["definitions"][0])]
        data["definitions"][0]["is_filterable"] = False
        with self.assertRaises(ValueError):
            seed.plan(data, MANIFEST)


if __name__ == "__main__":
    unittest.main()
