"""M08 privacy isolation, contextual evidence, hard constraints and outage regressions."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from test_shopping import product

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.shopping import ShoppingIntent, select
from app.commerce_action_engine.actions.shopping import personalization as m
from app.commerce_action_engine.adapters.memory import MemoryTransport

NOW = datetime.now(UTC)
CHEAP = Product.model_validate(product(1, price="6"))
PREFERRED = Product.model_validate(product(2, price="10"))


def view(**changes):
    return m.MemoryView.model_validate(
        dict(
            schema_version="1.0.0",
            enabled=True,
            guest=False,
            personalized=True,
            journey_consent=True,
            consent_version=1,
            expires_at=NOW + timedelta(days=1),
            half_life_days=14,
            preferences=[],
            signals=[
                {
                    "product_id": PREFERRED.id,
                    "category_id": PREFERRED.category_id,
                    "name": PREFERRED.name,
                    "kind": "view",
                    "weight": 9,
                    "observed_at": NOW,
                }
            ],
            context={"revision": 0, "snapshot": None},
            categories=[{"id": PREFERRED.category_id, "name": "Shoes"}],
            products=[],
            **changes,
        )
    )


def make(**changes):
    data = view().model_dump()
    data.update(changes)
    return m.Session(
        m.MemoryView.model_validate(data),
        SimpleNamespace(load=AsyncMock(), save=AsyncMock()),
        UUID(int=7),
        "Find shoes",
    )


@pytest.fixture
def session():
    s = make()
    token = m._current.set(s)
    yield s
    m.reset(token)


def test_pilot_relevance_improves_while_hard_budget_stays_exact(session):
    plan = ShoppingIntent(shopping=True, query="shoes", max_price="20", currency="USD")
    session.bypass = True
    assert select([CHEAP, PREFERRED], plan, None)[0][0][0].id == CHEAP.id
    session.bypass = False
    assert select([CHEAP, PREFERRED], plan, None)[0][0][0].id == PREFERRED.id
    assert m.reasons(PREFERRED) == ["Because you viewed Running shoes"]
    plan.max_price = "10"
    plan.exclusive_max = True
    assert [p.id for p, _ in select([CHEAP, PREFERRED], plan, None)[0]] == [CHEAP.id]


@pytest.mark.parametrize(
    "change",
    [
        {"personalized": False},
        {"journey_consent": False},
        {"categories": []},
        {"signals": []},
    ],
)
def test_ineligible_evidence_cannot_rank(session, change):
    session.view = m.MemoryView.model_validate({**session.view.model_dump(), **change})
    assert m.rank(PREFERRED) == 0


@pytest.mark.parametrize(
    "context",
    [("other", "everyday"), ("self", "gift"), ("self", "work"), ("self", "travel")],
)
def test_journey_does_not_leak_into_other_recipients_or_occasions(session, context):
    session.recipient, session.occasion = context
    assert m.rank(PREFERRED) == 0


def test_explicit_dislike_dominates_observed_interest_and_expiry(session):
    evidence = m.Evidence(
        id=UUID(int=8),
        attribute="product",
        value=str(PREFERRED.id),
        category_id=PREFERRED.category_id,
        occasion="any",
        recipient="self",
        goal_id=None,
        signal="explicit_dislike",
        weight=-100,
        provenance="customer_control",
        consent_version=1,
        created_at=NOW,
        expires_at=NOW + timedelta(days=1),
    )
    session.view.preferences = [evidence]
    assert m.rank(PREFERRED) < -80
    assert (
        select([CHEAP, PREFERRED], ShoppingIntent(shopping=True, query="shoes"), None)[
            0
        ][0][0].id
        == CHEAP.id
    )
    evidence.expires_at = NOW - timedelta(seconds=1)
    assert m.rank(PREFERRED) > 0


def test_inferred_weight_is_bounded_and_decays(session):
    signal = session.view.signals[0]
    signal.weight = 60
    assert m.rank(PREFERRED) == 20
    signal.weight = 8
    signal.observed_at = NOW - timedelta(days=14)
    assert 3.99 < m.rank(PREFERRED) < 4.01


def snapshot(**changes):
    data = {
        "query": "shoes",
        "attributes": {"size": "42"},
        "min_price": "2",
        "max_price": "10",
        "currency": "USD",
        "brand": None,
        "category": None,
        "product_ids": [CHEAP.id],
        "exclusive_max": True,
        "in_stock": True,
        "intended_use": None,
        "shown_brands": ["acme"],
    }
    data.update(changes)
    return m.Snapshot(**data)


@pytest.mark.parametrize(
    "minimum,expected_minimum,exclusive",
    [(None, "2", True), ("1", "2", True), ("2", "2", True), ("3", "3", False)],
)
def test_guest_structured_followup_preserves_constraints_if_model_drops_them(
    session, minimum, expected_minimum, exclusive
):
    session.message = "the red ones"
    session.view.context.snapshot = snapshot(exclusive_min=True)
    assert "above 2" in session.recall()[0].text
    assert "under 10" in session.recall()[0].text
    plan = ShoppingIntent(
        shopping=True,
        query="red",
        max_price="100",
        min_price=minimum,
        attributes=[{"name": "color", "value": "red"}],
    )
    m.restore(plan, session.message)
    assert (
        plan.query == "shoes"
        and plan.max_price == "10"
        and plan.exclusive_max
        and plan.in_stock
        and plan.min_price == expected_minimum
        and plan.exclusive_min is exclusive
    )
    assert {a.name: a.value for a in plan.attributes} == {"size": "42", "color": "red"}
    session.message = "Find coffee"
    assert not session.recall()


def test_not_this_brand_uses_prior_verified_options_and_filters_immediately(session):
    session.view.context.snapshot = snapshot()
    old = Product.model_validate(
        product(3, attributes=[{"name": "brand", "value": '"Acme"'}])
    )
    other = Product.model_validate(
        product(4, attributes=[{"name": "brand", "value": '"Different"'}])
    )
    assert m.prepare("not this brand", [other, old]) is None
    assert m.excluded(old) and not m.excluded(other)
    assert [
        p.id
        for p, _ in select(
            [old, other], ShoppingIntent(shopping=True, query="shoes"), None
        )[0]
    ] == [other.id]
    session.view.context.snapshot = snapshot(shown_brands=["acme", "different"])
    assert "Which brand" in m.prepare("not this brand", [old, other])


def test_contextvars_and_optional_outage_never_share_identity():
    async def run():
        async def handler(request):
            raise httpx.ConnectError("offline")

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://memory"
        ) as client:
            token = await m.begin(
                MemoryTransport(client, "token"), UUID(int=1), "shoes"
            )
            assert m.current() is None
            m.reset(token)

        async def isolated(number):
            session = make()
            session.conversation = UUID(int=number)
            token = m._current.set(session)
            await asyncio.sleep(0)
            assert m.current().conversation == UUID(int=number)
            m.reset(token)

        await asyncio.gather(isolated(1), isolated(2))
        assert m.current() is None

    asyncio.run(run())


def test_opt_out_header_and_text_disable_only_optional_ranking():
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json=view().model_dump(mode="json"))
            ),
            base_url="http://memory",
        ) as client:
            for text, bypass in [
                ("Find shoes", True),
                ("Find shoes. Do not personalize this request", False),
            ]:
                token = await m.begin(
                    MemoryTransport(client, "token"), UUID(int=1), text, bypass
                )
                assert m.rank(PREFERRED) == 0
                m.reset(token)

    asyncio.run(run())
