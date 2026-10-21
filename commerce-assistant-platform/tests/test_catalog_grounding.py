"""Catalog language grounding never invents facts or drops typed requirements."""

import asyncio
from uuid import UUID

import pytest
from test_language_fallback import resolved
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogProfile, CatalogSchema
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.grounding import (
    ground_request,
    plan_clarification,
    required_uncertainty,
)
from app.commerce_action_engine.application.shopping_presentation import constraint_text


def schema():
    return CatalogSchema.model_validate(
        {
            "industry": "future-devices",
            "version": "test-1",
            "categories": [
                {"id": str(UUID(int=1)), "name": "Phones", "sellable_count": 10}
            ],
            "attributes": [
                {
                    "code": "storage_gb",
                    "label": "Storage GB",
                    "data_type": "integer",
                    "unit": "GB",
                    "min": None,
                    "max": None,
                    "options": [],
                    "filterable": True,
                    "searchable": True,
                    "facetable": True,
                    "sortable": True,
                    "comparable": True,
                    "variant_axis": False,
                    "source_policy": "factual",
                },
                {
                    "code": "maker",
                    "label": "Brand",
                    "semantic_role": "brand",
                    "data_type": "select",
                    "unit": None,
                    "min": None,
                    "max": None,
                    "options": [{"code": "apple", "label": "Apple"}],
                    "filterable": True,
                    "searchable": True,
                    "facetable": True,
                    "sortable": False,
                    "comparable": True,
                    "variant_axis": False,
                    "source_policy": "factual",
                },
            ],
        }
    )


def test_typed_measurement_is_preserved_before_residual_word_clarification():
    message = "I need good phones storage_gb at least 128 GB under $500"
    result = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    )
    assert result.frame.category_id == str(UUID(int=1))
    assert (
        Constraint(name="storage_gb", value="128", operator="gte")
        in result.frame.attributes
    )
    assert [(r.text, r.kind) for r in result.frame.unresolved_requirements] == [
        ("good", "preference")
    ]


@pytest.mark.parametrize(
    "label", ["in category", "in the category", "from category", "category:"]
)
def test_category_label_is_not_a_product_requirement_when_budget_is_present(label):
    query = f"products {label} Phones"
    message = f"Recommend {query} under 200 EGP"
    result = ground_request(
        ShoppingIntent(
            shopping=True,
            query=query,
            presentation="recommend",
            currency="EGP",
            max_price="200",
            exclusive_max=True,
        ),
        message,
        schema(),
        product_text=query,
    )
    assert result.frame.category_id == str(UUID(int=1))
    assert not result.frame.unresolved_requirements
    assert result.frame.currency == "EGP" and result.frame.max_price == "200"


def test_category_label_does_not_erase_independent_unknown_requirement():
    query = "products in category Phones waterproof"
    result = ground_request(
        ShoppingIntent(shopping=True, query=query, presentation="recommend"),
        f"Recommend {query} under 200 EGP",
        schema(),
        product_text=query,
    )
    assert [r.text for r in result.frame.unresolved_requirements] == ["waterproof"]


def test_preference_grammar_does_not_become_a_required_catalog_fact():
    message = "I prefer Apple phones"
    result = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    )
    assert result.frame.category_id == str(UUID(int=1))
    assert Constraint(name="maker", value="apple") in result.frame.preferences
    assert not result.frame.attributes
    assert not result.frame.unresolved_requirements


def test_numeric_preference_is_ranked_without_excluding_other_valid_phones():
    message = "I need phones, prefer Storage GB at least 128 GB"
    result = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    )
    wanted = Constraint(name="storage_gb", value="128", operator="gte")
    assert wanted in result.frame.preferences
    assert wanted not in result.frame.attributes
    assert wanted not in result.required_constraints
    assert not result.frame.unresolved_requirements


