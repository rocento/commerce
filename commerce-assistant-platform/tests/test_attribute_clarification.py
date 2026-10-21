"""Shared attribute values require a typed choice, without losing search scope."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import TENANT, WHO, interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.grounding import (
    attribute_clarification,
    ground_request,
    observed_schema,
    required_uncertainty,
)
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)


def catalog(
    industry="jewelry", category="Rings", value="silver", fields=("metal", "color")
):
    data = catalog_schema(
        industry, [schema_attribute(field, options=[value]) for field in fields]
    )
    if category:
        data["categories"] = [
            {"id": str(UUID(int=2)), "name": category, "sellable_count": 2}
        ]
    return CatalogSchema.model_validate(data)


@pytest.mark.parametrize(
    "industry,category,value,fields",
    [
        ("jewelry", "Rings", "silver", ("metal", "color")),
        ("electronics", "Phones", "gold", ("color", "edition")),
        ("grocery", "Apples", "green", ("color", "variety")),
        ("pharmacy", "Shampoo", "sensitive", ("skin_type", "scalp_type")),
    ],
)
def test_shared_value_asks_for_field_across_every_demo(
    industry, category, value, fields
):
    schema = catalog(industry, category, value, fields)
    message = f"I need {value} {category.lower()}"
    # Even an inferred field cannot silently decide an ambiguous customer word.
    original = ShoppingIntent(
        shopping=True,
        query=message,
        max_price="234",
        currency="USD",
        attributes=[Constraint(name=fields[0], value=value)],
    )
    frame = ground_request(original, message, schema).frame
    question = attribute_clarification(frame, message, schema)
    assert question is not None and not question.optional
    assert {c.field for c in question.choices} == set(fields)
    assert question.frame.category_id == str(UUID(int=2))
    assert not question.frame.attributes
    assert resolve_shopping_reply(question, value).frame is None
    assert resolve_shopping_reply(question, "Show options").frame is None
    for choice in question.choices:
        reply = resolve_shopping_reply(question, choice.label).frame
        assert reply is not None
        assert reply.attributes == [Constraint(name=choice.field, value=value)]
        assert reply.category_id == str(UUID(int=2)) and reply.query == "*"
        assert reply.max_price == "234" and reply.currency == "USD"
        assert required_uncertainty(reply) is None


@pytest.mark.parametrize("noun", ["ring", "rings"])
def test_singular_and_plural_categories_and_explicit_fields(noun):
    message = f"I need {noun} with metal silver"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, catalog()
    ).frame
    assert frame.category_id == str(UUID(int=2))
    assert frame.attributes == [Constraint(name="metal", value="silver")]
    assert attribute_clarification(frame, message, catalog()) is None
    assert required_uncertainty(frame) is None


@pytest.mark.parametrize("suffix", ["", " under $234"])
def test_product_name_fallback_preserves_name_instead_of_browsing_whole_catalog(suffix):
    message = "I need silver orbit pendants" + suffix
    schema = catalog(category=None)
    grounded = ground_request(
        ShoppingIntent(shopping=True, query="silver orbit pendants" + suffix),
        message,
        schema,
    )
    question = attribute_clarification(grounded.frame, message, schema)
    assert question is not None
    assert question.frame.category_id is None
    assert question.frame.query == "orbit pendants"
    assert grounded.literal_query == "silver orbit pendants" + suffix


def test_resolving_one_attribute_does_not_drop_another_unknown_requirement():
    message = "I need silver waterproof rings"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, catalog()
    ).frame
    question = attribute_clarification(frame, message, catalog())
    assert question is not None
    resumed = resolve_shopping_reply(question, question.choices[0].label).frame
    assert resumed is not None and "waterproof" in required_uncertainty(resumed)


def test_multiword_shared_value_and_sequential_ambiguities():
    schema = catalog(value="rose_gold")
    schema.attributes.extend(
        catalog(value="classic", fields=("style", "collection")).attributes
    )
    message = "I need classic rose gold rings"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema
    ).frame
    first = attribute_clarification(frame, message, schema)
    assert first is not None and {c.field for c in first.choices} == {
        "style",
        "collection",
    }
    resumed = resolve_shopping_reply(first, first.choices[0].label).frame
    second = attribute_clarification(resumed, message, schema)
    assert second is not None and {c.field for c in second.choices} == {
        "metal",
        "color",
    }
    final = resolve_shopping_reply(second, second.choices[0].label).frame
    assert final is not None and len(final.attributes) == 2
    assert not final.unresolved_requirements


def test_negative_shared_value_is_not_changed_into_a_positive_filter():
    message = "I need rings without silver"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, catalog()
    ).frame
    assert attribute_clarification(frame, message, catalog()) is None
    assert required_uncertainty(frame) is not None


def test_an_inferred_brand_does_not_survive_a_different_attribute_choice():
    schema = catalog(fields=("maker", "color"))
    schema.attributes[0].semantic_role = "brand"
    message = "I need silver rings"
    frame = ground_request(
        ShoppingIntent(
            shopping=True,
            query=message,
            brand="Silver",
            attributes=[Constraint(name="maker", value="Silver")],
        ),
        message,
        schema,
    ).frame
    question = attribute_clarification(frame, message, schema)
    assert question is not None
    selected = next(c for c in question.choices if c.field == "color")
    resumed = resolve_shopping_reply(question, selected.label).frame
    assert resumed is not None and resumed.brand is None
    assert resumed.attributes == [Constraint(name="color", value="silver")]


@pytest.mark.parametrize(
    "change", [{"complete": False}, {"facets_complete": False}, {"revision": "stale"}]
)
def test_unverified_observations_cannot_create_attribute_options(change):
    from app.commerce_action_engine.actions.catalog import CatalogProfile

    schema = catalog()
    schema.attributes[0].data_type = "text"
    schema.attributes[0].options = []
    profile = CatalogProfile.model_validate(
        {
            "revision": schema.version,
            "scope": "current_sellable_category",
            "complete": True,
            "candidate_count": 1,
            "matched_count": 1,
            "facets_complete": True,
            "prices": [],
            "facets": [
                {
                    "code": "metal",
                    "label": "Metal",
                    "data_type": "text",
                    "covered_count": 1,
                    "values_complete": True,
                    "values": [{"value": "Silver", "label": "Silver", "count": 1}],
                }
            ],
            **change,
        }
    )
    assert observed_schema(schema, profile) == schema


def test_exact_product_name_takes_precedence_over_attribute_decomposition():
    schema = catalog()
    source = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1,
            message="",
            entities={"productText": "silver rings"},
        )
    )
    answer, _ = asyncio.run(
        scenario(
            "I need silver rings",
            {"query": "silver rings"},
            [product(name="Silver Rings", category="Rings", attributes=[])],
            catalog_schema_override=schema.model_dump(mode="json"),
            interpretation=source,
        )
    )
    assert "Silver Rings" in answer.text


@pytest.mark.parametrize("meaning", [False, True])
@pytest.mark.parametrize("free_text", [False, True])
def test_real_search_resumes_selected_attribute_and_budget_without_model(
    meaning, free_text
):
    async def run():
        schema = catalog()
        if free_text:
            for field in schema.attributes:
                field.data_type = "text"
                field.options = []
            from app.commerce_action_engine.actions.catalog.contracts import (
                SchemaAttribute,
            )

            schema.attributes.append(
                SchemaAttribute.model_validate(
                    schema_attribute("material", kind="text")
                )
            )
        calls = []

        class NoModel:
            async def generate(self, request):
                raise AssertionError("No model needed for a resolved shopping request")

        def handler(request):
            body = json.loads(request.content)
            calls.append(body)
            if body["name"] == "get_catalog_schema":
                return httpx.Response(
                    200,
                    json={
                        "products": [],
                        "category": None,
                        "catalog_schema": schema.model_dump(mode="json"),
                    },
                )
            assert body["name"] == "search_products"
            if (
                free_text
                and body["arguments"]["query"] == "*"
                and not body["arguments"].get("attributes")
            ):
                return httpx.Response(
                    200,
                    json={
                        "products": [],
                        "category": None,
                        "catalog_profile": {
                            "revision": schema.version,
                            "scope": "current_sellable_category",
                            "complete": True,
                            "candidate_count": 3,
                            "matched_count": 3,
                            "facets_complete": True,
                            "prices": [],
                            "facets": [
                                {
                                    "code": field,
                                    "label": field.title(),
                                    "data_type": "text",
                                    "covered_count": 3,
                                    "values_complete": True,
                                    "values": [
                                        {
                                            "value": "Silver",
                                            "label": "Silver",
                                            "count": 2,
                                        },
                                        {
                                            "value": "silver",
                                            "label": "silver",
                                            "count": 1,
                                        },
                                    ],
                                }
                                for field in ("metal", "color")
                            ],
                        },
                    },
                )
            return httpx.Response(
                200,
                json={
                    "products": [
                        product(
                            1,
                            name="Silver band",
                            category="Rings",
                            price="100",
                            attributes=[
                                {"name": "metal", "value": "silver"},
                                {"name": "color", "value": "white"},
                            ],
                        ),
                        product(
                            2,
                            name="Silver-tone band",
                            category="Rings",
                            price="100",
                            attributes=[
                                {"name": "metal", "value": "steel"},
                                {"name": "color", "value": "silver"},
                            ],
                        ),
                        product(
                            3,
                            name="Expensive silver band",
                            category="Rings",
                            price="900",
                            attributes=[{"name": "metal", "value": "silver"}],
                        ),
                    ],
                    "category": None,
                },
            )

        message = "I need silver rings under $234"
        source = interpreted(
            Resolution(
                status="RESOLVED",
                intent="PRODUCT_SEARCH",
                confidence=1,
                message="",
                entities={
                    "productText": "silver rings",
                    **({"material": "silver", "category": "ring"} if free_text else {}),
                },
            )
        )
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handler),
        ) as client:
            tools = {
                t.definition.name: t for t in registry(client, "catalog-token", WHO, {})
            }
            args = (
                message,
                NoModel(),
                default_agents(TENANT).load(TENANT, "shopper"),
                WHO,
                tools,
            )
            first = await shopping_answer(
                *args,
                grounded_intent=True,
                commerce_meaning=meaning,
                commerce_planning=True,
                interpretation=source,
            )
            question = first.pending_shopping
            assert question is not None and question.frame.max_price == "234"
            choice = next(c for c in question.choices if c.field == "metal")
            resumed = resolve_shopping_reply(question, choice.label).frame
            second = await shopping_answer(
                *args,
                grounded_intent=True,
                commerce_meaning=meaning,
                commerce_planning=True,
                interpretation=source,
                shopping_resume=resumed,
                shopping_resume_revision=schema.version,
                shopping_resume_question=question,
            )
            assert second is not None and second.pending_shopping is None
            assert "Silver band" in second.text
            assert (
                "Silver-tone band" not in second.text
                and "Expensive silver band" not in second.text
            )
            search = calls[-1]["arguments"]
            assert (
                search["category_id"] == str(UUID(int=2))
                and search["max_price"] == "234"
            )
            assert search["attributes"]["metal"].lower() == "silver"
            assert "material" not in search["attributes"]

    asyncio.run(run())
