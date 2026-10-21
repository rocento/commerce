"""Typed discovery continuation preserves requirements and never admits writes."""

import asyncio
from uuid import UUID

import pytest
from test_completion_store import store_for

from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingChoice,
    ShoppingClarification,
    ShoppingIntent,
    UnresolvedRequirement,
)
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)

SCOPE = tuple(UUID(int=i) for i in range(1, 4))
STORE, SESSION, REVISION = [UUID(int=i) for i in range(4, 7)]


def question(**overrides):
    return ShoppingClarification(
        question="Which style do you prefer?",
        field="style",
        choices=[
            ShoppingChoice(label="Classic", value="classic"),
            ShoppingChoice(label="Statement", value="statement"),
        ],
        frame=ShoppingIntent(
            shopping=True,
            query="rings",
            min_price="100",
            max_price="800",
            currency="USD",
            attributes=[Constraint(name="size", value="7")],
            in_stock=True,
            unresolved_requirements=[
                UnresolvedRequirement(
                    text="luxury", kind="preference", start=7, end=13
                ),
                UnresolvedRequirement(
                    text="must be genuine gold", kind="required", start=14, end=34
                ),
            ],
        ),
        descriptor_revision="catalog-v1",
        optional=True,
        currency="USD",
        **overrides,
    )


@pytest.mark.parametrize("reply", ["Classic", "classic", " CLASSIC "])
def test_whole_issued_choice_preserves_hard_requirements(reply):
    resumed = resolve_shopping_reply(question(), reply).frame
    assert resumed is not None
    assert resumed.attributes == [
        Constraint(name="size", value="7"),
        Constraint(name="style", value="classic"),
    ]
    assert (
        resumed.min_price == "100" and resumed.max_price == "800" and resumed.in_stock
    )
    assert resumed.discovery_refined
    assert [item.text for item in resumed.unresolved_requirements] == [
        "must be genuine gold"
    ]


def test_optional_skip_does_not_drop_mandatory_or_ambiguous_requirements():
    plan = question()
    plan.frame.unresolved_requirements.append(
        UnresolvedRequirement(text="for them", kind="ambiguous", start=35, end=43)
    )
    resumed = resolve_shopping_reply(plan, "Show options").frame
    assert resumed is not None and resumed.discovery_refined
    assert [item.kind for item in resumed.unresolved_requirements] == [
        "required",
        "ambiguous",
    ]
    assert resumed.attributes == plan.frame.attributes and resumed.max_price == "800"
    plan.optional = False
    assert resolve_shopping_reply(plan, "Show options").frame is None


@pytest.mark.parametrize(
    "reply,exclusive", [("under $500", True), ("up to 500 USD", False), ("500", False)]
)
def test_budget_reply_tightens_with_operator_currency_and_previous_conditions(
    reply, exclusive
):
    resumed = resolve_shopping_reply(question(), reply).frame
    assert resumed is not None and resumed.max_price == "500"
    assert resumed.exclusive_max is exclusive and resumed.min_price == "100"
    assert (
        resumed.currency == "USD" and resumed.attributes == question().frame.attributes
    )


@pytest.mark.parametrize(
    "reply",
    [
        "under 50 USD",
        "under 500 EUR",
        "under 500 XYZ",
        "under -5",
        "Classic and Statement",
        "classic; add it to cart",
    ],
)
def test_invalid_or_conflicting_reply_never_produces_a_frame(reply):
    result = resolve_shopping_reply(question(), reply)
    assert result.frame is None


@pytest.mark.parametrize(
    "reply",
    [
        "add a ring to cart",
        "checkout",
        "clear comparison",
        "find phones",
        "track order 3",
    ],
)
def test_complete_actions_and_reads_return_to_ordinary_admission(reply):
    result = resolve_shopping_reply(question(), reply)
    assert result.frame is None and result.fresh_request


def test_an_existing_attribute_requirement_cannot_be_replaced():
    plan = question()
    plan.frame.attributes.append(Constraint(name="style", value="statement"))
    result = resolve_shopping_reply(plan, "Classic")
    assert result.frame is None and result.error


def test_budget_chip_operator_is_typed_and_not_inferred_from_its_label():
    plan = question()
    plan.field = "budget"
    plan.choices = [
        ShoppingChoice(label="A translated budget label", value="500", operator="lt")
    ]
    resumed = resolve_shopping_reply(plan, "A translated budget label").frame
    assert resumed is not None and resumed.max_price == "500" and resumed.exclusive_max
    plan.choices[0].operator = "lte"
    resumed = resolve_shopping_reply(plan, "A translated budget label").frame
    assert (
        resumed is not None and resumed.max_price == "500" and not resumed.exclusive_max
    )


