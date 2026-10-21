"""Replay measured failures and prove the opt-in repair preserves hard constraints."""

import asyncio
import importlib
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.execution.language.shopping import refine_query
from app.commerce_resolution_engine.contracts import Message, ModelResponse, Usage
from app.main import create_app
from evals.lab.models import EvaluationScope, Report, load_dataset
from evals.lab.runner import project_scope, run, run_case
from evals.lab.scoring import compare, thresholds_after_baseline

LAB = Path(__file__).parents[1] / "evals/lab"
EMPTY = CatalogSchema(industry=None, version="test", attributes=[])


@pytest.mark.parametrize("case_id", ["grocery-live-budget-en", "grocery-live-gift"])
def test_actual_failed_extractions_are_fixed_only_when_enabled(case_id):
    dataset = load_dataset(LAB / "commerce-v1.json")
    historical = Report.model_validate_json((LAB / "live-baseline.json").read_bytes())
    row = next(r for r in historical.results if r.id == case_id)
    assert row.status == "failed"
    case = next(c for c in dataset.cases if c.id == case_id).model_copy(deep=True)
    case.turns[0].model_output = row.trace[0]["extracted"]
    snapshot = next(s for s in dataset.snapshots if s.id == case.snapshot)
    assert asyncio.run(run_case(case, snapshot)).status == "failed"
    repaired = asyncio.run(run_case(case, snapshot, grounded_intent=True))
    assert repaired.status == "passed", repaired.failures
    assert repaired.provider_calls == 1
    assert repaired.trace[0]["product_ids"] == case.turns[0].expected.ids


def test_name_words_are_retained_in_query_and_verified_on_retrieved_products():
    dataset = load_dataset(LAB / "commerce-v1.json")
    case = next(
        c for c in dataset.cases if c.id == "grocery-live-budget-en"
    ).model_copy(deep=True)
    snapshot = next(s for s in dataset.snapshots if s.id == case.snapshot).model_copy(
        deep=True
    )
    case.turns[0].model_output.update(brand="Staging", query="Coffee")
    # The cheaper retrieved item has the wrong name, despite matching price/stock.
    snapshot.products[0].name = "Unrelated Coffee"
    snapshot.products[0].price = "1.00"
    result = asyncio.run(run_case(case, snapshot, grounded_intent=True))
    assert result.status == "passed", result.failures


@pytest.mark.parametrize(
    "invented_category",
    ["gift set", "gift card", "gift basket", "coffee set", "hamper"],
)
def test_ordinary_coffee_gift_does_not_become_an_unrequested_gift_product(
    invented_category,
):
    dataset = load_dataset(LAB / "commerce-v1.json")
    case = next(c for c in dataset.cases if c.id == "grocery-live-gift").model_copy(
        deep=True
    )
    snapshot = next(s for s in dataset.snapshots if s.id == case.snapshot).model_copy(
        deep=True
    )
    case.turns[0].model_output.update(
        query="Staging Coffee gift", category=invented_category
    )
    assert asyncio.run(run_case(case, snapshot)).status == "failed"
    # Wrong-kind noise must not become eligible when the invented category is removed.
    snapshot.products[0].name = "Unrelated gift set"
    snapshot.products[0].price = "1.00"
    fixed = asyncio.run(run_case(case, snapshot, grounded_intent=True))
    assert fixed.status == "passed", fixed.failures


@pytest.mark.parametrize(
    "message",
    [
        "Only Acme coffee",
        "Acme brand coffee",
        "Coffee made by Acme",
        "Coffee from Acme",
    ],
)
def test_explicit_brand_is_never_dropped_without_catalog_support(message):
    plan = ShoppingIntent(shopping=True, query="coffee", brand="Acme")
    assert refine_query(plan, message, EMPTY, ()) == []
    assert plan.brand == "Acme"


def test_customer_history_preserves_brand_but_untrusted_assistant_text_cannot_create_it():
    for role, expected in [("user", "Acme"), ("assistant", None)]:
        plan = ShoppingIntent(shopping=True, query="coffee", brand="Acme")
        refine_query(
            plan,
            "Find another coffee",
            EMPTY,
            (Message(role, "Only Acme brand coffee"),),
        )
        assert plan.brand == expected


def test_schema_backed_brand_remains_hard_even_without_brand_keyword():
    from test_catalog_schema import schema_attribute

    schema = CatalogSchema.model_validate(
        {
            **EMPTY.model_dump(),
            "attributes": [
                schema_attribute("maker", "select", ["Acme"], semantic_role="brand")
            ],
        }
    )
    plan = ShoppingIntent(shopping=True, query="Acme coffee", brand="Acme")
    refine_query(plan, "Acme coffee", schema, ())
    assert plan.brand == "Acme"


