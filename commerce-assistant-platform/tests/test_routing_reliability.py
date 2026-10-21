"""Packaged Node language reaches real SSE routes without paid extraction or writes."""

import asyncio
import json
import shutil
import subprocess
from dataclasses import replace
from functools import lru_cache
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_catalog_schema import catalog_schema, schema_attribute
from test_order_read_routes import order
from test_shopping import product
from test_shopping_clarification_sse import Questions

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.application import bootstrap
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.providers import UnconfiguredModel
from app.main import create_app
from evals.lab.catalog_oracle import eligible_products, frozen_profile
from evals.lab.models import Expectation, Snapshot

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "commerce-assistant-platform/app/commerce_language_engine"
CORE = frozenset({"commerce_core", "commerce_meaning", "commerce_planning"})
NODE_SCRIPT = """
import {loadRuntime} from './src/runtime.ts';
import {resolve} from './src/engine.ts';
const {text,context}=JSON.parse(process.argv[1]);
console.log(JSON.stringify(resolve(await loadRuntime(),text,context??{})));
"""


@lru_cache(maxsize=64)
def packaged_resolution(text, context_json="{}"):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for packaged language/SSE integration")
    result = subprocess.run(
        [
            node,
            "--input-type=module",
            "-e",
            NODE_SCRIPT,
            json.dumps({"text": text, "context": json.loads(context_json)}),
        ],
        cwd=ENGINE,
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return json.loads(result.stdout)


def frozen_demo(store):
    """Reviewed facts and contradictory offers, independent of parser outputs."""
    definitions = {
        "grocery": (
            [(10, "Fruit"), (11, "Dairy"), (12, "Bakery")],
            [schema_attribute("meal_occasion", "multiselect", ["breakfast", "dinner"])],
            [
                (1, "Gala Apples", "2", 10, {"meal_occasion": ["breakfast"]}),
                (2, "Fresh Milk", "3", 11, {"meal_occasion": ["breakfast"]}),
                (3, "Oat Bread", "4", 12, {"meal_occasion": ["breakfast"]}),
                (4, "Dinner Rolls", "5", 12, {"meal_occasion": ["dinner"]}),
            ],
        ),
        "electronics": (
            [(20, "Phones"), (21, "Tablets")],
            [
                schema_attribute(
                    "brand", options=["Apple", "Other"], semantic_role="brand"
                )
            ],
            [
                (5, "Apple Camera Phone", "300", 20, {"brand": "Apple"}),
                (6, "Everyday Phone", "500", 20, {"brand": "Other"}),
                (7, "Apple Tablet", "400", 21, {"brand": "Apple"}),
            ],
        ),
        "jewelry": (
            [(30, "Rings"), (31, "Necklaces")],
            [
                schema_attribute(
                    "metal",
                    options=["gold", "silver"],
                    label="Material",
                    semantic_role="material",
                )
            ],
            [
                (8, "Classic Gold Ring", "50", 30, {"metal": "gold"}),
                (9, "Classic Silver Ring", "100", 30, {"metal": "silver"}),
                (10, "Gold Necklace", "75", 31, {"metal": "gold"}),
            ],
        ),
        "pharmacy": (
            [(40, "Skin Care")],
            [
                schema_attribute(
                    "care_area", options=["face", "body"], semantic_role="intended_use"
                ),
                schema_attribute("texture", options=["cream", "lotion"]),
                schema_attribute("ingredients", "text"),
            ],
            [
                (
                    11,
                    "Daily Face Cream",
                    "12",
                    40,
                    {
                        "care_area": "face",
                        "texture": "cream",
                        "ingredients": "glycerin",
                    },
                ),
                (
                    12,
                    "Face Lotion",
                    "18",
                    40,
                    {"care_area": "face", "texture": "lotion", "ingredients": "water"},
                ),
                (
                    13,
                    "Body Cream",
                    "9",
                    40,
                    {"care_area": "body", "texture": "cream", "ingredients": "water"},
                ),
            ],
        ),
    }
    categories, attributes, offers = definitions[store]
    names = dict(categories)
    products = [
        Product.model_validate(
            product(
                number,
                name=name,
                price=price,
                category=names[category],
                category_id=str(UUID(int=category)),
                attributes=[
                    {"name": code, "value": json.dumps(value), "source": "MERCHANT"}
                    for code, value in facts.items()
                ],
            )
        )
        for number, name, price, category, facts in offers
    ]
    schema = catalog_schema(store, attributes)
    schema["categories"] = [
        {
            "id": str(UUID(int=category)),
            "name": name,
            "sellable_count": sum(
                p.category_id == UUID(int=category) for p in products
            ),
        }
        for category, name in categories
    ]
    return Snapshot(
        id=f"routing-{store}-reviewed-v1",
        store=store,
        tenant_id=UUID(int=1),
        source="reviewed_synthetic_pattern",
        source_revision="routing-reliability-reviewed-v1",
        observed_at="2026-10-07T00:00:00Z",
        catalog_schema=CatalogSchema.model_validate(schema),
        products=products,
        catalog_complete=True,
    )


def sse_turn(
    identity,
    monkeypatch,
    message,
    snapshot,
    *,
    flags=frozenset(),
    selected=None,
    expected_error=None,
    selected_order=None,
):
    config, request_id, headers = identity
    calls, parsed, paid = [], [], []

    async def resolve(url, text, *, context=None):
        raw = await asyncio.to_thread(
            packaged_resolution, text, json.dumps(context or {}, sort_keys=True)
        )
        parsed.append(raw)
        return gate.Resolution.model_validate(raw)

    async def forbid_model(*args, **kwargs):
        paid.append("generate")
        pytest.fail("Known routing or unsupported request called model extraction")

    async def forbid_stream(*args, **kwargs):
        paid.append("stream")
        pytest.fail("Known routing or unsupported request streamed a model")
        yield  # pragma: no cover

    products = {str(p.id): p.model_dump(mode="json") for p in snapshot.products}

    def commerce(request):
        calls.append({"method": request.method, "path": request.url.path})
        if (
            selected_order is not None
            and request.url.path == f"/v1/assistant-tools/orders/{selected_order['id']}"
        ):
            assert request.method == "GET", "An order read attempted a write"
            assert request.headers["authorization"] == "Bearer order-read"
            return httpx.Response(200, json=selected_order)
        if (
            request.method == "GET"
            and request.url.path == "/v1/assistant-tools/wishlist"
        ):
            assert request.headers["authorization"] == "Bearer wishlist-read"
            return httpx.Response(200, json=[str(snapshot.products[0].id)])
        assert request.method == "POST", "A read request attempted a commerce write"
        assert request.url.path == "/v1/assistant-tools/shopper", (
            "Unexpected commerce action"
        )
        assert request.headers["authorization"] == "Bearer catalog-read"
        body = json.loads(request.content)
        calls[-1].update(body)
        assert body["name"] in {"get_catalog_schema", "search_products", "get_product"}
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "default_currency": "USD",
                    "catalog_schema": snapshot.catalog_schema.model_dump(mode="json"),
                },
            )
        if body["name"] == "get_product":
            found = products.get(body["arguments"]["product_id"])
            selected_products = [found] if found else []
        else:
            selected_products = list(products.values())
        return httpx.Response(
            200,
            json={
                "products": selected_products,
                "category": None,
                **(
                    {"catalog_profile": frozen_profile(snapshot, body["arguments"])}
                    if body["name"] == "search_products"
                    else {}
                ),
            },
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(UnconfiguredModel, "generate", forbid_model)
    monkeypatch.setattr(UnconfiguredModel, "stream", forbid_stream)
    monkeypatch.setattr(bootstrap, "Store", lambda _: Questions())
    with TestClient(
        create_app(
            replace(config, feature_flags=flags, store_password_file="test-only"),
            transport=httpx.MockTransport(commerce),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-catalog-token": "catalog-read",
                "x-commerce-wishlist-token": "wishlist-read",
                **({"x-commerce-tool-token": "order-read"} if selected_order else {}),
            },
            json={
                "request_id": request_id,
                "message": message,
                "conversation_id": str(uuid4()),
                **({"product_id": str(selected.id)} if selected else {}),
                **({"order_id": selected_order["id"]} if selected_order else {}),
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done", events
    errors = [event for event in events if event["type"] == "error"]
    if expected_error is None:
        assert not errors, events
    else:
        assert len(errors) == 1 and errors[0]["code"] == expected_error, events
    assert paid == []
    return events, calls, parsed


def answer_text(events):
    return "".join(event.get("text", "") for event in events)


def presented_ids(events):
    return {
        p["id"]
        for event in events
        for block in event.get("blocks", [])
        for p in block.get("products", [])
    }


@pytest.mark.parametrize("flags", [frozenset(), CORE], ids=["legacy", "core"])
@pytest.mark.parametrize(
    "store,message,scope",
    [
        (
            "grocery",
            "I need good breakfast",
            {
                "predicates": [
                    {
                        "code": "meal_occasion",
                        "operator": "contains",
                        "value": "breakfast",
                    }
                ]
            },
        ),
        ("electronics", "I need good phone", {"category_ids": [str(UUID(int=20))]}),
        ("jewelry", "I need luxury rings", {"category_ids": [str(UUID(int=30))]}),
        (
            "pharmacy",
            "I need something for face",
            {"predicates": [{"code": "care_area", "value": "face"}]},
        ),
    ],
)
def test_four_demo_discovery_remains_grounded(
    identity, monkeypatch, store, message, scope, flags
):
    snapshot = frozen_demo(store)
    events, calls, parsed = sse_turn(
        identity, monkeypatch, message, snapshot, flags=flags
    )
    assert parsed[0]["status"] == "RESOLVED"
    assert parsed[0]["intent"] == "PRODUCT_SEARCH"
    assert calls and calls[0]["name"] == "get_catalog_schema"
    assert any(c["name"] == "search_products" for c in calls)
    assert "couldn’t find" not in answer_text(events).lower()
    expected = {
        str(p.id)
        for p in eligible_products(snapshot, Expectation.model_validate(scope))
    }
    actual = presented_ids(events)
    assert actual <= expected
    if not actual:
        questions = [
            event["clarification"] for event in events if event.get("clarification")
        ]
        assert len(questions) == 1 and questions[0]["kind"] == "shopping"
        assert questions[0]["optional"] is True and questions[0]["choices"]
    assert "guaranteed" not in answer_text(events).lower()


def test_explicit_apple_phone_returns_only_matching_store_offers(identity, monkeypatch):
    snapshot = frozen_demo("electronics")
    events, calls, parsed = sse_turn(
        identity, monkeypatch, "find Apple phones", snapshot
    )
    assert parsed[0]["status"] == "RESOLVED"
    assert parsed[0]["intent"] == "PRODUCT_SEARCH"
    assert presented_ids(events) == {str(snapshot.products[0].id)}
    assert any(c["name"] == "search_products" for c in calls)


@pytest.mark.parametrize("flags", [frozenset(), CORE], ids=["legacy", "core"])
@pytest.mark.parametrize("phrase,exclusive", [("at most", False), ("under", True)])
def test_silver_ring_budget_boundary_preserves_material_and_price(
    identity, monkeypatch, flags, phrase, exclusive
):
    snapshot = frozen_demo("jewelry")
    message = f"find silver rings {phrase} $100"
    events, calls, parsed = sse_turn(
        identity, monkeypatch, message, snapshot, flags=flags
    )
    assert parsed[0]["status"] == "RESOLVED" and parsed[0]["intent"] == "PRODUCT_SEARCH"
    scope = Expectation(
        category_ids=[str(UUID(int=30))],
        predicates=[{"code": "metal", "value": "silver"}],
        max_price="100",
        currency="USD",
        exclusive_max=exclusive,
    )
    expected = {str(p.id) for p in eligible_products(snapshot, scope)}
    assert presented_ids(events) == expected
    budget_queries = [
        call["arguments"]
        for call in calls
        if call.get("name") == "search_products"
        and call["arguments"].get("max_price") == "100"
    ]
    assert budget_queries and all(
        query.get("exclusive_max", False) is exclusive for query in budget_queries
    )
    if exclusive:
        assert not expected and "couldn’t find products matching" in answer_text(events)
    else:
        assert expected == {str(snapshot.products[1].id)}
        assert snapshot.products[1].price == "100"


@pytest.mark.parametrize(
    "message,status",
    [
        ("get me milk", "NEEDS_CONTEXT"),
        ("find apple", "AMBIGUOUS"),
        ("find shoes not red", "NEEDS_CONTEXT"),
        ("How much time can I use it before recharging?", "NEEDS_CONTEXT"),
        ("Do you have a chart to help me pick a size?", "NEEDS_CONTEXT"),
        ("What ingredients does this contain?", "NEEDS_CONTEXT"),
        ("Tell me when these trainers become available again", "UNKNOWN"),
    ],
)
def test_missing_or_unsupported_meaning_cannot_execute_reads(
    identity, monkeypatch, message, status
):
    events, calls, parsed = sse_turn(
        identity, monkeypatch, message, frozen_demo("grocery")
    )
    assert parsed[0]["status"] == status
    assert answer_text(events).strip()
    assert not presented_ids(events)
    assert calls == []


def test_saved_favorites_reads_the_wishlist_instead_of_product_search(
    identity, monkeypatch
):
    snapshot = frozen_demo("grocery")
    events, calls, parsed = sse_turn(
        identity, monkeypatch, "Could you let me see my saved favorites?", snapshot
    )
    assert parsed[0]["intent"] == "VIEW_WISHLIST" and parsed[0]["status"] == "RESOLVED"
    assert presented_ids(events) == {str(snapshot.products[0].id)}
    assert "1 saved item" in answer_text(events)
    assert [(c["method"], c["path"], c.get("name")) for c in calls] == [
        ("GET", "/v1/assistant-tools/wishlist", None),
        ("POST", "/v1/assistant-tools/shopper", "get_product"),
    ]


@pytest.mark.parametrize(
    "message,intent",
    [
        ("Tell me material safety data sheet", "SAFETY_DATA_SHEET"),
        ("Check the price per unit please", "UNIT_PRICE"),
        ("track my refund", "REFUND_STATUS"),
        ("track my refund for order number 123", "REFUND_STATUS"),
    ],
)
def test_understood_reads_keep_existing_handoff_without_fabricating_facts(
    identity, monkeypatch, message, intent
):
    events, calls, parsed = sse_turn(
        identity, monkeypatch, message, frozen_demo("grocery")
    )
    assert parsed[0]["status"] == "RESOLVED" and parsed[0]["intent"] == intent
    assert answer_text(events).strip()
    assert (
        "haven't verified" if intent == "REFUND_STATUS" else "can't verify"
    ) in answer_text(events)
    assert not presented_ids(events) and calls == []


def test_denied_cancellation_then_tracking_only_reads_selected_order(
    identity, monkeypatch
):
    selected = order()
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        "Do not cancel the order; I only want to track it",
        frozen_demo("grocery"),
        selected_order=selected,
    )
    assert parsed[0]["status"] == "RESOLVED" and parsed[0]["intent"] == "TRACK_ORDER"
    assert "Current status: in transit." in answer_text(events)
    assert [
        event["order"]["id"] for event in events if event["type"] == "card.order"
    ] == [selected["id"]]
    assert calls == [
        {"method": "GET", "path": f"/v1/assistant-tools/orders/{selected['id']}"}
    ]


@pytest.mark.parametrize(
    "message,status,operations",
    [
        ("Do not cancel the order; if it is delayed, track it", "NEEDS_CONTEXT", []),
        (
            "Do not cancel the order; I only want to track it if it is late",
            "NEEDS_CONTEXT",
            ["TRACK_ORDER"],
        ),
        (
            "Do not track the order; I only want to cancel it",
            "RESOLVED",
            ["CANCEL_ORDER"],
        ),
        (
            "Do not cancel the order; I only want to track it and cancel it",
            "RESOLVED",
            ["TRACK_ORDER", "CANCEL_ORDER"],
        ),
    ],
)
def test_conditions_or_requested_writes_cannot_borrow_the_single_tracking_route(
    identity, monkeypatch, message, status, operations
):
    events, calls, parsed = sse_turn(
        identity, monkeypatch, message, frozen_demo("grocery"), selected_order=order()
    )
    assert parsed[0]["status"] == status
    assert parsed[0].get("operations", []) == operations
    assert answer_text(events).strip()
    assert not any(event["type"] == "card.order" for event in events)
    assert not presented_ids(events)
    assert calls == []


def test_selected_ingredients_question_reads_only_verified_current_product(
    identity, monkeypatch
):
    snapshot = frozen_demo("pharmacy")
    selected = snapshot.products[0]
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        "What ingredients does this contain?",
        snapshot,
        selected=selected,
    )
    assert (
        parsed[0]["status"] == "RESOLVED"
        and parsed[0]["intent"] == "PRODUCT_INGREDIENTS"
    )
    assert "Ingredients: glycerin" in answer_text(events)
    assert presented_ids(events) == {str(selected.id)}
    assert [call["name"] for call in calls] == ["get_product"]


@pytest.mark.parametrize("missing", ["offer", "verified_fact"])
def test_selected_missing_evidence_cannot_produce_an_ingredients_answer(
    identity, monkeypatch, missing
):
    snapshot = frozen_demo("pharmacy")
    selected = snapshot.products[0]
    if missing == "offer":
        selected = selected.model_copy(update={"id": UUID(int=999)})
    else:
        selected.attributes[-1].source = "AI_INFERRED"
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        "What ingredients does this contain?",
        snapshot,
        selected=selected,
        expected_error="unavailable" if missing == "offer" else None,
    )
    assert (
        parsed[0]["intent"] == "PRODUCT_INGREDIENTS"
        and parsed[0]["status"] == "RESOLVED"
    )
    assert "Ingredients: glycerin" not in answer_text(events)
    assert [call["name"] for call in calls] == ["get_product"]