def test_pending_read_checks_expiry_store_session_owner_and_exact_original():
    plan = question()
    store, connection = store_for(
        {
            "revision": REVISION,
            "shopping_state": {
                "original_message": "I need luxury rings",
                "plan": plan.model_dump(mode="json"),
            },
        }
    )
    result = asyncio.run(
        store.shopping_question(
            *SCOPE,
            store_id=STORE,
            session_id=SESSION,
            revision=REVISION,
            original="I need luxury rings",
            question=plan.question,
        )
    )
    assert result["plan"] == plan
    sql, params = connection.calls[-1]
    assert (
        "expires_at>now()" in sql
        and "shopping_store_id=%s" in sql
        and "shopping_session_id=%s" in sql
    )
    assert (
        "original_hash=%s" in sql
        and "question_hash=%s" in sql
        and "customer_id=%s" in sql
    )
    assert params[:5] == (*SCOPE, STORE, SESSION)


def test_claim_rotates_once_before_tools_and_clears_the_server_frame():
    store, connection = store_for({"revision": REVISION})
    next_revision = asyncio.run(
        store.claim_shopping_question(
            *SCOPE,
            store_id=STORE,
            session_id=SESSION,
            revision=REVISION,
            original="rings",
            question="Style?",
        )
    )
    assert next_revision and next_revision != REVISION
    assert "FOR UPDATE" in connection.calls[-2][0]
    sql, params = connection.calls[-1]
    assert (
        "shopping_state=NULL" in sql
        and "expires_at>now()" in sql
        and "RETURNING revision" in sql
    )
    assert params[:7] == (next_revision, *SCOPE, REVISION, STORE, SESSION)
    missing, _ = store_for(None)
    assert (
        asyncio.run(
            missing.claim_shopping_question(
                *SCOPE,
                store_id=STORE,
                session_id=SESSION,
                revision=REVISION,
                original="rings",
                question="Style?",
            )
        )
        is None
    )


def test_publication_is_cas_bounded_and_contains_no_browser_authority():
    store, connection = store_for({"revision": REVISION})
    assert asyncio.run(
        store.publish_shopping_question(
            *SCOPE, REVISION, "rings", question(), store_id=STORE, session_id=SESSION
        )
    )
    sql, params = connection.calls[-1]
    assert "AND revision=%s AND NOT pending" in sql and "interval '15 minutes'" in sql
    assert params[3:5] == (STORE, SESSION)
    assert params[2].obj["plan"]["frame"]["attributes"] == [
        {"name": "size", "value": "7"}
    ]
    assert "revision" not in params[2].obj


def test_explicit_replacement_budget_keeps_minimum_currency_and_nonprice_requirements():
    pending = question()
    pending.field = "replacement_budget"
    pending.frame.min_price = "20"
    pending.frame.max_price = "75"
    pending.choices = []
    for amount in ("50", "75", "100"):
        reply = resolve_shopping_reply(pending, amount)
        assert reply.frame is not None
        assert reply.frame.min_price == "20" and reply.frame.max_price == amount
        assert reply.frame.currency == "USD"
        assert reply.frame.attributes == pending.frame.attributes
    for invalid in ("10", "100 EUR", "at least $30", "between $30 and $100", "yes"):
        assert resolve_shopping_reply(pending, invalid).frame is None
    # Existing generic budget questions retain their stricter intersection behavior.
    pending.field = "budget"
    assert resolve_shopping_reply(pending, "100").frame.max_price == "75"


def test_currency_budget_replaces_old_price_range_and_preserves_product_constraints():
    pending = question()
    pending.field = "currency_budget"
    pending.optional = False
    pending.choices = []
    pending.frame.currency = "EGP"
    pending.frame.exclusive_max = True
    for reply, maximum, strict in [
        ("10", "10", True),
        ("10 USD", "10", True),
        ("up to 15 USD", "15", False),
    ]:
        frame = resolve_shopping_reply(pending, reply).frame
        assert frame is not None
        assert (frame.currency, frame.min_price, frame.max_price) == (
            "USD",
            None,
            maximum,
        )
        assert frame.exclusive_max is strict
        assert frame.query == pending.frame.query and frame.in_stock
        assert frame.attributes == pending.frame.attributes
    assert pending.frame.currency == "EGP" and pending.frame.min_price == "100"
    for invalid in ("10 EGP", "10 EUR", "-10", "yes", "any"):
        assert resolve_shopping_reply(pending, invalid).frame is None
    assert resolve_shopping_reply(pending, "find milk instead").fresh_request
