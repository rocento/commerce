"""M07 eligibility, output evidence, merchandising disclosure and compatibility mode."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError
from test_shopping import product

from app.commerce_action_engine.actions.catalog import CatalogResult, Product
from app.commerce_action_engine.actions.catalog.discovery import (
    DiscoveryReport,
    labels,
    no_match,
)
from app.commerce_action_engine.actions.shopping import ShoppingIntent, select
from app.commerce_action_engine.application.shopping_presentation import render


def evidence(p, rank=1, sponsored=False):
    now = datetime.now(UTC)
    return {
        "schema_version": "1.0.0",
        "rank": rank,
        "score": 200,
        "contributions": [{"code": "lexical_relevance", "points": 200}],
        "sponsored": sponsored,
        "merchant_boost": 10 if sponsored else 0,
        "relationships": [],
        "offer": {
            "product_id": p["id"],
            "parent_id": None,
            "category_id": p["category_id"],
            "price": p["price"],
            "currency": p["currency"],
            "selling_unit": "pack",
            "in_stock": p["in_stock"],
            "observed_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=30)).isoformat(),
        },
    }


def discovered(number, price, rank, sponsored=False, **fields):
    p = product(number=number, price=price, **fields)
    p["discovery"] = evidence(p, rank, sponsored)
    return Product.model_validate(p)


def test_discovery_preserves_rank_after_hard_eligibility_and_labels_commercial_influence():
    promoted = discovered(1, "150", 1, True)
    relevant = discovered(2, "70", 2, True)
    cheap = discovered(3, "50", 3)
    plan = ShoppingIntent(shopping=True, query="shoes", max_price="100")
    exact, alternatives = select([promoted, cheap, relevant], plan, None)
    assert [p.id for p, _ in exact] == [relevant.id, cheap.id]
    assert not alternatives
    assert labels(relevant.discovery) == [
        "Sponsored listing",
        "Merchant promotion influences ranking",
    ]
    text = render([promoted, relevant, cheap], plan, None)
    assert str(promoted.id) not in text
    assert "Sponsored listing" in text


def test_discovery_cannot_override_price_currency_stock_or_verified_attributes():
    p = discovered(
        1,
        "50",
        1,
        True,
        in_stock=False,
        attributes=[{"name": "color", "value": '"black"', "source": "AI_INFERRED"}],
    )
    plan = ShoppingIntent(
        shopping=True,
        query="shoes",
        in_stock=True,
        attributes=[{"name": "color", "value": "black"}],
    )
    assert not select([p], plan, None)[0]


def test_compatibility_mode_preserves_existing_price_order():
    expensive = Product.model_validate(product(1, price="90"))
    cheap = Product.model_validate(product(2, price="50"))
    plan = ShoppingIntent(shopping=True, query="shoes")
    assert select([expensive, cheap], plan, None)[0][0][0].id == cheap.id
    assert labels(None) == []


@pytest.mark.parametrize("count", [6, 8])
def test_ranked_result_and_report_accept_the_catalog_result_limit(count):
    products = [product(number=n) for n in range(1, count + 1)]
    for rank, item in enumerate(products, 1):
        item["discovery"] = evidence(item, rank=rank)
    report = {
        "schema_version": "1.0.0",
        "retrieval": "fixture",
        "ranker": "fixture",
        "lexical_candidates": 20,
        "relation_candidates": 0,
        "evaluated": 20,
        "eligible": 20,
        "returned": count,
        "exhaustive": False,
        "semantic_enabled": False,
        "outcome": "matches",
    }
    result = CatalogResult.model_validate(
        {"products": products, "category": None, "discovery": report}
    )
    assert len(result.products) == result.discovery.returned == count
    assert result.products[-1].discovery.rank == count
    with pytest.raises(ValidationError):
        DiscoveryReport.model_validate({**report, "returned": 9})
    with pytest.raises(ValidationError):
        CatalogResult.model_validate(
            {"products": products + [products[0]] * 9, "category": None}
        )


@pytest.mark.parametrize(
    "alter",
    [
        lambda d: d["offer"].update(product_id=str(UUID(int=99))),
        lambda d: d["offer"].update(price="0.01"),
        lambda d: d["offer"].update(currency="EUR"),
        lambda d: d.update(score=999),
        lambda d: d.update(merchant_boost=11),
        lambda d: d.update(rank=9),
        lambda d: d.update(schema_version="2.0.0"),
        lambda d: d["offer"].update(
            expires_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()
        ),
    ],
)
def test_rejects_forged_or_unbounded_evidence(alter):
    p = product()
    p["discovery"] = evidence(p)
    alter(p["discovery"])
    with pytest.raises(ValidationError):
        Product.model_validate(p)


@pytest.mark.parametrize(
    "outcome,phrase",
    [
        (
            "bounded_no_candidates",
            "Try a different product name, category, or feature.",
        ),
        (
            "current_facts_filtered",
            "I couldn’t find products matching your request in this store.",
        ),
        ("availability_unknown", "could not be verified for this location"),
        ("matches", "Try a different product name, category, or feature."),
    ],
)
def test_no_match_is_bounded_and_does_not_relax(outcome, phrase):
    report = DiscoveryReport(
        schema_version="1.0.0",
        retrieval="fixture",
        ranker="fixture",
        lexical_candidates=0,
        relation_candidates=0,
        evaluated=0,
        eligible=0,
        returned=0,
        exhaustive=False,
        semantic_enabled=False,
        outcome=outcome,
    )
    assert phrase in no_match(report)
    with pytest.raises(ValidationError):
        DiscoveryReport.model_validate({**report.model_dump(), "exhaustive": True})