def test_later_preference_preserves_the_same_fields_explicit_requirement():
    message = "I need phones, must Storage GB at least 256 GB, prefer Storage GB at least 128 GB"
    result = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    )
    required = Constraint(name="storage_gb", value="256", operator="gte")
    assert required in result.frame.attributes
    assert required in result.required_constraints
    assert (
        Constraint(name="storage_gb", value="128", operator="gte")
        in result.frame.preferences
    )


def test_numeric_reason_states_comparison_instead_of_fabricating_exact_value():
    assert (
        constraint_text(Constraint(name="storage_gb", value="128", operator="gte"))
        == "storage gb≥128"
    )
    assert (
        constraint_text(Constraint(name="maker", value="apple", operator="neq"))
        == "maker≠apple"
    )


def test_required_unknown_quality_cannot_become_optional():
    message = "I need only luxury phones"
    result = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    )
    assert [(r.text, r.kind) for r in result.frame.unresolved_requirements] == [
        ("luxury", "required")
    ]


@pytest.mark.parametrize(
    "industry,category,description",
    [
        ("jewelry", "Rings", "elegant"),
        ("jewelry", "Rings", "classy"),
        ("jewelry", "Necklaces", "sophisticated"),
        ("jewelry", "Earrings", "stylish"),
        ("electronics", "Phones", "sleek"),
        ("electronics", "Laptops", "impressive"),
        ("electronics", "Headphones", "high-quality"),
        ("electronics", "Headphones", "high quality"),
        ("grocery", "Apples", "delicious"),
        ("grocery", "Bread", "tasty"),
        ("grocery", "Coffee", "flavourful"),
        ("grocery", "Snacks", "appetizing"),
        ("pharmacy", "Moisturizers", "luxurious"),
        ("pharmacy", "Shampoo", "excellent"),
        ("pharmacy", "Sunscreen", "top quality"),
    ],
)
def test_subjective_descriptions_allow_budget_refinement_across_demos(
    industry, category, description
):
    catalog = schema()
    catalog.industry = industry
    catalog.categories[0].name = category
    message = f"I need {description} {category.lower()}"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, catalog
    ).frame
    assert frame.category_id == str(UUID(int=1))
    assert frame.unresolved_requirements
    assert all(r.kind == "preference" for r in frame.unresolved_requirements)
    assert required_uncertainty(frame) is None
    profile = CatalogProfile.model_validate(
        {
            "revision": catalog.version,
            "scope": "current_sellable_category",
            "complete": True,
            "candidate_count": 3,
            "matched_count": 3,
            "facets": [],
            "facets_complete": True,
            "prices": [{"currency": "USD", "min": "50", "max": "418", "count": 3}],
        }
    )
    clarification = plan_clarification(frame, catalog, profile)
    assert clarification is not None and clarification.field == "budget"
    from app.commerce_action_engine.execution.language.shopping_reply import (
        resolve_shopping_reply,
    )

    resumed = resolve_shopping_reply(clarification, "Up to 234.00 USD").frame
    assert resumed is not None and resumed.max_price == "234.00"
    assert resumed.category_id == frame.category_id
    assert not resumed.unresolved_requirements


@pytest.mark.parametrize(
    "description",
    [
        "only elegant",
        "must be stylish",
        "not elegant",
        "without stylish",
        "no fancy",
        "required delicious",
        "sugar-free",
        "organic",
        "hypoallergenic",
        "waterproof",
    ],
)
def test_explicit_requirements_and_factual_claims_still_require_verification(
    description,
):
    message = f"I need {description} phones"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema()
    ).frame
    assert required_uncertainty(frame) is not None


def test_catalog_defined_style_takes_precedence_over_subjective_vocabulary():
    from test_catalog_schema import schema_attribute

    catalog = schema().model_dump(mode="json")
    catalog["categories"][0]["name"] = "Rings"
    catalog["attributes"].append(schema_attribute("style", options=["elegant"]))
    message = "I need elegant rings"
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message),
        message,
        CatalogSchema.model_validate(catalog),
    ).frame
    assert Constraint(name="style", value="elegant") in frame.attributes
    assert not frame.unresolved_requirements


