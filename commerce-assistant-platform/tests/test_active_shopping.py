"""Live search continuations use bounded observed facets and preserve hard frames."""

import json

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping_clarifications import question

from app.commerce_action_engine.actions.catalog.contracts import (
    CatalogProfile,
    CatalogSchema,
)
from app.commerce_action_engine.actions.shopping.continuation import (
    active_shopping,
    resolve_active_reply,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingChoice,
)
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)


def state(*, complete=True, currency="USD"):
    schema = CatalogSchema.model_validate(
        catalog_schema(
            "general",
            [
                schema_attribute("metal", options=["Gold", "Silver"]),
                schema_attribute("color", options=["Gold", "White"]),
                schema_attribute("material", options=["Titanium"]),
                schema_attribute(
                    "kind", options=["ring", "phone"], semantic_role="classification"
                ),
            ],
        )
    )
    profile = CatalogProfile(
        revision="content-v1",
        scope="current_sellable_category",
        complete=complete,
        candidate_count=3,
        matched_count=3,
        facets_complete=True,
        prices=[{"currency": "USD", "min": "10", "max": "100", "count": 3}],
        facets=[
            {
                "code": code,
                "label": code.title(),
                "data_type": "select",
                "covered_count": 3,
                "values": [{"value": value, "label": value, "count": count}],
                "values_complete": True,
            }
            for code, value, count in [
                ("metal", "Gold", 2),
                ("color", "Gold", 1),
                ("material", "Titanium", 3),
                ("kind", "phone", 3),
            ]
        ],
    )
    frame = question().frame
    frame.currency = currency
    return active_shopping(frame, "schema-v1", profile, schema)


def test_unique_observed_value_refines_without_dropping_previous_filters():
    current = state()
    result = resolve_active_reply(current, "Titanium")
    assert result.frame is not None and result.plan.field == "material"
    assert result.frame.attributes[-1] == Constraint(name="material", value="Titanium")
    assert result.frame.max_price == "800" and result.frame.attributes[0].value == "7"


def test_ambiguous_value_is_not_guessed_and_chosen_field_is_server_owned():
    ambiguous = resolve_active_reply(state(), "Gold")
    assert ambiguous.frame is None and ambiguous.question is not None
    assert [choice.field for choice in ambiguous.question.choices] == ["metal", "color"]
    resumed = resolve_shopping_reply(ambiguous.question, "Color: Gold").frame
    assert resumed is not None and resumed.attributes[-1] == Constraint(
        name="color", value="Gold"
    )
    assert resolve_shopping_reply(ambiguous.question, "Gold").frame is None
    assert resolve_shopping_reply(ambiguous.question, "under $500").frame is None


@pytest.mark.parametrize(
    "reply", ["phone", "find phones", "add a ring to cart", "remove Gold", "checkout"]
)
def test_classification_and_fresh_actions_do_not_resume_an_active_filter(reply):
    result = resolve_active_reply(state(), reply)
    assert result.frame is None and result.question is None


def test_partial_profiles_do_not_provide_facet_authority():
    partial = state(complete=False)
    assert (
        not partial.facets and resolve_active_reply(partial, "Titanium").frame is None
    )
    assert resolve_active_reply(partial, "under $500").frame.max_price == "500"


def test_budget_currency_can_only_default_from_all_matched_products_in_one_currency():
    current = state(currency=None)
    assert current.currency == "USD"
    assert resolve_active_reply(current, "500").frame.currency == "USD"
    assert resolve_active_reply(current, "500 EUR").frame is None
    assert resolve_active_reply(current, "under $50").error


def test_selected_facet_respects_existing_exclusions_and_ranges():
    plan = question()
    plan.frame.attributes.append(
        Constraint(name="style", value="statement", operator="neq")
    )
    assert resolve_shopping_reply(plan, "Classic").frame.attributes[-1] == Constraint(
        name="style", value="classic"
    )
    assert resolve_shopping_reply(plan, "Statement").frame is None
    plan = question()
    plan.field = "storage"
    plan.choices = [ShoppingChoice(label="128 GB", value=128)]
    plan.frame.attributes.append(Constraint(name="storage", value="64", operator="gte"))
    assert resolve_shopping_reply(plan, "128 GB").frame.attributes[-1].value == "128"
    plan.frame.attributes.append(Constraint(name="storage", value="100", operator="lt"))
    assert resolve_shopping_reply(plan, "128 GB").frame is None


def test_active_state_has_explicit_schema_and_size_limits():
    current = state()
    assert len(current.facets) <= 12 and all(
        len(facet.choices) <= 8 for facet in current.facets
    )
    assert len(json.dumps(current.model_dump(mode="json")).encode()) <= 23000
