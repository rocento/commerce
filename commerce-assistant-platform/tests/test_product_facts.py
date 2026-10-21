"""Product answers require exact identities and current, explicit catalog facts."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from test_shopping import product

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.product_facts import (
    catalog_fact,
    factual_product,
)
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application.handlers.product_facts import (
    product_fact_events,
)
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


def interpreted(intent="PRODUCT_MATERIAL", **changes):
    return InterpretedRequest.model_validate(
        {
            "request_id": str(UUID(int=1)),
            "status": "RESOLVED",
            "legacy_intent": intent,
            "message": "",
            "confidence": {"raw": 1.0},
            "entities": {"productText": "Classic Gold Ring"},
            **changes,
        }
    )


def ring(**changes):
    return product(
        name="Classic Gold Ring",
        sku="RING-18K",
        price="120",
        category="Rings",
        attributes=[
            {"name": "metal", "value": '"gold"', "source": "MERCHANT"},
            {"name": "metal_purity", "value": '"18k"', "source": "VERIFIED"},
            {"name": "gemstone", "value": '"ruby"', "source": "IMPORTED"},
        ],
        **changes,
    )


class Reader:
    def __init__(self, current=None, candidates=None):
        self.current = current or ring()
        self.candidates = candidates if candidates is not None else [self.current]
        self.calls = []

    async def search_cart_product(self, query):
        self.calls.append(("search", query))
        return self.candidates

    async def product(self, product_id):
        self.calls.append(("product", product_id))
        return self.current


async def collect(reader, request=None, *, product_id=None):
    metadata = {}
    count = 0

    def make_event(kind, **fields):
        nonlocal count
        count += 1
        return AssistantEvent(
            version="1", request_id=UUID(int=1), sequence=count, type=kind, **fields
        )

    events = [
        event
        async for event in product_fact_events(
            reader,
            request or interpreted(),
            make_event,
            metadata,
            product_id=product_id,
        )
    ]
    return events, metadata


def text(events):
    return " ".join(event.text for event in events if event.text)


def test_quantity_price_uses_current_exact_product_price_without_checkout():
    reader = Reader(current={**ring(), "price": "19.95"})
    request = interpreted(
        "CHECK_PRICE", entities={"productText": "Classic Gold Ring", "quantity": 3}
    )
    events, _ = asyncio.run(collect(reader, request))
    assert "59.85 USD" in text(events)
    assert "before tax" in text(events)
    assert [call[0] for call in reader.calls] == ["search", "product"]


@pytest.mark.parametrize("quantity", [True, 0, -1, 1.5, "3", 100000])
def test_quantity_price_rejects_invalid_quantity_before_reading(quantity):
    reader = Reader()
    request = interpreted(
        "CHECK_PRICE",
        entities={"productText": "Classic Gold Ring", "quantity": quantity},
    )
    events, _ = asyncio.run(collect(reader, request))
    assert "Please ask one product question" in text(events)
    assert not reader.calls


@pytest.mark.parametrize(
    "intent,expected",
    [
        ("CHECK_PRICE", "120 USD"),
        ("CHECK_STOCK", "in stock"),
        ("PRODUCT_MATERIAL", "Material: gold"),
        ("PRODUCT_METAL_PURITY", "Metal purity: 18k"),
        ("PRODUCT_GEMSTONE", "Gemstone: ruby"),
        ("PRODUCT_DETAILS", "current catalog details published"),
    ],
)
def test_exact_name_refreshes_before_answering(intent, expected):
    reader = Reader()
    events, metadata = asyncio.run(collect(reader, interpreted(intent)))
    assert expected in text(events)
    assert reader.calls == [
        ("search", "Classic Gold Ring"),
        ("product", UUID(reader.current["id"])),
    ]
    assert metadata["completion_evidence"] == "read_result"
    assert metadata["product_fact_status"] == "answered"
    assert metadata["tool_calls"] == 2
    block = next(event.blocks[0] for event in events if event.blocks)
    assert block.sources[0].product_id == UUID(reader.current["id"])


def test_sku_and_selected_current_reference_use_exact_identity():
    reader = Reader()
    _, metadata = asyncio.run(
        collect(reader, interpreted(entities={"productText": "ring-18k"}))
    )
    assert metadata["product_fact_status"] == "answered"
    selected = Reader()
    events, _ = asyncio.run(
        collect(
            selected,
            interpreted(entities={"product_reference": "CURRENT"}),
            product_id=UUID(selected.current["id"]),
        )
    )
    assert "Material: gold" in text(events)
    assert selected.calls == [("product", UUID(selected.current["id"]))]


@pytest.mark.parametrize(
    "in_stock,expected,status",
    [
        (True, "in stock", "answered"),
        (False, "out of stock", "answered"),
        (None, "not confirmed", "missing"),
    ],
)
def test_unknown_availability_never_becomes_stock(in_stock, expected, status):
    reader = Reader(current=ring(in_stock=in_stock))
    events, metadata = asyncio.run(collect(reader, interpreted("CHECK_STOCK")))
    assert expected in text(events)
    assert metadata["product_fact_status"] == status
    assert ("completion_evidence" in metadata) == (status == "answered")


@pytest.mark.parametrize(
    "value,source",
    [
        ("18k", "AI_INFERRED"),
        ("18k", "DERIVED"),
        ("null", "MERCHANT"),
        ('{"guess":"18k"}', "MERCHANT"),
        ("unknown", "VERIFIED"),
        ("NaN", "MERCHANT"),
    ],
)
def test_unverified_or_malformed_requested_fact_is_unavailable(value, source):
    data = ring()
    data["attributes"] = [{"name": "metal_purity", "value": value, "source": source}]
    events, metadata = asyncio.run(
        collect(Reader(data), interpreted("PRODUCT_METAL_PURITY"))
    )
    assert "don't have a confirmed published metal purity" in text(events)
    assert metadata["product_fact_status"] == "missing"
    assert "completion_evidence" not in metadata
    assert (
        not next(event.blocks[0] for event in events if event.blocks)
        .products[0]
        .attributes
    )


def test_material_is_not_inferred_from_product_name_and_conflicts_do_not_pick_first():
    data = ring()
    data["attributes"] = []
    events, metadata = asyncio.run(collect(Reader(data)))
    assert "don't have a confirmed published material" in text(events)
    assert "completion_evidence" not in metadata
    data["attributes"] = [
        {"name": "material", "value": "gold"},
        {"name": "metal", "value": "silver"},
    ]
    events, metadata = asyncio.run(collect(Reader(data)))
    assert "values for Classic Gold Ring conflict" in text(events)
    assert metadata["product_fact_status"] == "missing"


def test_details_card_omits_conflicting_and_inferred_attributes():
    data = ring()
    data["attributes"] += [
        {"name": "purity", "value": "24k", "source": "AI_INFERRED"},
        {"name": "gemstone", "value": "diamond", "source": "VERIFIED"},
    ]
    current = factual_product(Product.model_validate(data))
    assert {attr.name for attr in current.attributes} == {"metal", "metal_purity"}


@pytest.mark.parametrize(
    "candidates",
    [
        [],
        [product(name="Classic Gold Ring Small")],
        [ring(), {**ring(), "id": str(UUID(int=99)), "sku": "RING-OTHER"}],
    ],
)
def test_non_exact_or_ambiguous_reference_requires_selection(candidates):
    reader = Reader(candidates=candidates)
    events, metadata = asyncio.run(collect(reader))
    assert metadata["product_fact_status"] == "selection_required"
    assert "completion_evidence" not in metadata
    assert reader.calls == [("search", "Classic Gold Ring")]
    assert "Material:" not in text(events)


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "UNKNOWN"},
        {"status": "DENIED"},
        {"status": "UNSUPPORTED"},
        {"status": "NEEDS_CONTEXT"},
        {"confidence": {"raw": 0.4}},
        {"missing": ["productReference"]},
        {"request_type": "COMPOUND"},
        {"operations": ["CHECK_PRICE", "ADD_TO_CART"]},
        {"requires_confirmation": True},
        {"entities": {"productText": "Classic Gold Ring", "quantity": 2}},
        {"entities": {"product_reference": {"id": str(UUID(int=55))}}},
        {"entities": {"productText": "Classic Gold Ring", "requestConstraints": []}},
    ],
)
def test_unadmitted_semantics_cannot_read_catalog(changes):
    reader = Reader()
    events, metadata = asyncio.run(collect(reader, interpreted(**changes)))
    assert not reader.calls
    assert metadata["product_fact_status"] == "selection_required"
    assert "completion_evidence" not in metadata
    assert "Please ask one product question" in text(events)


def test_missing_reference_and_conflicting_ui_selection_do_not_guess():
    reader = Reader()
    events, _ = asyncio.run(collect(reader, interpreted(entities={})))
    assert "Which product" in text(events) and not reader.calls
    events, metadata = asyncio.run(
        collect(
            reader,
            interpreted(entities={"productText": "Other ring"}),
            product_id=UUID(reader.current["id"]),
        )
    )
    assert "does not match" in text(events)
    assert "completion_evidence" not in metadata


def test_wrong_identity_from_scoped_read_is_rejected():
    reader = Reader()
    with pytest.raises(ToolUnavailable):
        asyncio.run(collect(reader, product_id=UUID(int=88)))


def test_changed_product_after_search_is_rejected():
    reader = Reader(current={**ring(), "name": "Other product"}, candidates=[ring()])
    with pytest.raises(ToolUnavailable):
        asyncio.run(collect(reader))


def test_named_descriptors_are_identity_hints_never_attribute_evidence():
    reader = Reader()
    events, metadata = asyncio.run(
        collect(
            reader,
            interpreted(
                entities={
                    "productText": "Classic Gold Ring",
                    "category": "ring",
                    "material": "gold",
                }
            ),
        )
    )
    assert metadata["product_fact_status"] == "answered"
    events, metadata = asyncio.run(
        collect(
            reader,
            interpreted(
                entities={"productText": "Classic Gold Ring", "material": "silver"}
            ),
        )
    )
    assert metadata["product_fact_status"] == "selection_required"
    assert "Material:" not in text(events)


def test_parent_product_requires_variant_selection():
    reader = Reader(current=ring(product_type="variable"))
    events, metadata = asyncio.run(collect(reader, interpreted("CHECK_PRICE")))
    assert "specific variant" in text(events)
    assert metadata["product_fact_status"] == "selection_required"


def test_allergens_only_reports_published_statement_not_personal_safety():
    data = ring()
    data["attributes"] = [
        {"name": "allergens", "value": '["milk", "nuts"]', "source": "VERIFIED"}
    ]
    events, metadata = asyncio.run(
        collect(Reader(data), interpreted("PRODUCT_ALLERGENS"))
    )
    assert "milk, nuts" in text(events)
    assert "does not confirm personal allergy safety" in text(events)
    assert metadata["product_fact_status"] == "answered"


@pytest.mark.parametrize(
    "intent,attribute,value",
    [
        ("PRODUCT_ORIGIN", "country_of_origin", "Egypt"),
        ("PRODUCT_INGREDIENTS", "ingredients", "oats, water"),
        ("PRODUCT_STORAGE", "storage_conditions", "Keep refrigerated"),
        ("PRODUCT_NET_WEIGHT", "net_weight", "500 g"),
        ("PRODUCT_DIMENSIONS", "dimensions", "10 x 20 cm"),
        ("PRODUCT_CERTIFICATION", "certification", "Published certificate 123"),
        ("PRODUCT_WARRANTY", "warranty", "One year"),
    ],
)
def test_fact_mapping_uses_explicit_catalog_fields(intent, attribute, value):
    data = ring()
    data["attributes"] = [{"name": attribute, "value": value, "source": "MERCHANT"}]
    fact = catalog_fact(Product.model_validate(data), intent)
    assert fact.status == "known" and fact.value == value


@pytest.mark.parametrize("http_status", [200, 403])
def test_catalog_read_preserves_scoped_capability_and_never_falls_back_on_denial(
    http_status,
):
    calls = []

    def transport(request):
        calls.append(request)
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer tenant-a-catalog"
        assert request.headers["x-delivery-latitude"] == "30"
        assert json.loads(request.content) == {
            "name": "get_product",
            "arguments": {"product_id": ring()["id"]},
        }
        return httpx.Response(
            http_status, json={"products": [ring()], "category": None}
        )

    async def scenario():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(transport)
        ) as client:
            reader = CommerceTools(
                client,
                "",
                catalog_capability="tenant-a-catalog",
                delivery_headers={"x-delivery-latitude": "30"},
            )
            return await collect(reader, product_id=UUID(ring()["id"]))

    if http_status == 403:
        with pytest.raises(ToolDenied):
            asyncio.run(scenario())
    else:
        _, metadata = asyncio.run(scenario())
        assert metadata["completion_evidence"] == "read_result"
    assert len(calls) == 1


@pytest.mark.parametrize(
    "raw,calibrated,allowed", [(0.649, 1.0, False), (0.65, 0.0, True)]
)
def test_raw_confidence_threshold_is_preserved(raw, calibrated, allowed):
    reader = Reader()
    _, metadata = asyncio.run(
        collect(reader, interpreted(confidence={"raw": raw, "calibrated": calibrated}))
    )
    assert bool(reader.calls) == allowed
    assert (metadata["product_fact_status"] == "answered") == allowed