@pytest.mark.parametrize("flags", [frozenset(), CORE], ids=["legacy", "core"])
@pytest.mark.parametrize("separator", [". ", "! ", "? ", "\n"])
@pytest.mark.parametrize(
    "head,tail",
    [
        (
            "Do not cancel the order; I only want to track it",
            "Cancel it",
        ),
        (
            "Do not track the order; I only want to cancel it",
            "Do not cancel it",
        ),
        (
            "Do not cancel the order; I only want to add apples to cart",
            "Do not add anything",
        ),
    ],
)
def test_later_action_sentences_cannot_borrow_a_single_route(
    identity, monkeypatch, flags, separator, head, tail
):
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        head + separator + tail,
        frozen_demo("grocery"),
        flags=flags,
        selected_order=order(),
    )
    assert parsed[0]["status"] == "NEEDS_CONTEXT"
    assert parsed[0]["intent"] is None
    assert parsed[0]["operations"] == []
    assert parsed[0]["actions"] == []
    assert parsed[0]["intentCountStatus"] == "NEEDS_CLARIFICATION"
    assert "complete request" in answer_text(events)
    assert not any(event["type"] == "card.order" for event in events)
    assert not presented_ids(events)
    assert calls == []


@pytest.mark.parametrize("flags", [frozenset(), CORE], ids=["legacy", "core"])
@pytest.mark.parametrize(
    "message",
    [
        "Do not track the order; I only want to cancel it",
        "Do not cancel the order; I only want to add apples to cart",
    ],
)
def test_mixed_negation_write_requests_retain_compound_guard(
    identity, monkeypatch, flags, message
):
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        message,
        frozen_demo("grocery"),
        flags=flags,
        selected_order=order(),
    )
    assert parsed[0]["requestType"] == "COMPOUND"
    assert parsed[0]["requiresConfirmation"] is True
    assert answer_text(events).strip()
    assert not any(event["type"] == "card.order" for event in events)
    assert not presented_ids(events)
    assert calls == []