def test_quoted_product_name_keeps_measurement_words_as_literal_identity():
    message = 'Find "Good Phones Storage GB 128"'
    frame = ShoppingIntent(shopping=True, query="Good Phones Storage GB 128")
    result = ground_request(frame, message, schema())
    assert result.frame == frame
    assert not result.literal_query
    assert not result.required_constraints


def test_budget_question_never_guesses_currency_from_mixed_offers_or_stale_choices():
    message = "I need good phones"
    catalog = schema()
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, catalog
    ).frame
    profile = CatalogProfile.model_validate(
        {
            "revision": catalog.version,
            "scope": "current_sellable_category",
            "complete": True,
            "candidate_count": 3,
            "matched_count": 3,
            "facets": [],
            "facets_complete": True,
            "prices": [
                {"currency": "USD", "min": "100", "max": "500", "count": 2},
                {"currency": "EGP", "min": "5000", "max": "5000", "count": 1},
            ],
        }
    )
    assert plan_clarification(frame, catalog, profile) is None
    profile.prices = [profile.prices[0].model_copy(update={"count": 3})]
    assert plan_clarification(frame, catalog, profile).field == "budget"
    profile.revision = "retired-schema"
    assert plan_clarification(frame, catalog, profile) is None


@pytest.mark.parametrize("budget", ["for $500", "budget 500"])
def test_measurement_removal_keeps_native_budget_without_bound_keywords(budget):
    message = f"I need phones Storage GB at least 128 GB {budget}"
    source = interpreted(
        resolved(
            intent="PRODUCT_SEARCH",
            entities={
                "productText": "phones Storage GB",
                "price": {
                    "operator": "BETWEEN",
                    "min": 128,
                    "max": 500,
                    "currency": "USD",
                },
            },
        )
    )
    goods = [
        product(
            i,
            name=f"Phone {i}",
            category="Phones",
            category_id=str(UUID(int=1)),
            price=price,
            attributes=[{"name": "storage_gb", "value": "128", "source": "MERCHANT"}],
        )
        for i, price in [(1, "400"), (2, "600")]
    ]
    answer, requests = asyncio.run(
        scenario(
            message,
            {"query": "unused"},
            goods,
            catalog_schema_override=schema().model_dump(mode="json"),
            interpretation=source,
        )
    )
    search = next(
        r["arguments"]
        for r in requests
        if r["name"] == "search_products" and r["arguments"].get("max_price")
    )
    assert search["min_price"] is None
    assert search["max_price"] == "500"
    assert [str(p.id) for b in answer.blocks for p in b.products or []] == [
        goods[0]["id"]
    ]


def test_wildcard_product_text_keeps_the_explicit_category():
    result = ground_request(
        ShoppingIntent(
            shopping=True, query="*", category="Phones", presentation="recommend"
        ),
        "Recommend products in category Phones",
        schema(),
        product_text="*",
    )
    assert result.frame.category_id == str(UUID(int=1))
    assert result.frame.query == "*"
    assert not result.frame.unresolved_requirements


def test_explicit_gifts_category_survives_occasion_refinement():
    from app.commerce_action_engine.execution.language.gate import Resolution

    catalog = schema().model_dump(mode="json")
    catalog["categories"] = [{"id": str(UUID(int=2)), "name": "Gifts"}]
    answer, calls = asyncio.run(
        scenario(
            "Recommend products in category Gifts",
            {},
            [product(name="Gift necklace", category="Gifts")],
            catalog_schema_override=catalog,
            interpretation=interpreted(
                Resolution(
                    status="RESOLVED",
                    intent="PRODUCT_RECOMMEND",
                    confidence=1,
                    message="",
                    entities={"category": "gifts", "productText": "*"},
                )
            ),
        )
    )
    assert answer.blocks[0].products
    searches = [c for c in calls if c["name"] == "search_products"]
    assert searches and all(
        c["arguments"].get("category_id") == str(UUID(int=2)) for c in searches
    )
