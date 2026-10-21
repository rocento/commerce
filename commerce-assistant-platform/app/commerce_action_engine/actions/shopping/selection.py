"""Rank verified catalog candidates for shopping requests."""

from decimal import Decimal

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.references import key
from app.commerce_action_engine.actions.shopping.constraints import (
    matches_attribute,
    mismatches,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.personalization import (
    excluded as personalization_excluded,
)
from app.commerce_action_engine.actions.shopping.personalization import (
    rank as personalization_rank,
)


def select(
    products: list[Product], plan: ShoppingIntent, reference: Product | None
) -> tuple[list[tuple[Product, list[str]]], list[tuple[Product, list[str]]]]:
    exact: list[tuple[Product, list[str]]] = []
    alternatives: list[tuple[Product, list[str]]] = []
    seen = set()
    for product in products:
        if product.id in seen:
            continue
        seen.add(product.id)
        if personalization_excluded(product):
            continue
        failures = mismatches(product, plan, reference)
        if not failures:
            exact.append((product, failures))
        elif (
            plan.alternatives
            and product.product_type == "simple"
            and "currency" not in failures
        ):
            alternatives.append((product, failures))

    def rank(
        item: tuple[Product, list[str]],
    ) -> tuple[int, int, float, int, Decimal, str]:
        product = item[0]
        score = sum(
            matches_attribute(product, p, allow_inferred=True) for p in plan.preferences
        )
        if plan.intended_use:
            score += matches_attribute(
                product, Constraint(name="intended_use", value=plan.intended_use)
            )
        wanted = key(plan.query)
        identity = (
            0
            if wanted and wanted == key(product.sku)
            else 1
            if wanted and wanted == key(product.name)
            else 2
        )
        return (
            identity,
            -score,
            -personalization_rank(product),
            product.discovery.rank if product.discovery else 0,
            Decimal(product.price),
            str(product.id),
        )

    # Never compare nominal prices across currencies.
    exact.sort(
        key=lambda item: (
            (
                item[0].currency,
                -Decimal(item[0].price)
                if plan.sort_by == "price_desc"
                else Decimal(item[0].price),
                str(item[0].id),
            )
            if plan.sort_by in {"price_asc", "price_desc"}
            else (item[0].currency, rank(item))
        )
    )
    alternatives.sort(key=lambda item: (len(item[1]), item[0].currency, rank(item)))
    return exact, alternatives