@pytest.mark.parametrize(
    "gift_type",
    [
        "gift card",
        "gift basket",
        "gift box",
        "gift set",
        "gift wrapping",
        "gift bag",
        "gift certificate",
        "gift voucher",
        "gift hamper",
        "gift kit",
        "gift pack",
    ],
)
def test_specific_gift_products_are_not_relaxed(gift_type):
    plan = ShoppingIntent(
        shopping=True,
        query=gift_type,
        category=gift_type,
        max_price="6",
        currency="USD",
        in_stock=True,
    )
    before = plan.model_dump()
    refine_query(plan, f"Find a {gift_type} up to $6", EMPTY, ())
    assert plan.model_dump() == before


def test_gifting_cleanup_preserves_other_constraints_and_managed_classification():
    from test_catalog_schema import schema_attribute

    plan = ShoppingIntent(
        shopping=True,
        query="silver necklace gift",
        category="necklace gift",
        attributes=[{"name": "metal", "value": "silver"}],
        max_price="100",
        currency="USD",
        in_stock=True,
    )
    refine_query(plan, "A silver necklace gift under $100", EMPTY, ())
    assert plan.query == "silver necklace" and plan.category == "necklace"
    assert (
        plan.attributes[0].value == "silver"
        and plan.max_price == "100"
        and plan.in_stock
    )
    schema = CatalogSchema.model_validate(
        {
            **EMPTY.model_dump(),
            "attributes": [
                schema_attribute(
                    "kind", options=["coffee gift"], semantic_role="classification"
                )
            ],
        }
    )
    plan = ShoppingIntent(shopping=True, query="coffee gift", category="coffee gift")
    refine_query(plan, "A coffee gift", schema, ())
    assert plan.category == "coffee gift" and plan.query == "coffee gift"


def test_arabic_and_mixed_requests_are_unchanged_by_english_repair():
    for message in ("عايز قهوة", "عايز Staging Coffee gift"):
        plan = ShoppingIntent(
            shopping=True, query="Coffee gift", category="coffee gift", brand="Staging"
        )
        before = plan.model_dump()
        assert refine_query(plan, message, EMPTY, ()) == []
        assert plan.model_dump() == before


def test_english_scope_is_explicit_and_cannot_hide_missing_english_evidence():
    scope = EvaluationScope.model_validate_json(
        (LAB / "m02-english-scope.json").read_bytes()
    )
    original = Report.model_validate_json((LAB / "live-baseline.json").read_bytes())
    projected = project_scope(original, scope)
    assert len(projected.results) == 4 and len(projected.excluded_cases) == 2
    assert (
        projected.status == "failed"
    )  # Both English defects still block the old baseline.
    assert {r.id for r in projected.results if r.status == "failed"} == {
        "grocery-live-budget-en",
        "grocery-live-gift",
    }
    assert projected.budget is None
    with pytest.raises(ValueError, match="scope"):
        compare(original, projected)
    candidate = projected.model_copy(deep=True)
    candidate.excluded_cases = {}
    with pytest.raises(ValueError, match="scope"):
        compare(projected, candidate)
    offline = asyncio.run(
        run(load_dataset(LAB / "commerce-v1.json"), scope=scope, grounded_intent=True)
    )
    assert (
        offline.status == "passed"
        and len(offline.results) == 88
        and len(offline.excluded_cases) == 11
    )
    baseline = project_scope(
        Report.model_validate_json((LAB / "baseline.json").read_bytes()), scope
    )
    assert (
        compare(baseline, offline, thresholds_after_baseline(baseline))["status"]
        == "passed"
    )
    assert original.model_dump(mode="json") == json.loads(
        (LAB / "live-baseline.json").read_text()
    ) | {
        "runtime_features": [],
        "scope_id": "all-languages",
        "scope_sha256": None,
        "scope_reason": None,
        "excluded_cases": {},
    }


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("case_id", ["grocery-live-budget-en", "grocery-live-gift"])
def test_legacy_shopping_plan_cannot_bypass_language_revalidation(
    enabled, case_id, identity, monkeypatch
):
    config, request_id, headers = identity
    config = replace(
        config, feature_flags=frozenset({"grounded_intent"}) if enabled else frozenset()
    )
    dataset = load_dataset(LAB / "commerce-v1.json")
    case = next(c for c in dataset.cases if c.id == case_id)
    old = Report.model_validate_json((LAB / "live-baseline.json").read_bytes())
    plan = next(r for r in old.results if r.id == case_id).trace[0]["extracted"]
    requests = []

    class Provider:
        async def generate(self, request):
            requests.append(request)
            return ModelResponse(
                "",
                (),
                ShoppingIntent.model_validate(plan),
                Usage(100, 30, 130),
                "recorded-failure",
                "stop",
            )

        async def aclose(self):
            pass

    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: Provider(),
    )

    def commerce(request):
        pytest.fail("A raw shopping plan must not bypass language revalidation")

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog"},
            json={"request_id": request_id, "message": case.turns[0].message},
        )
    assert response.status_code == 200 and len(requests) == 1
    from app.commerce_contracts.language_proposal import LanguageProposal

    assert case.turns[0].expected.ids[0] not in response.text
    assert "Please restate the full request" in response.text
    assert requests[0].output_schema is LanguageProposal
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done" and not any(
        e["type"] == "error" for e in events
    )
