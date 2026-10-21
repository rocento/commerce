"""Finite typed replies to a server-issued discovery question, with no action text."""

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.pricing import (
    _BOUND,
    _MONEY,
    _RANGE,
    retain_price_bounds,
)


@dataclass(frozen=True)
class ShoppingReply:
    frame: ShoppingIntent | None = None
    # A fresh request must return to the ordinary language/action admission path.
    fresh_request: bool = False
    error: str | None = None


def choice_text(value: str | float | bool) -> str:
    return value if isinstance(value, str) else json.dumps(value, allow_nan=False)


def is_fresh_request(reply: str) -> bool:
    return bool(
        re.search(
            r"[\n;?!]|\b(add|remove|cancel|buy|reorder|checkout|ignore|instead|find|show|recommend|search|need|want|track|order|wishlist|cart|address|ticket|support|view|clear|reset|empty)\b",
            reply,
            re.IGNORECASE,
        )
    )


def resolve_shopping_reply(plan: ShoppingClarification, reply: str) -> ShoppingReply:
    """Accept only whole issued values, a complete budget, or optional skipping.

    Tightening a budget retains every previous bound. A currency switch and an
    empty range require clarification, never silently replace prior constraints.
    """
    plan = ShoppingClarification.model_validate(plan.model_dump())
    answer = reply.strip()
    if not answer or len(answer) > 250:
        return ShoppingReply(error="Please choose an option or give a short budget.")
    data = plan.frame.model_dump(mode="json")
    data["clarification"] = None
    data["discovery_refined"] = True
    data["unresolved_requirements"] = [
        requirement.model_dump()
        for requirement in plan.frame.unresolved_requirements
        if requirement.kind != "preference"
    ]
    if plan.optional and answer.casefold() in {"show options", "any", "no preference"}:
        return ShoppingReply(frame=ShoppingIntent.model_validate(data))
    # Choices are compared against the server's state, not browser-supplied chips.
    choices = [
        choice
        for choice in plan.choices
        if answer.casefold()
        in {choice.label.casefold(), choice_text(choice.value).casefold()}
    ]
    if len(choices) == 1:
        if plan.field == "domain_profile":
            data["domain_profile"] = choice_text(choices[0].value)
            try:
                return ShoppingReply(frame=ShoppingIntent.model_validate(data))
            except ValueError:
                return ShoppingReply(
                    error="That requirement profile is unavailable. Please send the complete request."
                )
        if plan.field == "gift_category" and plan.frame.gift_context:
            data.update(
                category_id=choice_text(choices[0].value),
                category=choices[0].label,
                query="*",
                discovery_refined=False,
            )
            return ShoppingReply(frame=ShoppingIntent.model_validate(data))
        if plan.field == "budget":
            operator = {
                "eq": "exactly",
                "lt": "under",
                "lte": "up to",
                "gt": "over",
                "gte": "at least",
            }[choices[0].operator]
            answer = f"{operator} {choice_text(choices[0].value)}"
            if plan.currency:
                answer += " " + plan.currency
        else:
            if choices[0].operator != "eq":
                return ShoppingReply(
                    error="Please send the full numeric product requirement."
                )
            value = choice_text(choices[0].value)
            field = choices[0].field or plan.field
            constraint = Constraint(name=field, value=value)
            # A selected facet is a requirement; it cannot replace an earlier one.
            old = [item for item in plan.frame.attributes if item.name == field]
            if any(not compatible_choice(item, value) for item in old):
                return ShoppingReply(
                    error="That conflicts with an earlier requirement. Please send the complete updated request."
                )
            preferences = [
                item for item in plan.frame.preferences if item.name != field
            ]
            data["preferences"] = [item.model_dump() for item in preferences]
            if not any(
                item.operator == "eq" and item.value.casefold() == value.casefold()
                for item in old
            ):
                data["attributes"] = [*data["attributes"], constraint.model_dump()]
            if field == "brand":
                if plan.frame.brand and plan.frame.brand.casefold() != value.casefold():
                    return ShoppingReply(
                        error="That conflicts with your required brand. Please send the complete updated request."
                    )
                data["brand"] = value
            if plan.resolves:
                resolved = {(r.start, r.end, r.text) for r in plan.resolves}
                data["unresolved_requirements"] = [
                    r
                    for r in data["unresolved_requirements"]
                    if (r["start"], r["end"], r["text"]) not in resolved
                ]
            try:
                return ShoppingReply(frame=ShoppingIntent.model_validate(data))
            except ValueError:
                return ShoppingReply(
                    error="Please send the complete updated product request."
                )
    if plan.field == "attribute":
        return ShoppingReply(
            error="Please choose which product feature you meant before refining the request further."
        )
    # No embedded clauses are accepted. Reuse the price parser's exact money grammar.
    budget_answer = re.sub(
        r"^(?:my\s+)?budget(?:\s+is)?\s+", "", answer, flags=re.IGNORECASE
    )
    if re.fullmatch(_MONEY, budget_answer, re.IGNORECASE):
        budget_answer = (
            "under "
            if plan.field == "currency_budget" and plan.frame.exclusive_max
            else "up to "
        ) + budget_answer
    if _BOUND.fullmatch(budget_answer) or _RANGE.fullmatch(budget_answer):
        try:
            explicit = retain_price_bounds({}, budget_answer)
            if plan.field == "currency_budget":
                # This server-issued question authorizes a replacement budget
                # in the offered currency, not conversion of the old bounds.
                if not plan.currency or (
                    explicit.get("currency") and explicit["currency"] != plan.currency
                ):
                    return ShoppingReply(
                        error=f"Please give your new budget in {plan.currency or 'the store currency'}."
                    )
                data.update(
                    currency=plan.currency,
                    min_price=None,
                    max_price=None,
                    exclusive_min=False,
                    exclusive_max=False,
                )
                return ShoppingReply(
                    frame=ShoppingIntent.model_validate(
                        retain_price_bounds(data, budget_answer)
                    )
                )
            currency = explicit.get("currency") or plan.frame.currency or plan.currency
            if currency is None:
                return ShoppingReply(
                    error="Please include the currency with your budget."
                )
            previous_currency = plan.frame.currency or plan.currency
            if (
                explicit.get("currency")
                and previous_currency
                and explicit["currency"] != previous_currency
            ):
                return ShoppingReply(
                    error="Please use the original currency or send the complete request with a new currency."
                )
            data["currency"] = currency
            if plan.field == "replacement_budget":
                # A server-issued question explicitly requests a new maximum.
                # Only that maximum may be replaced; currency and any minimum
                # remain requirements and are checked for conflicts below.
                if (
                    explicit.get("max_price") is None
                    or explicit.get("min_price") is not None
                ):
                    return ShoppingReply(error="Please give one maximum budget amount.")
                data["max_price"] = None
                data["exclusive_max"] = False
            return ShoppingReply(
                frame=ShoppingIntent.model_validate(
                    retain_price_bounds(data, budget_answer)
                )
            )
        except ValueError:
            return ShoppingReply(
                error="That conflicts with the existing price range. Please give a compatible budget."
            )
    if is_fresh_request(answer):
        return ShoppingReply(fresh_request=True)
    return ShoppingReply(
        error="Please choose one of the available options, give a budget, or start a complete new request."
    )


def compatible_choice(previous: Constraint, value: str) -> bool:
    if previous.operator == "eq":
        return previous.value.casefold() == value.casefold()
    if previous.operator == "neq":
        return previous.value.casefold() != value.casefold()
    if previous.operator == "contains":
        return previous.value.casefold() in value.casefold()
    try:
        old, new = Decimal(previous.value), Decimal(value)
        if not old.is_finite() or not new.is_finite():
            return False
        return {"lt": new < old, "lte": new <= old, "gt": new > old, "gte": new >= old}[
            previous.operator
        ]
    except (InvalidOperation, KeyError):
        return False
