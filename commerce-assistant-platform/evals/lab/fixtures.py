"""Reviewed scenario definitions; regeneration requires an explicit catalog capture."""

import argparse
import json
from pathlib import Path
from uuid import UUID

from evals.lab.models import Dataset, Snapshot


def build(captured):
    snapshots, cases = [], []

    def add(snapshot, key, message, output=None, expected=None, **kwargs):
        case = {
            "id": snapshot["store"] + "-" + key,
            "snapshot": snapshot["id"],
            "store": snapshot["store"],
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "golden",
            "candidates": [p["id"] for p in snapshot["products"]],
            "turns": [
                {
                    "message": message,
                    "model_output": {"shopping": True, "query": "*", **(output or {})},
                    "expected": expected or {},
                }
            ],
            **kwargs,
        }
        cases.append(case)
        return case

    for index, (store, noun, attribute, value, other) in enumerate(
        [
            ("grocery", "coffee", "roast", "dark", "light"),
            ("jewelry", "ring", "metal", "silver", "gold"),
            ("electronics", "charger", "connector", "usb-c", "lightning"),
        ],
        1,
    ):
        tenant = str(UUID(int=index * 1000))
        products = []
        for i, price, stock, fact, source in [
            (1, "20", True, value, "VERIFIED"),
            (2, "30", True, other, "MERCHANT"),
            (3, "10", False, value, "VERIFIED"),
            (4, "25", None, value, "VERIFIED"),
            (5, "15", True, value, "AI_INFERRED"),
        ]:
            pid = str(UUID(int=index * 1000 + i))
            products.append(
                {
                    "id": pid,
                    "name": f"{noun.title()} {i}",
                    "price": price,
                    "currency": "USD",
                    "category_id": str(UUID(int=index * 1000 + 100)),
                    "category_name": noun,
                    "product_type": "simple",
                    "attributes": [
                        {"name": attribute, "value": json.dumps(fact), "source": source}
                    ],
                    "in_stock": stock,
                    "route": "/products/" + pid,
                }
            )
        schema = {
            "industry": store,
            "version": "m02-pattern-1",
            "attributes": [
                {
                    "code": attribute,
                    "label": attribute,
                    "data_type": "select",
                    "options": [
                        {"code": v, "label": v, "labels": {}} for v in (value, other)
                    ],
                    "filterable": True,
                    "searchable": True,
                    "facetable": True,
                    "sortable": False,
                    "comparable": True,
                    "variant_axis": False,
                    "source_policy": "factual",
                    "unit": None,
                    "min": None,
                    "max": None,
                }
            ],
        }
        policies = {
            "schema_version": "2",
            "tenant_id": tenant,
            "answers": [
                {
                    "phrases": ["How do I check my order?"],
                    "answer": "Sign in to view your own order status. A basket proposal is not a placed order.",
                    "source": {
                        "id": "guide:order-status",
                        "title": "Synthetic evaluation guide",
                        "revision": 1,
                        "approved_at": "2026-09-01T00:00:00Z",
                        "valid_until": "2026-10-01T00:00:00Z",
                    },
                }
            ],
            "unknown_phrases": [
                "Do you guarantee delivery today?",
                "Can I return any item after 90 days?",
            ],
        }
        s = {
            "id": store + "-patterns-v1",
            "store": store,
            "tenant_id": tenant,
            "source": "reviewed_synthetic_pattern",
            "source_revision": "m02-curated-patterns-v1",
            "observed_at": "2026-09-21T00:00:00Z",
            "catalog_schema": schema,
            "products": products,
            "policies": policies,
        }
        snapshots.append(s)
        ids = [p["id"] for p in products]
        strict = {
            "shopping": True,
            "query": noun,
            "attributes": [{"name": attribute, "value": value}],
            "in_stock": True,
            "max_price": "30",
            "currency": "USD",
        }
        exp = {
            "ids": [ids[0]],
            "min_results": 1,
            "max_price": "30",
            "currency": "USD",
            "in_stock": True,
            "attributes": {attribute: value},
        }
        add(
            s,
            "verified-hard-constraints",
            f"Find {value} {noun} in stock up to $30",
            strict,
            exp,
        )
        for language, message in [
            ("ar", f"أريد {noun} بسعر أقل من 30 دولار ومتاح الآن"),
            ("ar-eg", f"عايز {noun} أقل من 30 دولار وموجود دلوقتي"),
            ("mixed", f"عايز {noun} in stock under $30"),
            ("typo", f"{noun} in stok undr 30 USD"),
        ]:
            add(
                s,
                language + "-budget",
                message,
                {
                    "shopping": True,
                    "query": noun,
                    "max_price": "30",
                    "exclusive_max": True,
                    "currency": "USD",
                    "in_stock": True,
                },
                {
                    "ids": [ids[4], ids[0]],
                    "min_results": 1,
                    "max_price": "30",
                    "exclusive_max": True,
                    "currency": "USD",
                    "in_stock": True,
                },
                language=language,
                suite="catalog_grounded",
            )
        add(
            s,
            "no-valid-match",
            f"{value} {noun} in stock under $20",
            {**strict, "max_price": "20", "exclusive_max": True},
            {"ids": [], "text_all": ["No verified matches"]},
            suite="catalog_grounded",
        )
        add(
            s,
            "missing-currency",
            f"Find {noun} under 25",
            {"query": noun, "max_price": "25"},
            {"ids": [], "text_all": ["currency"]},
            suite="conversation",
        )
        add(
            s,
            "unknown-requirement",
            f"I need certified allergy-safe {noun}",
            {
                "query": noun,
                "clarification": "Certification is not in the catalog schema",
            },
            {"ids": [], "text_all": ["Please specify"]},
            journey="compatibility",
            suite="journey",
        )
        add(
            s,
            "gift-budget",
            f"A {value} {noun} gift in stock up to $30",
            strict,
            exp,
            journey="gift",
            suite="journey",
        )
        add(
            s,
            "comparison-order",
            f"Compare /products/{ids[1]} /products/{ids[0]}",
            {"presentation": "compare"},
            {"ids": [ids[1], ids[0]], "text_all": ["Current price"]},
            journey="comparison",
            suite="journey",
        )
        add(
            s,
            "ambiguous-comparison",
            "Compare it with the other one",
            {"presentation": "compare"},
            {"ids": [], "text_all": ["two to five product links"]},
            journey="comparison",
            suite="conversation",
        )
        conversation = add(
            s,
            "changed-budget",
            f"Find {noun} in stock up to $30",
            {"query": noun, "in_stock": True, "currency": "USD", "max_price": "30"},
            {"ids": [ids[4], ids[0], ids[1]]},
            suite="conversation",
        )
        conversation["turns"].append(
            {
                "message": "Actually, keep it under $20",
                "model_output": {
                    "shopping": True,
                    "query": noun,
                    "in_stock": True,
                    "max_price": "20",
                    "currency": "USD",
                    "exclusive_max": True,
                },
                "expected": {"ids": [ids[4]], "max_price": "20", "exclusive_max": True},
            }
        )
        add(
            s,
            "cheaper-current-reference",
            f"Cheaper than /products/{ids[1]}",
            {"query": noun, "cheaper": True, "in_stock": True},
            {"ids": [ids[4], ids[0]], "max_price": "30", "exclusive_max": True},
            suite="conversation",
        )
        add(
            s,
            "silent-relaxation-denied",
            f"{value} {noun} in stock under $20, never relax budget",
            {**strict, "alternatives": True, "max_price": "100"},
            {"ids": []},
            suite="adversarial",
        )
        add(
            s,
            "cross-store-reference",
            f"Details /products/{UUID(int=999999)}",
            {"presentation": "detail"},
            {"error": "invalid_reference"},
            suite="adversarial",
        )
        for fault in ("timeout", "rate_limit", "invalid_response", "unauthorized_tool"):
            add(
                s,
                "provider-" + fault.replace("_", "-"),
                "Find " + noun,
                expected={
                    "error": "invalid_shopping_plan"
                    if fault == "unauthorized_tool"
                    else fault
                },
                provider_fault=fault,
                suite="adversarial",
            )
        add(
            s,
            "malformed-tool",
            "Find " + noun,
            expected={"error": "tool_unavailable", "max_calls": 0},
            tool_fault="malformed",
            suite="adversarial",
        )
        add(
            s,
            "unavailable-tool",
            "Find " + noun,
            expected={"error": "tool_unavailable", "max_calls": 0},
            tool_fault="unavailable",
            suite="adversarial",
        )
        for key, message, required, journey in [
            (
                "order-guide",
                "How do I check my order?",
                "your own order",
                "order_status",
            ),
            (
                "unsupported-policy",
                "Do you guarantee delivery today?",
                "do not have an approved answer",
                "policy",
            ),
            (
                "support-policy",
                "Can I return any item after 90 days?",
                "contact the store",
                "support",
            ),
        ]:
            add(
                s,
                key,
                message,
                expected={"text_all": [required], "max_calls": 0},
                kind="policy",
                journey=journey,
                suite="journey",
            )
        cart = [
            {
                "product_id": ids[0],
                "name": noun,
                "unit": "each",
                "quantity": 2,
                "price": "20",
                "currency": "USD",
            }
        ]
        for key, mode, message, goal, expected in [
            (
                "shop",
                "shop",
                f"Find one {noun}",
                {},
                {"text_all": ["live cart has not changed"]},
            ),
            (
                "optimize-quantities",
                "optimize",
                "Find cheaper alternatives, preserve quantities",
                {"allow_substitutions": True, "locked_products": [ids[0]]},
                {"locked_products": [], "unresolved": False},
            ),
            (
                "optimize-existing-lock",
                "optimize",
                "Find cheaper alternatives",
                {"allow_substitutions": True},
                {"locked_products": [ids[0]], "unresolved": False},
            ),
            (
                "buy-again-owned-order",
                "buy_again",
                "Buy my usual order again",
                {},
                {"max_calls": 0, "text_all": ["Choose an order"]},
            ),
        ]:
            output = {"goal": goal}
            if key == "optimize-quantities":
                output["lock_evidence"] = [
                    {"product_id": ids[0], "customer_quote": "preserve quantities"}
                ]
            if mode == "shop":
                output["searches"] = [
                    {
                        "intent": {"shopping": True, "query": noun, "in_stock": True},
                        "quantity": 1,
                    }
                ]
            case = add(
                s,
                key,
                message,
                expected=expected,
                kind="basket",
                journey=mode,
                suite="journey",
                cart_items=cart,
            )
            case["turns"][0]["model_output"] = output
            if key == "optimize-existing-lock":
                case["previous_goal"] = {"locked_products": [ids[0]]}
        add(
            s,
            "meal-uncertainty",
            "A meal for four; must be allergen-free",
            {"query": noun, "clarification": "No verified allergen or serving facts"},
            {"ids": [], "text_all": ["Please specify"]},
            journey="meal",
            suite="journey",
        )

    s = captured.model_dump(mode="json")
    snapshots.append(s)
    cheap, dear = sorted(s["products"], key=lambda p: float(p["price"]))
    for key, language, message in [
        ("live-budget-en", "en", "Find Staging Coffee in stock under $10"),
        (
            "live-budget-ar",
            "ar",
            "عايز Staging Coffee متاحة بسعر أقل من 10 دولار أمريكي",
        ),
        ("live-budget-mixed", "mixed", "عايز Staging Coffee in stock under $10"),
    ]:
        add(
            s,
            key,
            message,
            {
                "query": "Staging Coffee",
                "currency": "USD",
                "max_price": "10",
                "exclusive_max": True,
                "in_stock": True,
            },
            {
                "ids": [cheap["id"]],
                "max_price": "10",
                "exclusive_max": True,
                "currency": "USD",
                "in_stock": True,
                "extracted": {"currency": "USD", "exclusive_max": True},
            },
            language=language,
            suite="catalog_grounded",
            live=True,
        )
    add(
        s,
        "live-comparison",
        f"Compare {dear['route']} and {cheap['route']}",
        {"presentation": "compare"},
        {"ids": [dear["id"], cheap["id"]], "extracted": {"presentation": "compare"}},
        journey="comparison",
        suite="journey",
        live=True,
    )
    add(
        s,
        "live-clarification",
        "Find Staging Coffee under 5",
        {"query": "Staging Coffee", "max_price": "5"},
        {"ids": [], "text_all": ["currency"]},
        suite="conversation",
        live=True,
    )
    add(
        s,
        "live-gift",
        "Recommend a Staging Coffee gift in stock up to $6",
        {
            "query": "Staging Coffee",
            "currency": "USD",
            "max_price": "6",
            "in_stock": True,
        },
        {"ids": [cheap["id"]], "max_price": "6", "currency": "USD", "in_stock": True},
        journey="gift",
        suite="journey",
        live=True,
    )
    # Current policy observations are separate from synthetic guide fixtures.
    for i, guide in enumerate(s["policies"]["answers"]):
        add(
            s,
            f"captured-guide-{i + 1}",
            min(guide["phrases"]),
            expected={"text_all": [guide["answer"], "Source:"], "max_calls": 0},
            kind="policy",
            journey="policy",
            suite="catalog_grounded",
        )
    return Dataset.model_validate(
        {
            "version": "1",
            "revision": "commerce-lab-2026-09-21-v1",
            "snapshots": snapshots,
            "cases": cases,
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    dataset = build(Snapshot.model_validate_json(args.capture.read_bytes()))
    args.output.write_text(dataset.model_dump_json(indent=2) + "\n")
