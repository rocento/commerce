import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "advanced", ROOT / "commerce-ops/scripts/advanced-assistant-attributes.py"
)
advanced = importlib.util.module_from_spec(spec)
spec.loader.exec_module(advanced)


def fixture():
    product = {
        "id": "product",
        "sku": "demo",
        "name": "Demo face cleanser",
        "slug": "demo",
        "attributes": {"care-area": "Face", "product-kind": "Cleanser"},
        "active": True,
        "in_stock": True,
        "price": "12.00",
        "attribute_set_id": None,
    }
    definition = advanced.definition(
        "pharmacy",
        "routine_step",
        "Routine step",
        role="intended_use",
        policy="semantic",
    )
    definition["options"] = [{"value": "cleansing", "label": "Cleansing"}]
    before = {
        "definitions": [],
        "sets": [{"id": "default", "name": "Default", "version": 1, "members": []}],
        "products": [product],
    }
    manifest = {
        "definitions": [definition],
        "role_updates": [],
        "products": [
            {
                "id": product["id"],
                "sku": product["sku"],
                "name": product["name"],
                "slug": product["slug"],
                "attributes": {"routine_step": ["cleansing"]},
                "evidence": {"attributes": copy.deepcopy(product["attributes"])},
            }
        ],
    }
    return before, manifest


class Client:
    def __init__(self, data):
        self.data = copy.deepcopy(data)
        self.writes = []

    def call(self, method, path, body=None):
        if method == "GET":
            if "attribute-definitions" in path:
                return copy.deepcopy(self.data["definitions"])
            if "attribute-sets" in path:
                return copy.deepcopy(self.data["sets"])
            if "?offset=" in path:
                return copy.deepcopy(
                    self.data["products"][int(path.split("=")[-1]) :][:50]
                )
            return copy.deepcopy(
                next(p for p in self.data["products"] if p["id"] == path.split("/")[-1])
            )
        self.writes.append((method, path))
        table = (
            "definitions"
            if "attribute-definitions" in path
            else "sets"
            if "attribute-sets" in path
            else "products"
        )
        identity = body.get("id") or path.split("/")[-1]
        old = next((x for x in self.data[table] if x["id"] == identity), None)
        if old:
            old.update(copy.deepcopy(body))
        else:
            self.data[table].append(copy.deepcopy(body))


class AdvancedAttributesTests(unittest.TestCase):
    def test_idempotence_and_preservation(self):
        before, manifest = fixture()
        client = Client(before)
        report, after = advanced.apply(client, before, manifest)
        self.assertEqual(report["products_updated"], 1)
        self.assertEqual(after["products"][0]["price"], "12.00")
        self.assertEqual(after["products"][0]["attributes"]["care-area"], "Face")
        self.assertEqual(advanced.plan(after, manifest), ([], [], []))
        self.assertNotIn("routine_step", before["products"][0]["attributes"])

    def test_changed_evidence_stops_before_any_write(self):
        before, manifest = fixture()
        before["products"][0]["attributes"]["care-area"] = "Eyes"
        client = Client(before)
        with self.assertRaisesRegex(ValueError, "Evidence changed"):
            advanced.apply(client, before, manifest)
        self.assertEqual(client.writes, [])

    def test_conflicting_attribute_stops_before_any_write(self):
        before, manifest = fixture()
        before["products"][0]["attributes"]["routine_step"] = ["other"]
        client = Client(before)
        with self.assertRaisesRegex(ValueError, "Attribute conflict"):
            advanced.apply(client, before, manifest)
        self.assertEqual(client.writes, [])

    def test_food_suggestions_do_not_make_raw_meat_no_cook(self):
        p = {
            "name": "Chicken Fillets 500g",
            "attributes": {
                "grocery_group": ["meat"],
                "preparation_method": ["grilling", "no_cook"],
                "meal_occasion": ["snack"],
            },
        }
        result = advanced.additions("grocery", p)
        self.assertEqual(result["grocery_use_case"], ["home_cooking"])
        self.assertEqual(result["pack_weight_g"], 500)
        self.assertEqual(
            advanced.additions(
                "grocery",
                {
                    "name": "Dish Soap 500g",
                    "attributes": {"grocery_group": ["household"]},
                },
            ),
            {},
        )

    def test_only_explicit_electronics_capacities(self):
        p = {
            "name": "Demo laptop",
            "attributes": {
                "device_type": "Laptop",
                "memory": "8 GB",
                "storage": "1 TB SSD",
                "connectivity": "Wi-Fi / Bluetooth",
            },
        }
        result = advanced.additions("electronics", p)
        self.assertEqual(result["ram_gb"], 8)
        self.assertEqual(result["storage_gb"], 1000)
        self.assertNotIn("screen_inches", result)
        self.assertNotIn("usb_c", result["connectivity_features"])

    def test_pharmacy_spf_is_not_inferred(self):
        p = {
            "name": "Face Moisturizer",
            "attributes": {"product-kind": "Moisturizer", "care-area": "Face"},
        }
        self.assertNotIn("catalog_spf", advanced.additions("pharmacy", p))
        p["name"] += " SPF 30"
        self.assertEqual(advanced.additions("pharmacy", p)["catalog_spf"], 30)


if __name__ == "__main__":
    unittest.main()
