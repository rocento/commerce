"""Opt-in English query repairs; explicit and schema-backed constraints stay hard."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_resolution_engine.contracts import Message

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.shopping import ShoppingIntent


from app.commerce_resolution_engine.prompts import (
    GROUNDED_EXTRACTION,
)

INSTRUCTIONS = GROUNDED_EXTRACTION


def english_query(message: str) -> bool:
    # Arabic and Arabic-containing mixed-language behavior is outside this rollout.
    return not re.search(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]", message)


def words(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def contains_phrase(text: str, phrase: str) -> bool:
    return bool(words(phrase)) and f" {words(phrase)} " in f" {words(text)} "


def refine_query(
    plan: ShoppingIntent,
    message: str,
    schema: CatalogSchema,
    history: tuple[Message, ...],
) -> list[str]:
    """Return name phrases to independently verify after retrieval, never brand facts."""
    if not english_query(message):
        return []
    required_names = []
    customer_text = (
        "\n".join(m.text for m in history if m.role == "user") + "\n" + message
    )
    brand_fields = [
        d
        for d in schema.attributes
        if d.semantic_role == "brand" or d.code.casefold() == "brand"
    ]
    if plan.brand and not brand_fields:
        brand = plan.brand
        explicit = re.search(
            r"\b(?:brand|branded|manufacturer|made by)\b", customer_text, re.IGNORECASE
        ) or re.search(
            r"\b(?:by|from|only|must be)\s+" + re.escape(brand) + r"(?!\w)",
            customer_text,
            re.IGNORECASE,
        )
        if not explicit:
            # Preserve literal product-name words even when the provider mislabels
            # them as a brand. Matching a name never establishes brand provenance.
            if contains_phrase(customer_text, brand):
                query = (
                    plan.query
                    if contains_phrase(plan.query, brand)
                    else (brand + " " + plan.query).strip()
                )
                if len(query) > 200:
                    return []  # Keep the original hard constraint on oversized repairs.
                plan.query = query
                required_names.append(brand)
            plan.brand = None
    gift_type = re.search(
        r"\bgift(?:s)?[ -]+(?:cards?|baskets?|boxes|box|sets?|wrap(?:ping|ped)?|bags?|certificates?|vouchers?)\b",
        message,
        re.IGNORECASE,
    )
    managed_category = (
        plan.category
        and contains_phrase(customer_text, plan.category)
        and (
            any(
                words(plan.category) in {words(c.name), *(words(a) for a in c.aliases)}
                for c in schema.categories
            )
            or any(
                d.semantic_role == "classification"
                and any(
                    words(plan.category) in {words(o.code), words(o.label)}
                    for o in d.options
                )
                for d in schema.attributes
            )
        )
    )
    if (
        re.search(r"\bgifts?\b", message, re.IGNORECASE)
        and not gift_type
        and not managed_category
        and not re.search(
            r"\b(?:not|no|without|exclude)\s+(?:a\s+)?gifts?\b", message, re.IGNORECASE
        )
    ):
        # Strip only the occasion word. Material, item type, brand, packaging,
        # stock and all monetary constraints remain in force.
        plan.query = (
            re.sub(r"(?<!\S)gifts?\s*$", "", plan.query, flags=re.IGNORECASE).strip()
            or "*"
        )
        plan.query = " ".join(plan.query.split())
        if plan.category:
            if not contains_phrase(customer_text, plan.category):
                # A model may invent 'gift set' for an ordinary product-as-gift.
                # Do not impose that absent product type. Keep a literal named
                # product phrase hard, so noisy retrieval cannot broaden the item.
                plan.category = None
                if contains_phrase(customer_text, plan.query):
                    required_names.append(plan.query)
            else:
                plan.category = (
                    " ".join(
                        re.sub(
                            r"(?<!\S)gifts?\s*$", "", plan.category, flags=re.IGNORECASE
                        ).split()
                    )
                    or None
                )
    return required_names
