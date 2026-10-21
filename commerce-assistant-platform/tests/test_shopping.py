"""M05 deterministic scenarios using the real scoped tool transport and runtime."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from test_catalog_schema import catalog_schema, schema_attribute

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import (
    AgentCatalog,
    Principal,
    default_agents,
)
from app.commerce_resolution_engine.contracts import ModelResponse, Usage
from app.commerce_resolution_engine.runtime import AgentRuntime, RuntimeErrorCode

TENANT = UUID(int=1)
WHO = Principal(tenant=TENANT, persona="shopper")


@pytest.mark.parametrize("attribute_count,allowed", [(50, True), (100, False)])
def test_store_schema_uses_bounded_context_budget(attribute_count, allowed):
    schema = catalog_schema(
        "electronics",
        [
            schema_attribute(f"feature_{i}", options=["standard", "premium"])
            for i in range(attribute_count)
        ],
    )
    from app.commerce_action_engine.actions.catalog import CatalogResult

    size = len(
        CatalogResult(
            products=[], category=None, catalog_schema=schema
        ).model_dump_json()
    )
    assert size > 16000
    run = scenario(
        "Recommend a product", {}, [product()], catalog_schema_override=schema
    )
    if allowed:
        assert size < 28000
        answer, requests = asyncio.run(run)
        assert requests and "Running shoes" in answer.text
    else:
        assert size > 32000
        with pytest.raises(RuntimeErrorCode, match="tool_result_limit"):
            asyncio.run(run)


def product(number=1, name="Running shoes", price="99", category="Shoes", **fields):
    data = {
        "id": str(UUID(int=number + 10)),
        "name": name,
        "price": price,
        "currency": "USD",
        "category_id": str(UUID(int=2)),
        "category_name": category,
        "product_type": "simple",
        "attributes": [
            {"name": "color", "value": '"black"'},
            {"name": "size", "value": "42"},
        ],
        "in_stock": True,
        "route": f"/products/{UUID(int=number + 10)}",
    }
    return {**data, **fields}


class Provider:
    def __init__(self, plan):
        self.plan = ShoppingIntent(**{"shopping": True, "query": "shoes", **plan})
        self.requests = []

    async def generate(self, request):
        self.requests.append(request)
        assert request.output_schema is ShoppingIntent
        assert not request.tools
        return ModelResponse(
            "DO NOT DISPLAY MODEL PROSE",
            (),
            self.plan,
            Usage(1, 1, 2),
            "fixture",
            "stop",
        )


def interpreted(source):
    from app.commerce_action_engine.contracts.interpretation import (
        InterpretationFailure,
        InterpretedRequest,
    )

    if isinstance(source, (InterpretedRequest, InterpretationFailure)):
        return source
    if source is None:
        return None
    from test_enterprise_contracts import context as test_context

    from app.commerce_action_engine.application.interpretation import (
        interpret_resolution,
    )

    return interpret_resolution(source, test_context.__wrapped__()).result


async def scenario(
    message,
    plan,
    products,
    reference=None,
    alter_agent=None,
    status=200,
    search_products=None,
    catalog_schema_override=None,
    default_currency=None,
    commerce_meaning=False,
    commerce_planning=False,
    interpretation=None,
    shopping_resume=None,
    shopping_resume_revision=None,
    shopping_resume_question=None,
):
    from functools import partial

    from app.commerce_action_engine.application.interpretation import (
        reasoning_fallback_message,
    )

    provider = Provider(plan)
    requests = []

    def handler(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-token"
        assert request.headers["x-delivery-latitude"] == "30"
        body = json.loads(request.content)
        if body["name"] == "get_catalog_schema":
            schema = catalog_schema(
                "general",
                [
                    schema_attribute(
                        "color",
                        options=[
                            "black",
                            "white",
                            "red",
                            "blue",
                            "green",
                            "yellow",
                            "brown",
                            "pink",
                            "purple",
                            "orange",
                            "grey",
                            "gray",
                        ],
                    ),
                    schema_attribute("size", "integer"),
                    schema_attribute("camera_quality", "text"),
                    schema_attribute("brand", "text"),
                    schema_attribute("intended_use", "text"),
                    schema_attribute(
                        "product-kind",
                        options=["fruit", "vegetable"],
                        semantic_role="classification",
                    ),
                ],
            )
            return httpx.Response(
                status,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": catalog_schema_override or schema,
                    "default_currency": default_currency,
                },
            )
        requests.append(body)
        return httpx.Response(
            status,
            json={
                "products": [reference]
                if body["name"] == "get_product"
                else (
                    search_products(body["arguments"]) if search_products else products
                ),
                "category": None,
            },
        )

    agent = default_agents(TENANT).load(TENANT, "shopper")
    if alter_agent:
        agent = alter_agent(agent)
    async with httpx.AsyncClient(
        base_url="http://assistant-tools:8081", transport=httpx.MockTransport(handler)
    ) as client:
        runtime = AgentRuntime(
            AgentCatalog((agent,)),
            {"default": provider},
            registry(client, "catalog-token", WHO, {"x-delivery-latitude": "30"}),
            shopping=True,
            commerce_meaning=commerce_meaning,
            commerce_planning=commerce_planning,
            shopping_handler=partial(
                shopping_answer,
                interpretation=interpretation,
                shopping_resume=shopping_resume,
                shopping_resume_revision=shopping_resume_revision,
                shopping_resume_question=shopping_resume_question,
            ),
        )
        events = [
            event
            async for event in runtime.stream(
                agent_id="shopper",
                principal=WHO,
                message=message,
                fallback_message=reasoning_fallback_message(interpretation),
            )
        ]
    answer = events[-1].answer
    assert "DO NOT DISPLAY" not in answer.text
    return answer, requests


@pytest.mark.parametrize(
    "message,plan,good,bad",
    [
        (
            "running shoes under $120",
            {"category": "shoe", "max_price": "999", "currency": "USD"},
            product(),
            product(2, price="120"),
        ),
        (
            "phone under $700 with strong camera",
            {
                "category": "phone",
                "attributes": [{"name": "camera_quality", "value": "strong"}],
            },
            product(
                name="Camera phone",
                category="Phones",
                price="650",
                attributes=[{"name": "camera_quality", "value": '"strong"'}],
            ),
            product(
                2, name="Basic phone", category="Phones", price="600", attributes=[]
            ),
        ),
        (
            "black shoes size 42",
            {"category": "shoe"},
            product(),
            product(
                2,
                attributes=[
                    {"name": "color", "value": '"black"'},
                    {"name": "size", "value": "41"},
                ],
            ),
        ),
        (
            "laptop mainly for Python",
            {"category": "laptop", "intended_use": "Python"},
            product(
                name="Dev laptop",
                category="Laptops",
                attributes=[{"name": "intended_use", "value": '["Python", "writing"]'}],
            ),
            product(2, name="Mouse", category="Accessories"),
        ),
        (
            "gift under $50",
            {},
            product(name="Gift mug", price="25"),
            product(2, price="60"),
        ),
    ],
)
def test_requested_scenarios(message, plan, good, bad):
    answer, requests = asyncio.run(scenario(message, plan, [bad, good]))
    assert good["route"] in answer.text
    assert bad["route"] not in answer.text
    assert f"{good['price']} USD" in answer.text
    assert answer.tool_calls == 2 and requests[0]["name"] == "search_products"
    assert "Prices shown are current catalog prices" in answer.text


def test_similar_cheaper_reads_reference_and_uses_live_price_category_currency():
    reference = product(9, price="80")
    good = product(price="79")
    bad = product(2, price="80")
    answer, requests = asyncio.run(
        scenario(
            f"similar but cheaper than {reference['route']}",
            {"cheaper": True},
            [reference, bad, good],
            reference,
            default_currency="EGP",
        )
    )
    assert [r["name"] for r in requests] == ["get_product", "search_products"]
    assert requests[1]["arguments"]["max_price"] == "80"
    assert requests[1]["arguments"]["category_id"] == reference["category_id"]
    assert good["route"] in answer.text and bad["route"] not in answer.text
    assert reference["route"] not in answer.text


@pytest.mark.parametrize(
    "message,plan,expected",
    [
        ("similar but cheaper", {"cheaper": True}, "paste one product link"),
        ("gift under 50", {"max_price": "50"}, "Which currency"),
        ("shoes size 41 or size 42", {}, "clarify the required attribute"),
        ("under $50 and below €40", {}, "one currency"),
    ],
)
def test_clarification_does_not_call_commerce(message, plan, expected):
    answer, requests = asyncio.run(scenario(message, plan, [product()]))
    assert expected in answer.text and not requests


@pytest.mark.parametrize("commerce_planning", [False, True])
def test_empty_search_explains_currency_mismatch_without_converting_budget(
    commerce_planning, monkeypatch
):
    from app.commerce_action_engine.application.shopping_flow.presentation import (
        ShoppingResponder,
    )
    from app.commerce_action_engine.execution.language.gate import Resolution
    from app.commerce_action_engine.execution.language.shopping_reply import (
        resolve_shopping_reply,
    )

    pending = []
    build = ShoppingResponder.build

    def capture(self, *args, **kwargs):
        if kwargs.get("pending_shopping"):
            pending.append(kwargs["pending_shopping"])
        return build(self, *args, **kwargs)

    monkeypatch.setattr(ShoppingResponder, "build", capture)

    answer, calls = asyncio.run(
        scenario(
            "Find shoes under 200 EGP",
            {"query": "shoes", "currency": "EGP", "max_price": "200"},
            [],
            default_currency="USD",
            commerce_planning=commerce_planning,
            interpretation=interpreted(
                Resolution(
                    status="RESOLVED",
                    intent="PRODUCT_SEARCH",
                    confidence=1.0,
                    message="",
                    entities={
                        "productText": "shoes",
                        "currency": "EGP",
                        "price": {"operator": "<=", "value": 200},
                    },
                )
            ),
        )
    )
    assert "Your budget is in EGP" in answer.text
    assert "default currency is USD" in answer.text
    assert "haven’t converted your budget" in answer.text
    assert "What budget would you like to use in USD?" in answer.text
    assert answer.blocks[0].text == answer.text
    filtered = [c["arguments"] for c in calls if c["arguments"].get("max_price")]
    assert filtered and all(
        c["currency"] == "EGP" and c["max_price"] == "200" for c in filtered
    )
    assert len(pending) == 1 and pending[0].field == "currency_budget"
    resumed = resolve_shopping_reply(pending[0], "10").frame
    assert (
        resumed is not None and resumed.currency == "USD" and resumed.max_price == "10"
    )
    assert resumed.exclusive_max
    good = product(price="9", currency="USD")
    followup, searches = asyncio.run(
        scenario(
            "Find shoes under 200 EGP",
            {},
            [good, product(2, price="10", currency="USD")],
            default_currency="USD",
            commerce_planning=commerce_planning,
            shopping_resume=resumed,
            shopping_resume_revision=pending[0].descriptor_revision,
            shopping_resume_question=pending[0],
        )
    )
    assert [p.id for p in followup.blocks[0].products] == [UUID(good["id"])]
    assert searches[-1]["arguments"]["currency"] == "USD"
    assert searches[-1]["arguments"]["max_price"] == "10"


@pytest.mark.parametrize("default_currency", [None, "EGP"])
def test_empty_search_does_not_invent_a_currency_mismatch(default_currency):
    answer, _ = asyncio.run(
        scenario(
            "Find shoes under 200 EGP",
            {"query": "shoes"},
            [],
            default_currency=default_currency,
        )
    )
    assert "default currency" not in answer.text
    assert "I couldn’t find products matching" in answer.text


def test_matching_nondefault_currency_products_are_still_returned():
    good = product(price="99", currency="EGP")
    answer, _ = asyncio.run(
        scenario(
            "Find shoes under 200 EGP",
            {"query": "shoes"},
            [good],
            default_currency="USD",
        )
    )
    assert "default currency" not in answer.text
    assert [p.id for p in answer.blocks[0].products] == [UUID(good["id"])]


@pytest.mark.parametrize("currency", ["USD", "EGP"])
@pytest.mark.parametrize("grounded", [False, True])
@pytest.mark.parametrize("direction,good_price", [("below", "34"), ("above", "36")])
def test_store_currency_defaults_preserve_strict_price_bounds(
    currency, grounded, direction, good_price
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    message = f"show shoes {direction} 35"
    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={
                "productText": "shoes",
                "price": {
                    "operator": "<=" if direction == "below" else ">=",
                    "value": 35,
                },
            },
        )
        if grounded
        else None
    )
    good = product(1, price=good_price, currency=currency)
    answer, calls = asyncio.run(
        scenario(
            message,
            {},
            [
                good,
                product(2, price="35", currency=currency),
                product(3, price=good_price, currency="EUR"),
            ],
            default_currency=currency,
            interpretation=interpretation,
        )
    )
    assert "Which currency" not in answer.text
    assert [p.id for p in answer.blocks[0].products] == [UUID(good["id"])]
    assert (
        calls[0]["arguments"]["max_price" if direction == "below" else "min_price"]
        == "35"
    )


def test_explicit_currency_overrides_store_default():
    good = product(1, price="34", currency="USD")
    answer, _ = asyncio.run(
        scenario(
            "show shoes below USD 35",
            {},
            [good, product(2, price="34", currency="EGP")],
            default_currency="EGP",
        )
    )
    assert [p.id for p in answer.blocks[0].products] == [UUID(good["id"])]


def test_resolved_budget_still_clarifies_without_authoritative_currency():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={"productText": "shoes", "price": {"operator": "<", "value": 35}},
        )
    )
    answer, calls = asyncio.run(
        scenario(
            "show shoes below 35",
            {},
            [product(price="20")],
            interpretation=interpretation,
        )
    )
    assert "Which currency" in answer.text and (not calls)


@pytest.mark.parametrize(
    "changes",
    [
        {"currency": "EUR"},
        {"in_stock": None},
        {"in_stock": False},
        {"product_type": "configurable"},
        {"attributes": []},
        {
            "attributes": [
                {"name": "size", "value": "42"},
                {"name": "color", "value": '"white"'},
            ]
        },
    ],
)
def test_unknown_or_mismatched_facts_never_pass_hard_constraints(changes):
    bad = product(**changes)
    answer, _ = asyncio.run(
        scenario("black shoes size 42 in stock under $120", {}, [bad])
    )
    assert (
        "I couldn’t find products matching your request in this store." in answer.text
        and bad["route"] not in answer.text
    )


def test_alternatives_need_explicit_permission_and_identify_unmet_constraints():
    bad = product(attributes=[])
    for permission in (False, True):
        message = "black shoes" + ("; show alternatives" if permission else "")
        answer, _ = asyncio.run(scenario(message, {"alternatives": True}, [bad]))
        assert (bad["route"] in answer.text) == permission
        if permission:
            assert "Alternatives" in answer.text and "color=black" in answer.text


def test_brand_and_preferences_are_grounded_and_ranking_is_stable():
    good = product(
        attributes=[
            {"name": "brand", "value": '"Acme"'},
            {"name": "material", "value": '"leather"'},
        ]
    )
    cheaper = product(2, price="80", attributes=[{"name": "brand", "value": '"Acme"'}])
    wrong_brand = product(3, price="70", attributes=[])
    answer, _ = asyncio.run(
        scenario(
            "Acme shoes, preferably leather",
            {
                "brand": "Acme",
                "preferences": [{"name": "material", "value": "leather"}],
            },
            [wrong_brand, cheaper, good],
        )
    )
    assert wrong_brand["route"] not in answer.text
    assert answer.text.index(good["route"]) < answer.text.index(cheaper["route"])
    assert "Preference matches: material=leather" in answer.text


def test_unverified_use_and_markup_are_not_invented_claims():
    good = product(name="Laptop [click](https://evil) <script>", attributes=[])
    answer, _ = asyncio.run(
        scenario("laptop mainly for Python", {"intended_use": "Python"}, [good])
    )
    assert "Suitability for Python is not verified" in answer.text
    assert "[click]" not in answer.text and "<script>" not in answer.text


@pytest.mark.parametrize(
    "alter",
    [
        lambda a: a.model_copy(update={"status": "disabled"}),
        lambda a: a.model_copy(
            update={"tools": a.tools.model_copy(update={"allowed": frozenset()})}
        ),
        lambda a: a.model_copy(
            update={"safety": a.safety.model_copy(update={"max_tool_calls": 0})}
        ),
    ],
)
def test_shopping_respects_agent_authorization_and_limits(alter):
    with pytest.raises(RuntimeErrorCode):
        asyncio.run(scenario("shoes", {}, [product()], alter_agent=alter))


def test_tool_failure_and_mismatched_reference_fail_closed():
    with pytest.raises(RuntimeErrorCode, match="tool_unavailable"):
        asyncio.run(scenario("shoes", {}, [], status=503))
    with pytest.raises(RuntimeErrorCode, match="invalid_reference"):
        asyncio.run(
            scenario(
                f"similar but cheaper {product(9)['route']}",
                {"cheaper": True},
                [],
                reference=product(),
            )
        )


def test_schema_is_closed_and_strict_provider_compatible():
    from app.commerce_resolution_engine.providers.openai import strict_schema

    schema = strict_schema(ShoppingIntent)
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["$defs"]["Constraint"]["additionalProperties"] is False
    assert Product.model_validate(product()).category_name == "Shoes"


def test_negative_alternatives_permission_never_relaxes_requirements():
    answer, _ = asyncio.run(
        scenario(
            "black shoes; do not show alternatives",
            {"alternatives": True},
            [product(attributes=[])],
        )
    )
    assert (
        "Alternatives" not in answer.text
        and "I couldn’t find products matching your request in this store."
        in answer.text
    )


def test_total_deadline_cancels_extraction():
    class Slow(Provider):
        async def generate(self, request):
            await asyncio.sleep(1)
            return await super().generate(request)

    async def run():
        agent = default_agents(TENANT).load(TENANT, "shopper")
        agent = agent.model_copy(
            update={"safety": agent.safety.model_copy(update={"timeout_seconds": 0.01})}
        )
        runtime = AgentRuntime(
            AgentCatalog((agent,)),
            {"default": Slow({})},
            shopping=True,
            shopping_handler=shopping_answer,
        )
        with pytest.raises(TimeoutError):
            _ = [
                e
                async for e in runtime.stream(
                    agent_id="shopper", principal=WHO, message="shoes"
                )
            ]

    asyncio.run(run())


def test_nonshopping_returns_to_shared_runtime_with_remaining_iteration_budget():
    from app.commerce_resolution_engine.contracts import ModelEvent

    class Support(Provider):
        async def stream(self, request):
            yield ModelEvent("text_delta", "Please see the return policy.")
            yield ModelEvent(
                "completed",
                response=ModelResponse(
                    "Please see the return policy.",
                    (),
                    None,
                    Usage(1, 1, 2),
                    "fixture",
                    "stop",
                ),
            )

    async def run(limit):
        agent = default_agents(TENANT).load(TENANT, "shopper")
        agent = agent.model_copy(
            update={"safety": agent.safety.model_copy(update={"max_iterations": limit})}
        )
        runtime = AgentRuntime(
            AgentCatalog((agent,)),
            {"default": Support({"shopping": False})},
            shopping=True,
            shopping_handler=shopping_answer,
        )
        return [
            e
            async for e in runtime.stream(
                agent_id="shopper", principal=WHO, message="Return policy?"
            )
        ]

    assert asyncio.run(run(2))[-1].answer.text == "Please see the return policy."
    with pytest.raises(RuntimeErrorCode, match="iteration_limit"):
        asyncio.run(run(1))


def test_cheaper_reference_requires_specific_sku():
    reference = product(9, product_type="configurable")
    answer, requests = asyncio.run(
        scenario(
            f"similar but cheaper {reference['route']}",
            {"cheaper": True},
            [],
            reference=reference,
        )
    )
    assert "specific variant" in answer.text
    assert [r["name"] for r in requests] == ["get_product"]


def test_progress_arrives_before_catalog_finishes_and_close_cancels_tool():
    from app.commerce_action_engine.actions.catalog import DEFINITIONS, CatalogResult
    from app.commerce_resolution_engine.runtime import RuntimeTool

    async def run():
        cancelled = asyncio.Event()

        async def blocked(arguments, principal):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        tool = RuntimeTool(
            DEFINITIONS[0],
            CatalogResult,
            blocked,
            frozenset({"shopper"}),
            authenticated=False,
        )
        runtime = AgentRuntime(
            default_agents(TENANT),
            {"default": Provider({})},
            (tool,),
            shopping=True,
            shopping_handler=shopping_answer,
        )
        stream = runtime.stream(agent_id="shopper", principal=WHO, message="shoes")
        async with asyncio.timeout(1):
            progress = await anext(stream)
            assert (
                progress.type == "tool_started"
                and progress.text == "get_catalog_schema"
            )
            await stream.aclose()
            assert cancelled.is_set()

    asyncio.run(run())


@pytest.mark.anyio
async def test_rich_recommendations_share_constraint_selection_and_public_media():
    image = str(UUID(int=99))
    answer, _ = await scenario(
        "black shoes under $100 size 42",
        {"attributes": [{"name": "size", "value": "42"}]},
        [product(image_id=image), product(2, price="150"), product(3, attributes=[])],
    )
    block = answer.blocks[0]
    assert block.kind == "recommendation_group"
    assert [str(p.id) for p in block.products] == [product()["id"]]
    card = block.products[0]
    assert str(card.image_id) == image
    assert card.price == "99" and card.route == product()["route"]
    assert "Catalog lists size: 42 (source: MERCHANT)" in card.reasons
    assert not card.unmet
    assert str(block.sources[0].product_id) == product()["id"]


@pytest.mark.anyio
async def test_comparison_reads_fresh_facts_in_requested_order_and_marks_missing():
    first = product(price="89", in_stock=None)
    second = product(2, price="109", attributes=[])
    answer, requests = await scenario(
        f"Compare {second['route']} {first['route']}",
        {"presentation": "compare"},
        [first, second],
    )
    assert [r["name"] for r in requests] == ["compare_products"]
    block = answer.blocks[0]
    assert [str(p.id) for p in block.products] == [second["id"], first["id"]]
    rows = {r.label: r.values for r in block.rows}
    assert rows["Current price"] == ["109 USD", "89 USD"]
    assert rows["size"] == ["Not provided", "42"]
    assert rows["Availability"] == ["In stock", "Availability unknown"]


@pytest.mark.anyio
async def test_comparison_requires_distinct_user_references_and_exact_tool_identities():
    answer, calls = await scenario("Compare shoes", {"presentation": "compare"}, [])
    assert "two to five" in answer.text and calls == []
    with pytest.raises(RuntimeErrorCode, match="invalid_reference"):
        await scenario(
            f"Compare {product()['route']} {product(2)['route']}",
            {"presentation": "compare"},
            [product(), product()],
        )


@pytest.mark.anyio
async def test_product_detail_and_browse_have_typed_presentations():
    item = product()
    answer, _ = await scenario(
        f"Show {item['route']}", {"presentation": "detail"}, [], reference=item
    )
    assert answer.blocks[0].kind == "product_card"
    answer, _ = await scenario("Browse shoes", {"presentation": "search"}, [item])
    assert answer.blocks[0].kind == "product_list"
    assert answer.blocks[-1].action.route == "/search"


def test_rich_blocks_reject_wrong_routes_sources_dimensions_and_arbitrary_html():
    from app.commerce_action_engine.application.responses import (
        card,
        catalog_block,
        validate_blocks,
    )
    from app.commerce_action_engine.contracts import AssistantBlock

    p = Product.model_validate(product())
    block = catalog_block("product_card", [card(p, [], [])], "Details")
    validate_blocks([block])
    data = block.model_dump(mode="json", exclude_unset=True)
    assert data["products"][0]["image_id"] is None
    assert "rows" not in data
    for mutation in (
        {**data, "html": "<script>alert(1)</script>"},
        {**data, "text": "extra payload"},
        {
            **data,
            "kind": "comparison_table",
            "rows": [{"label": "Size", "values": ["42", "43"]}],
        },
        {
            **data,
            "sources": [
                {"kind": "catalog", "product_id": str(UUID(int=999)), "route": p.route}
            ],
        },
        {
            **data,
            "products": [
                {**data["products"][0], "route": f"/products/{UUID(int=999)}"}
            ],
        },
    ):
        with pytest.raises(ValueError):
            validate_blocks([AssistantBlock.model_validate(mutation)])


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.parametrize("message", ["Show me some products", "Show me products"])
def test_broad_browsing_with_empty_extraction_searches_catalog(message):
    answer, calls = asyncio.run(
        scenario(message, {"query": "", "presentation": "search"}, [product()])
    )
    assert calls[0]["name"] == "search_products"
    assert calls[0]["arguments"]["query"] == "*"
    assert answer.blocks[0].kind == "product_list"
    assert answer.blocks[0].products[0].name == "Running shoes"


def test_empty_browsing_query_keeps_currency_and_exclusive_budget():
    answer, calls = asyncio.run(
        scenario(
            "Show me products under 20 KWD",
            {
                "query": "",
                "presentation": "search",
                "max_price": "20",
                "currency": "KWD",
                "exclusive_max": True,
            },
            [
                product(1, price="19", currency="KWD"),
                product(2, price="20", currency="KWD"),
                product(3, price="10", currency="USD"),
            ],
        )
    )
    assert calls[0]["arguments"]["max_price"] == "20"
    assert [p.id for p in answer.blocks[0].products] == [UUID(int=11)]


@pytest.mark.parametrize("query", ["fruit", "fruites"])
def test_fruit_color_uses_explicit_catalog_classification(query):
    apple = product(
        1,
        name="Red Apples",
        category="Fresh Produce",
        attributes=[
            {"name": "product-kind", "value": '"fruit"'},
            {"name": "color", "value": '"red"'},
        ],
    )
    missing_color = product(
        2,
        name="Red Apples",
        category="Fresh Produce",
        attributes=[
            {"name": "product-kind", "value": '"fruit"'},
        ],
    )
    vegetable = product(
        3,
        name="Red Peppers",
        category="Fresh Produce",
        attributes=[
            {"name": "product-kind", "value": '"vegetable"'},
            {"name": "color", "value": '"red"'},
        ],
    )
    green = product(
        4,
        name="Green Apples",
        category="Fresh Produce",
        attributes=[
            {"name": "product-kind", "value": '"fruit"'},
            {"name": "color", "value": '"green"'},
        ],
    )
    unclassified = product(
        5,
        name="Red Apples",
        category="Fresh Produce",
        attributes=[
            {"name": "color", "value": '"red"'},
        ],
    )
    answer, _ = asyncio.run(
        scenario(
            f"find me {query} which red colored ?",
            {
                "query": "fruit",
                "category": "fruit",
                "attributes": [{"name": "color", "value": "red"}],
            },
            [apple, missing_color, vegetable, green, unclassified],
        )
    )
    assert [p.id for p in answer.blocks[0].products] == [UUID(int=11)]
    assert "color: red" in " ".join(answer.blocks[0].products[0].reasons)


@pytest.mark.parametrize(
    "message,product_text,search_query",
    [
        ("recommend dates", "dates", "dates"),
        ("pls recommend dates", "dates", "dates"),
        ("please recommend dates", "dates", "dates"),
        ("pls recommend dates item", "dates item", "dates item"),
    ],
)
def test_recommendation_by_unclassified_category_uses_exact_category_and_no_browse_action(
    message, product_text, search_query
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    dates = product(1, name="Sukkari Dates", category="Dates, Nuts & Sweets")
    apples = product(2, name="Gala Apples", category="Fruit")
    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=0.99,
            message="Understood.",
            entities={"productText": product_text, "category": "dates"},
        )
    )
    answer, calls = asyncio.run(
        scenario(
            message,
            {"query": "dates", "category": "dates", "presentation": "recommend"},
            [],
            search_products=lambda args: (
                [dates, apples]
                if args["query"] == "dates"
                else [dates]
                if args["query"] == "dates item"
                else [apples]
            ),
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["query"] == search_query
    assert [item.name for item in answer.blocks[0].products] == ["Sukkari Dates"]
    assert answer.blocks[0].kind == "recommendation_group"
    assert not any(block.kind == "action" for block in answer.blocks)


@pytest.mark.parametrize(
    "query,category",
    [("my product red", "product"), ("red", None), ("products", "products")],
)
def test_color_only_browsing_uses_catalog_search_and_keeps_color(query, category):
    red = product(1, attributes=[{"name": "color", "value": '"red"'}])
    black = product(2)
    answer, calls = asyncio.run(
        scenario(
            "show my product red",
            {
                "query": query,
                "category": category,
                "attributes": [{"name": "color", "value": "red"}],
            },
            [red, black],
        )
    )
    assert calls[0]["arguments"]["query"] == "*"
    assert [p.id for p in answer.blocks[0].products] == [UUID(int=11)]


def test_explicit_cheapest_ranking_precedes_personalization(monkeypatch):
    from app.commerce_action_engine.actions.shopping import selection

    monkeypatch.setattr(
        selection, "personalization_rank", lambda p: 100 if p.price == "99" else 0
    )
    products = [
        Product.model_validate(product(1, price="99")),
        Product.model_validate(product(2, price="5")),
    ]
    exact, _ = selection.select(
        products,
        ShoppingIntent(
            shopping=True,
            query="*",
            sort_by="price_asc",
        ),
        None,
    )
    assert [p.price for p, _ in exact] == ["5", "99"]


def test_cheapest_dates_uses_engine_catalog_search_without_reference_link():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=0.99,
            message="Understood",
            entities={
                "productText": "cheapest dates",
                "category": "dates",
                "sort_by": "price_asc",
            },
        )
    )
    answer, calls = asyncio.run(
        scenario(
            "pls i need cheapest dates",
            {},
            [
                product(
                    1, name="Medjool Dates", category="Dates, Nuts & Sweets", price="12"
                ),
                product(
                    2, name="Sukkari Dates", category="Dates, Nuts & Sweets", price="4"
                ),
                product(3, name="Apples", category="Fruit", price="1"),
            ],
            interpretation=interpretation,
        )
    )
    assert calls[0]["name"] == "search_products"
    assert calls[0]["arguments"]["query"] == "dates"
    assert [p.name for p in answer.blocks[0].products] == [
        "Sukkari Dates",
        "Medjool Dates",
    ]
    assert "paste one product link" not in answer.text


def test_recommendation_followup_excludes_seen_items_and_preserves_budget():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
            message="",
            entities={
                "productText": "shoes",
                "price": {"operator": "<", "value": 100, "currency": "USD"},
                "recommendationFollowup": "different",
                "excludedProducts": [str(UUID(int=11))],
            },
        )
    )
    answer, calls = asyncio.run(
        scenario(
            "recommend shoes under $100",
            {},
            [product(1, price="70"), product(2, price="80"), product(3, price="150")],
            interpretation=interpretation,
        )
    )
    assert [p.id for p in answer.blocks[0].products] == [UUID(int=12)]
    assert calls[0]["arguments"]["max_price"] == "100"


def test_cheaper_followup_uses_live_reference_and_keeps_attributes():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
            message="",
            entities={
                "productText": "shoes",
                "color": "black",
                "recommendationFollowup": "cheaper",
                "excludedProducts": [str(UUID(int=11))],
                "cheaperReferences": [str(UUID(int=11))],
            },
        )
    )
    answer, _calls = asyncio.run(
        scenario(
            "recommend black shoes",
            {},
            [
                product(2, price="80"),
                product(3, price="95"),
                product(4, price="50", attributes=[{"name": "color", "value": "red"}]),
            ],
            reference=product(1, price="90"),
            interpretation=interpretation,
        )
    )
    assert [p.id for p in answer.blocks[0].products] == [UUID(int=12)]


def test_exact_identity_precedes_generic_recommendation_rank(monkeypatch):
    from app.commerce_action_engine.actions.shopping import selection

    monkeypatch.setattr(
        selection, "personalization_rank", lambda p: 100 if p.price == "1" else 0
    )
    products = [
        Product.model_validate(product(1, name="Milk alternative", price="1")),
        Product.model_validate(product(2, name="Whole Milk 1L", price="5")),
    ]
    exact, _ = selection.select(
        products, ShoppingIntent(shopping=True, query="Whole Milk 1L"), None
    )
    assert exact[0][0].name == "Whole Milk 1L"


@pytest.mark.parametrize("query", ["whole milk 1l", "MILK-001"])
def test_exact_identity_keeps_budget_stock_and_explicit_sort(query):
    from app.commerce_action_engine.actions.shopping.selection import select

    exact_product = Product.model_validate(
        product(1, name="Whole Milk 1L", sku="MILK-001", price="5")
    )
    other = Product.model_validate(product(2, name="Milk alternative", price="1"))
    plan = ShoppingIntent(shopping=True, query=query)
    assert select([other, exact_product], plan, None)[0][0][0].id == exact_product.id
    plan.max_price = "2"
    assert [p.id for p, _ in select([other, exact_product], plan, None)[0]] == [
        other.id
    ]
    plan.max_price = None
    plan.sort_by = "price_asc"
    assert select([other, exact_product], plan, None)[0][0][0].id == other.id
    plan.sort_by = None
    plan.in_stock = True
    exact_product.in_stock = False
    assert [p.id for p, _ in select([other, exact_product], plan, None)[0]] == [
        other.id
    ]


@pytest.mark.parametrize(
    "field,value,valid",
    [
        ("meal occasion", "breakfast", True),
        ("meal_occasion", "breakfast", True),
        ("unknown field", "breakfast", False),
        ("meal occasion", "unknown option", False),
    ],
)
@pytest.mark.parametrize("commerce_meaning", [False, True])
@pytest.mark.parametrize("kind", ["select", "multiselect"])
def test_language_merchant_attribute_search_validates_schema(
    field, value, valid, commerce_meaning, kind
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={
                "productText": "milk",
                "merchantAttributes": [{"name": field, "value": value}],
                "price": {"operator": "<", "value": 5, "currency": "USD"},
            },
        )
    )
    answer, calls = asyncio.run(
        scenario(
            f"find milk under $5, {field}: {value}",
            {},
            [
                product(
                    1,
                    name="Milk",
                    price="2",
                    attributes=[
                        {
                            "name": "meal_occasion",
                            "value": json.dumps(
                                ["breakfast", "dessert"]
                                if kind == "multiselect"
                                else "breakfast"
                            ),
                        }
                    ],
                ),
                product(
                    2, name="Milk without verified attribute", price="1", attributes=[]
                ),
            ],
            catalog_schema_override=catalog_schema(
                "grocery",
                [
                    schema_attribute(
                        "meal_occasion",
                        kind,
                        options=["breakfast", "snack", "dessert"],
                        policy="semantic",
                    )
                ],
            ),
            commerce_meaning=commerce_meaning,
            interpretation=interpretation,
        )
    )
    if valid:
        assert calls, answer.text
        assert calls[0]["arguments"]["attributes"] == {"meal_occasion": "breakfast"}
        assert calls[0]["arguments"]["query"] == "milk"
        assert [p.name for block in answer.blocks for p in block.products or []] == [
            "Milk"
        ], answer.text
    else:
        assert not calls
        assert "clarify" in answer.text.lower()


@pytest.mark.parametrize(
    "industry,field,query,purpose",
    [
        ("grocery", "meal_occasion", "milk", "breakfast"),
        ("jewelry", "occasion", "necklace", "wedding"),
        ("outdoors", "activity", "lantern", "stargazing"),
    ],
)
@pytest.mark.parametrize("meaning", [False, True])
@pytest.mark.parametrize("intent", ["PRODUCT_SEARCH", "PRODUCT_RECOMMEND"])
def test_natural_purpose_uses_merchant_schema_and_verified_membership(
    industry, field, query, purpose, meaning, intent
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent=intent,
            confidence=1.0,
            message="",
            entities={
                "productText": query,
                "category": query,
                "catalogPurpose": purpose,
                "price": {"operator": "<", "value": 5, "currency": "USD"},
            },
        )
    )
    schema = catalog_schema(
        industry,
        [
            schema_attribute(
                field,
                "multiselect",
                options=[purpose, "other"],
                policy="semantic",
                semantic_role="intended_use",
            )
        ],
    )
    answer, calls = asyncio.run(
        scenario(
            f"find {query} for {purpose} under $5",
            {},
            [
                product(
                    1,
                    name=query,
                    price="2",
                    attributes=[
                        {"name": field, "value": json.dumps([purpose, "other"])}
                    ],
                ),
                product(
                    2,
                    name=query + " inferred",
                    price="1",
                    attributes=[
                        {
                            "name": field,
                            "value": json.dumps([purpose]),
                            "source": "AI_INFERRED",
                        }
                    ],
                ),
                product(3, name=query + " unknown", price="1", attributes=[]),
                product(
                    4,
                    name=query + " expensive",
                    price="5",
                    attributes=[{"name": field, "value": json.dumps([purpose])}],
                ),
            ],
            catalog_schema_override=schema,
            commerce_meaning=meaning,
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["query"] == query
    assert calls[0]["arguments"]["attributes"] == {field: purpose}
    assert [p.name for b in answer.blocks for p in b.products or []] == [query], (
        answer.text
    )


@pytest.mark.parametrize("fields", [[], ["occasion", "intended_for"]])
def test_unavailable_purpose_reports_no_match_but_ambiguous_purpose_clarifies(fields):
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={"productText": "necklace", "catalogPurpose": "wedding"},
        )
    )
    answer, calls = asyncio.run(
        scenario(
            "find necklace for wedding",
            {},
            [],
            catalog_schema_override=catalog_schema(
                "jewelry",
                [
                    schema_attribute(
                        f, options=["wedding"], semantic_role="intended_use"
                    )
                    for f in fields
                ],
            ),
            interpretation=interpretation,
        )
    )
    assert not calls
    if fields:
        assert "clarify" in answer.text.lower()
    else:
        assert answer.text == (
            "I couldn’t find products matching your request in this store. "
            "Try a different product name, category, or feature."
        )


def test_preparation_phrase_resolves_only_the_managed_catalog_option():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={
                "productText": "products",
                "catalogPurpose": "no cook",
                "price": {"operator": "<", "value": 5, "currency": "USD"},
            },
        )
    )
    answer, calls = asyncio.run(
        scenario(
            "Something I don't need to cook under $5",
            {},
            [
                product(
                    1,
                    name="Demo fruit",
                    price="2",
                    attributes=[{"name": "preparation_method", "value": '["no_cook"]'}],
                )
            ],
            catalog_schema_override=catalog_schema(
                "grocery",
                [
                    schema_attribute(
                        "preparation_method",
                        "multiselect",
                        options=["no_cook"],
                        policy="semantic",
                        semantic_role="intended_use",
                    )
                ],
            ),
            commerce_meaning=True,
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["query"] == "*"
    assert calls[0]["arguments"]["attributes"] == {"preparation_method": "no_cook"}
    assert [p.name for b in answer.blocks for p in b.products or []] == ["Demo fruit"]


def test_natural_purpose_cannot_soften_requested_product_type():
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities={
                "productText": "necklace",
                "category": "necklace",
                "catalogPurpose": "anniversary",
            },
        )
    )

    def tagged(number, name, kind):
        return product(
            number,
            name=name,
            price="50",
            category="Jewelry",
            attributes=[
                {"name": "jewelry_type", "value": json.dumps([kind])},
                {"name": "jewelry_occasion", "value": '["anniversary"]'},
            ],
        )

    schema = catalog_schema(
        "jewelry",
        [
            schema_attribute(
                "jewelry_type",
                "multiselect",
                options=["necklace", "earrings"],
                policy="semantic",
                semantic_role="classification",
            ),
            schema_attribute(
                "jewelry_occasion",
                "multiselect",
                options=["anniversary"],
                policy="semantic",
                semantic_role="intended_use",
            ),
        ],
    )
    answer, calls = asyncio.run(
        scenario(
            "A necklace for an anniversary",
            {},
            [
                tagged(1, "Moon Necklace", "necklace"),
                tagged(2, "Gold Earrings", "earrings"),
            ],
            catalog_schema_override=schema,
            commerce_meaning=True,
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["query"] == "necklace"
    assert calls[0]["arguments"]["attributes"] == {
        "jewelry_type": "necklace",
        "jewelry_occasion": "anniversary",
    }
    assert [p.name for b in answer.blocks for p in b.products or []] == [
        "Moon Necklace"
    ]
    assert "Suitability" not in answer.text
    assert "Verified:" in answer.text


@pytest.mark.parametrize(
    "industry,field,category",
    [("grocery", "grocery_group", "bakery"), ("jewelry", "jewelry_type", "necklace")],
)
@pytest.mark.parametrize("meaning", [False, True])
def test_explicit_category_recommendation_stays_hard(
    industry, field, category, meaning
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
            message="",
            entities={"productText": "*", "category": category},
        )
    )
    schema = catalog_schema(
        industry,
        [
            schema_attribute(
                field,
                "multiselect",
                options=[category, "other"],
                policy="semantic",
                semantic_role="classification",
            )
        ],
    )
    answer, calls = asyncio.run(
        scenario(
            f"Recommend products in category {category}",
            {},
            [
                product(
                    1,
                    name="Matching item",
                    attributes=[{"name": field, "value": json.dumps([category])}],
                ),
                product(
                    2,
                    name="Wrong category",
                    attributes=[{"name": field, "value": '["other"]'}],
                ),
                product(3, name="Missing category", attributes=[]),
            ],
            catalog_schema_override=schema,
            commerce_meaning=meaning,
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["attributes"] == {field: category}
    assert [p.name for b in answer.blocks for p in b.products or []] == [
        "Matching item"
    ], answer.text


@pytest.mark.parametrize("budget", [None, "2"])
def test_merchant_purpose_groups_retrieve_staples_before_optional_additions(budget):
    from app.commerce_action_engine.execution.language.gate import Resolution

    entities = {"productText": "products", "catalogPurpose": "breakfast"}
    if budget:
        entities["price"] = {
            "operator": "<=",
            "value": float(budget),
            "currency": "USD",
        }
    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1.0,
            message="",
            entities=entities,
        )
    )
    field = "meal_occasion_breakfast_priority"
    schema = catalog_schema(
        "grocery",
        [
            schema_attribute(
                "meal_occasion",
                "multiselect",
                options=["breakfast"],
                policy="semantic",
                semantic_role="intended_use",
            ),
            schema_attribute(
                field,
                "select",
                options=["bread", "cheese", "addition"],
                policy="semantic",
            ),
        ],
    )

    def row(i, name, bucket, price):
        return product(
            i,
            name=name,
            price=price,
            attributes=[
                {"name": "meal_occasion", "value": '["breakfast"]'},
                {"name": field, "value": bucket},
            ],
        )

    answer, calls = asyncio.run(
        scenario(
            "I need something for breakfast" + (" under $2" if budget else ""),
            {},
            [
                row(1, "Kiwi", "addition", "1"),
                row(2, "Bread", "bread", "1.5"),
                row(3, "Cheese", "cheese", "3"),
                row(4, "Second bread", "bread", "1.7"),
                product(5, name="Untagged noise", price="1", attributes=[]),
            ],
            catalog_schema_override=schema,
            commerce_meaning=True,
            commerce_planning=True,
            interpretation=interpretation,
        )
    )
    searches = (
        [c for c in calls if c["name"] == "search_products"]
        if calls and "name" in calls[0]
        else calls
    )
    assert len(searches) == 3
    names = [p.name for b in answer.blocks for p in b.products or []]
    assert names[:2] == (["Bread", "Kiwi"] if budget else ["Bread", "Cheese"]), (
        answer.text
    )
    assert "Untagged noise" not in names
    if budget:
        assert "Cheese" not in names


@pytest.mark.parametrize(
    "query,sort_by", [("milk", None), ("*", "price_asc"), ("*", "price_desc")]
)
def test_purpose_merchandising_does_not_override_specific_query_or_sort(query, sort_by):
    from app.commerce_action_engine.actions.catalog import CatalogSchema
    from app.commerce_action_engine.actions.shopping.contracts import Constraint
    from app.commerce_action_engine.actions.shopping.recommendations import (
        purpose_groups,
    )

    schema = CatalogSchema(
        **catalog_schema(
            "grocery",
            [
                schema_attribute(
                    "meal_occasion_breakfast_priority",
                    "select",
                    options=["bread", "cheese", "addition"],
                    policy="semantic",
                )
            ],
        )
    )
    assert (
        purpose_groups(
            ShoppingIntent(shopping=True, query=query, sort_by=sort_by),
            schema,
            Constraint(name="meal_occasion", value="breakfast"),
        )
        == []
    )


@pytest.mark.parametrize("query", ["breakfast", "brakfast"])
def test_bare_purpose_search_uses_unique_current_schema_option(query):
    from app.commerce_action_engine.actions.catalog import CatalogSchema
    from app.commerce_action_engine.actions.shopping.recommendations import (
        purpose_filter,
    )

    schema = CatalogSchema(
        **catalog_schema(
            "grocery",
            [
                schema_attribute(
                    "meal_occasion",
                    "multiselect",
                    options=["breakfast"],
                    policy="semantic",
                    semantic_role="intended_use",
                )
            ],
        )
    )
    assert (
        purpose_filter(
            ShoppingIntent(shopping=True, query=query, presentation="search"), schema
        ).value
        == "breakfast"
    )
    for text in ["breakfast cereal", "brakfast without nuts", "milk"]:
        assert (
            purpose_filter(
                ShoppingIntent(shopping=True, query=text, presentation="search"), schema
            )
            is None
        )


@pytest.mark.anyio
async def test_recommendation_response_keeps_eight_verified_products():
    candidates = [product(i, name=f"Running shoes {i}") for i in range(1, 9)]
    answer, _ = await scenario("recommend shoes", {}, candidates)
    block = answer.blocks[0]
    assert block.kind == "recommendation_group"
    assert len(block.products) == 8
    assert len(block.sources) == 8
    assert {str(p.id) for p in block.products} == {p["id"] for p in candidates}


@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("planning", [False, True])
@pytest.mark.parametrize(
    "category, second", [("Dairy & Eggs", "Eggs"), ("Cheese & Dairy", "Cheese")]
)
def test_joined_category_recommendation_matches_departments(
    fallback, planning, category, second
):
    from app.commerce_action_engine.execution.language.gate import Resolution

    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
            message="",
            entities={"productText": "*", "category": category.lower()},
        )
    )
    milk = product(1, name="Whole Milk", category=category)
    eggs = product(2, name=f"Fresh {second}", category=second)
    noise = product(3, name="Basmati Rice", category="Pantry")

    def search(args):
        if args["query"] == category.lower():
            return [] if fallback else [milk, eggs, noise]
        return [milk, noise] if args["query"] == "dairy" else [eggs, noise]

    answer, calls = asyncio.run(
        scenario(
            f"Recommend products in category {category}",
            {},
            [],
            search_products=search,
            commerce_planning=planning,
            interpretation=interpretation,
        )
    )
    assert {p.name for b in answer.blocks for p in b.products or []} == {
        "Whole Milk",
        f"Fresh {second}",
    }, answer.text
    assert [c["arguments"]["query"] for c in calls] == (
        [category.lower(), *category.lower().split(" & ")]
        if fallback
        else [category.lower()]
    )


def test_joined_category_matching_keeps_word_boundaries_and_budget():
    from app.commerce_action_engine.actions.catalog import Product
    from app.commerce_action_engine.actions.shopping.constraints import (
        matches_category,
        mismatches,
    )

    milk = Product.model_validate(
        product(1, name="Whole Milk", category="Dairy and Eggs", price="12")
    )
    assert matches_category(milk, "Dairy & Eggs")
    assert matches_category(milk, "dairy")
    assert matches_category(milk, "eggs")
    assert not matches_category(
        Product.model_validate(product(2, name="Eggshell Paint", category="Hardware")),
        "Dairy & Eggs",
    )
    assert not matches_category(
        Product.model_validate(product(3, name="Gold Ring", category="Jewelry")),
        "rose gold",
    )
    assert "maximum budget" in mismatches(
        milk,
        ShoppingIntent(
            shopping=True, query="*", category="Dairy & Eggs", max_price="5"
        ),
        None,
    )
