"""Shopping text presentation over verified domain candidates."""

import re
from decimal import Decimal

from app.commerce_action_engine.actions.catalog import Product, no_match
from app.commerce_action_engine.actions.catalog import labels as discovery_labels
from app.commerce_action_engine.actions.catalog.discovery import DiscoveryReport
from app.commerce_action_engine.actions.shopping.constraints import matches_attribute
from app.commerce_action_engine.actions.shopping.context import (
    response_preferences,
    response_product_limit,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.evidence import attribute_evidence
from app.commerce_action_engine.actions.shopping.personalization import (
    reasons as personalization_reasons,
)
from app.commerce_action_engine.actions.shopping.selection import select


def plain(text: str) -> str:
    # Catalog strings are data. Never turn embedded markup into active links/images/HTML.
    return re.sub(r"[\[\]()*_`<>\\\x00-\x1f]", " ", text).strip()[:200]


def constraint_text(constraint: Constraint) -> str:
    operator = {
        "eq": "=",
        "contains": " contains ",
        "neq": "≠",
        "lt": "<",
        "lte": "≤",
        "gt": ">",
        "gte": "≥",
    }[constraint.operator]
    return f"{plain(constraint.name)}{operator}{plain(constraint.value)}"


def shopping_no_match(
    plan: ShoppingIntent, report: DiscoveryReport | None = None
) -> str:
    """Explain the checked request without attributing absence to an unproven cause."""
    if not plan.shopping_context:
        return no_match(report)
    lines = [
        "I couldn’t find products matching your request among the products checked in this store."
    ]
    if plan.max_price is not None:
        amount = " ".join(part for part in (plan.max_price, plan.currency) if part)
        lines.append(
            f"I searched for prices below {amount}."
            if plan.exclusive_max
            else f"I searched within your maximum budget of {amount}."
        )
    if any(
        r.relation == "intended_use" and not r.negated
        for r in plan.shopping_context.relations
    ):
        lines.append(
            "I cannot verify a suitable recommendation for your intended use from these results."
        )
    if "explain_fit" in response_preferences(plan):
        lines.append(
            "There is no verified matching recommendation to explain from these results."
        )
    if report is not None and report.outcome == "availability_unknown":
        lines.append("Delivery availability could not be verified for this location.")
    lines.append(
        "You can change the budget or product requirements and I can search again."
    )
    return " ".join(lines)


def narrowing_question(plan: ShoppingIntent, *, has_matches: bool) -> str:
    """Ask for one missing decision, preserving the requirements already supplied."""
    product = plain(plan.category or plan.query or "product")
    uses = (
        list(
            dict.fromkeys(
                plain(relation.value)
                for relation in plan.shopping_context.relations
                if relation.relation == "intended_use" and not relation.negated
            )
        )
        if plan.shopping_context
        else []
    )
    purpose = " for " + " and ".join(uses) if uses else ""
    if len(purpose) > 300:
        purpose = " for your stated uses"
    lead = (
        ""
        if has_matches
        else "I haven’t found a verified match among the products checked. "
    )
    if plan.max_price is not None:
        budget = " ".join(part for part in (plan.max_price, plan.currency) if part)
        lead += f"Your current maximum is {budget}. "
    return lead + (
        f"What maximum budget should I use for your {product}{purpose} "
        "(reply with an amount, keeping the current amount if it is firm)?"
        if plan.max_price is not None
        else f"What maximum budget should I use for your {product}{purpose} (include the currency)?"
    )


def render(
    products: list[Product], plan: ShoppingIntent, reference: Product | None
) -> str:
    exact, alternatives = select(products, plan, reference)
    if not exact and not alternatives:
        return shopping_no_match(plan)
    preferences = response_preferences(plan)
    limit = response_product_limit(plan)
    heading = "Matches to your verified constraints:"
    if plan.gift_context:
        gift = plan.gift_context
        heading = "Gift ideas"
        if gift.recipient:
            heading += " for " + plain(re.sub(r"^(?:my|our) ", "your ", gift.recipient))
        if gift.occasion:
            heading += " — " + plain(gift.occasion)
        heading += ":"
    lines = [heading if exact else shopping_no_match(plan)]
    if "practical_start" in preferences:
        lines.append("Start with the listed prices and verified features below.")
    if exact and plan.sort_by in {"price_asc", "price_desc"}:
        direction = (
            "highest to lowest" if plan.sort_by == "price_desc" else "lowest to highest"
        )
        currency_scope = (
            " within each currency"
            if len({product.currency for product, _ in exact}) > 1
            else ""
        )
        lines.append(
            "Among the products I checked, these matches are listed from "
            f"{direction} price{currency_scope}."
        )
    for label, items in (
        ("", exact),
        (
            "Alternatives — these do not meet every requirement:",
            alternatives if not exact else [],
        ),
    ):
        if label and items:
            lines.append(label)
        for product, failures in items[:limit]:
            stock = (
                "In stock"
                if product.in_stock is True
                else "Out of stock"
                if product.in_stock is False
                else "Delivery availability unknown"
            )
            lines.append(
                f"- {plain(product.name)} — {product.price} {product.currency}. {stock}. /products/{product.id}"
            )
            lines.extend(
                "  " + label + "."
                for label in discovery_labels(product.discovery)
                + personalization_reasons(product)
            )
            if failures:
                lines.append(
                    "  Unmet or unverified: "
                    + ", ".join(plain(f) for f in failures)
                    + "."
                )
            else:
                facts = list(plan.attributes)
                if plan.brand:
                    facts.append(Constraint(name="brand", value=plan.brand))
                if facts:
                    lines.append(
                        "  Verified: "
                        + ", ".join(
                            constraint_text(c)
                            + " ["
                            + ", ".join(
                                attribute_evidence(product, c.name, c.value).sources
                            )
                            + "]"
                            for c in facts
                        )
                        + "."
                    )
            verified_preferences = [
                c for c in plan.preferences if matches_attribute(product, c)
            ]
            if verified_preferences:
                lines.append(
                    "  Preference matches: "
                    + ", ".join(constraint_text(c) for c in verified_preferences)
                    + "."
                )
            if plan.intended_use:
                supported = matches_attribute(
                    product, Constraint(name="intended_use", value=plan.intended_use)
                )
                lines.append(
                    f"  Catalog lists intended use: {plain(plan.intended_use)}."
                    if supported
                    else f"  Suitability for {plain(plan.intended_use)} is not verified by the catalog."
                )
            if "explain_fit" in preferences and not failures:
                fit = []
                if plan.max_price is not None:
                    fit.append("meets your maximum budget")
                if plan.category and product.category_name:
                    fit.append(f"catalog category: {plain(product.category_name)}")
                if fit:
                    lines.append("  Why it matches: " + "; ".join(fit) + ".")
    if "tradeoffs" in preferences:
        compared = [product for product, _ in (exact or alternatives)[:limit]]
        currencies = {product.currency for product in compared}
        if len(compared) > 1 and len(currencies) == 1:
            amounts = [Decimal(product.price) for product in compared]
            lines.append(
                f"Listed price comparison: {min(amounts)}–{max(amounts)} {compared[0].currency} among these options."
            )
        lines.append(
            "Price alone does not establish performance or quality; I cannot verify tradeoffs that are absent from the catalog."
        )
    elif preferences.intersection({"uncertainty", "no_assumptions"}):
        lines.append(
            "I used listed catalog facts; unlisted features and suitability remain unverified."
        )
    lines.append(
        "Prices shown are current catalog prices. Tax and delivery may be added at checkout."
    )
    if not exact and plan.attributes:
        for constraint in plan.attributes:
            statuses = [
                "verified"
                if matches_attribute(p, constraint)
                else "unknown"
                if attribute_evidence(p, constraint.name, constraint.value).status
                == "unknown"
                else "contradicted"
                for p in products
            ]
            lines.append(
                f"Evidence for {constraint_text(constraint)}: "
                f"{statuses.count('verified')} verified, {statuses.count('contradicted')} contradicted, "
                f"{statuses.count('unknown')} unknown among checked candidates."
            )
    return "\n".join(lines)
