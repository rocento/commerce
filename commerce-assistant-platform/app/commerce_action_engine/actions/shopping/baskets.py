"""Bounded planning only. The browser approves stored proposals; models cannot write carts."""

import re

from pydantic import Field

from app.commerce_action_engine.actions.catalog import (
    DTO,
    Identifier,
    Money,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingIntent,
)
from app.commerce_action_engine.shared.errors import RuntimeErrorCode


class BasketGoal(DTO):
    purpose: str = Field(default="", max_length=500)
    budget: Money | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    all_inclusive: bool = False
    budget_exclusive: bool = False
    people: int | None = Field(default=None, ge=1, le=1000)
    locked_products: list[Identifier] = Field(default_factory=list, max_length=200)
    excluded_products: list[Identifier] = Field(default_factory=list, max_length=200)
    locked_brands: list[str] = Field(default_factory=list, max_length=20)
    allow_substitutions: bool = False
    delivery_date: str | None = Field(default=None, max_length=100)
    assumptions: list[str] = Field(default_factory=list, max_length=20)
    unresolved: list[str] = Field(default_factory=list, max_length=20)
    saving_target: Money | None = None


class SearchLine(DTO):
    intent: ShoppingIntent
    quantity: int = Field(ge=1, le=1000000)
    replace_proposed: Identifier | None = None


class QuantityEdit(DTO):
    product_id: Identifier
    quantity: int = Field(ge=1, le=1000000)


class ProductLockEvidence(DTO):
    product_id: Identifier
    customer_quote: str = Field(min_length=1, max_length=300)


class BasketPlan(DTO):
    goal: BasketGoal
    searches: list[SearchLine] = Field(default_factory=list, max_length=5)
    quantities: list[QuantityEdit] = Field(default_factory=list, max_length=30)
    lock_evidence: list[ProductLockEvidence] = Field(
        default_factory=list, max_length=200
    )
    clarification: str | None = Field(default=None, max_length=300)


from app.commerce_resolution_engine.prompts import (
    BASKET_INSTRUCTIONS,
)

INSTRUCTIONS = BASKET_INSTRUCTIONS


def preserve_product_locks(plan: BasketPlan, message: str, previous: list[str]) -> None:
    """Reject quantity-only lock evidence; uncertain identity constraints fail closed.

    Only a complete, narrowly recognized quantity/unit phrase can discard a new
    model lock. Mixed phrases, unsupported languages and missing/fabricated evidence
    never unlock a product. Saved locks are always retained.
    """
    quantity_phrase = re.compile(
        r"(?:keep|preserve|maintain)\s+"
        r"(?:(?:the|all|same|exact|existing|current|original)\s+)*"
        r"(?:quantities|quantity|(?:selling\s+)?units)"
        r"(?:\s+and\s+(?:(?:the|same|exact|existing|current|original)\s+)*"
        r"(?:quantities|quantity|(?:selling\s+)?units))*"
        r"(?:\s+(?:unchanged|the same))?[.!]?",
        re.IGNORECASE,
    )
    new_locks = set(plan.goal.locked_products) - set(previous)
    evidence: dict[str, list[str]] = {}
    for entry in plan.lock_evidence:
        if entry.product_id not in plan.goal.locked_products:
            raise RuntimeErrorCode("invalid_reference")
        evidence.setdefault(entry.product_id, []).append(entry.customer_quote.strip())
    for product_id in new_locks:
        quotes = evidence.get(product_id, [])
        if not quotes or any(quote not in message for quote in quotes):
            plan.goal.unresolved.append(
                "Please confirm which exact products must stay unchanged; quantities are preserved separately."
            )
        elif all(quantity_phrase.fullmatch(quote) for quote in quotes):
            remaining = message
            for quote in quotes:
                remaining = remaining.replace(quote, " ")
            # A model can quote only half of a mixed instruction. Any remaining
            # preservation/exclusion cue keeps the lock; negation is not permission.
            other_constraint = re.search(
                r"\b(?:keep|preserve|maintain|retain|leave|lock|unchanged|untouched|except|"
                r"never|don't|do not|without|only\s+(?:replace|change|substitute))\b",
                remaining,
                re.IGNORECASE,
            )
            if remaining.isascii() and not other_constraint:
                plan.goal.locked_products = [
                    value for value in plan.goal.locked_products if value != product_id
                ]
    plan.goal.locked_products = sorted(set(plan.goal.locked_products) | set(previous))
