"""Bounded product facts from current storefront-visible catalog evidence."""

import json
import math
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.catalog import Attribute, Product


class ProductFactReader(Protocol):
    """Application supplies the current tenant's capability-scoped commerce reader."""

    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def product(self, product_id: UUID) -> dict[str, Any]: ...


@dataclass(frozen=True)
class FactSpec:
    label: str
    attributes: frozenset[str]


FACT_SPECS = MappingProxyType(
    {
        "PRODUCT_MATERIAL": FactSpec("Material", frozenset({"material", "metal"})),
        "PRODUCT_METAL_PURITY": FactSpec(
            "Metal purity", frozenset({"metal_purity", "purity", "fineness"})
        ),
        "PRODUCT_GEMSTONE": FactSpec("Gemstone", frozenset({"gemstone", "gemstones"})),
        "PRODUCT_INGREDIENTS": FactSpec(
            "Ingredients", frozenset({"ingredients", "ingredient_list"})
        ),
        "PRODUCT_ALLERGENS": FactSpec(
            "Allergen information", frozenset({"allergens", "allergen_statement"})
        ),
        "PRODUCT_ORIGIN": FactSpec(
            "Origin", frozenset({"origin", "country_of_origin"})
        ),
        "PRODUCT_DIMENSIONS": FactSpec("Dimensions", frozenset({"dimensions"})),
        "PRODUCT_NET_WEIGHT": FactSpec("Net weight", frozenset({"net_weight"})),
        "PRODUCT_STORAGE": FactSpec(
            "Storage instructions",
            frozenset({"storage_conditions", "storage_instructions"}),
        ),
        "PRODUCT_WARRANTY": FactSpec("Warranty", frozenset({"warranty"})),
        "PRODUCT_CERTIFICATION": FactSpec(
            "Certification", frozenset({"certification", "certifications"})
        ),
        "PRODUCT_CARE": FactSpec(
            "Care instructions", frozenset({"care", "care_instructions"})
        ),
        "PRODUCT_SERVING_SIZE": FactSpec("Serving size", frozenset({"serving_size"})),
        "PRODUCT_SHELF_LIFE": FactSpec("Shelf life", frozenset({"shelf_life"})),
    }
)
PRODUCT_FACT_INTENTS = frozenset(FACT_SPECS) | {
    "CHECK_PRICE",
    "CHECK_STOCK",
    "PRODUCT_DETAILS",
}
TRUSTED_SOURCES = frozenset({"VERIFIED", "MERCHANT", "IMPORTED"})


@dataclass(frozen=True)
class CatalogFact:
    label: str
    value: str | None
    status: Literal["known", "missing", "conflicting"]


def attribute_key(value: str) -> str:
    return re.sub(r"[\s-]+", "_", value.casefold().strip())


def _display_value(raw: str) -> str | None:
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw
    values = value if isinstance(value, list) else [value]
    if not values or len(values) > 20:
        return None
    parts = []
    for item in values:
        if not isinstance(item, (str, int, float, bool)) or (
            isinstance(item, float) and not math.isfinite(item)
        ):
            return None
        text = str(item).strip()
        if text.casefold() in {
            "",
            "unknown",
            "n/a",
            "not specified",
            "not available",
            "-",
        }:
            return None
        parts.append(text)
    return ", ".join(parts)


def catalog_fact(product: Product, intent: str) -> CatalogFact:
    """Never infer a specification from a name, another field, or model provenance."""
    spec = FACT_SPECS[intent]
    rows = [
        attr
        for attr in product.attributes
        if attribute_key(attr.name) in spec.attributes
        and attr.source in TRUSTED_SOURCES
    ]
    values = [_display_value(attr.value) for attr in rows]
    if not values or any(value is None for value in values):
        return CatalogFact(spec.label, None, "missing")
    if (
        len(
            {
                " ".join(value.casefold().split())
                for value in values
                if value is not None
            }
        )
        != 1
    ):
        return CatalogFact(spec.label, None, "conflicting")
    return CatalogFact(spec.label, values[0], "known")


def factual_product(product: Product) -> Product:
    """Cards on this read path also omit inferred, malformed and conflicting facts."""
    grouped: dict[str, list[Attribute]] = {}
    for attr in product.attributes:
        if attr.source in TRUSTED_SOURCES and attribute_key(attr.name):
            grouped.setdefault(attribute_key(attr.name), []).append(attr)
    # Alias fields represent the same fact; suppress every alias when their
    # combined evidence is missing or contradictory, matching the text answer.
    blocked = {
        name
        for intent, spec in FACT_SPECS.items()
        if catalog_fact(product, intent).status != "known"
        for name in spec.attributes
    }
    grouped = {name: rows for name, rows in grouped.items() if name not in blocked}
    accepted = []
    for rows in grouped.values():
        values = [_display_value(attr.value) for attr in rows]
        if (
            values
            and all(value is not None for value in values)
            and len(
                {
                    " ".join(value.casefold().split())
                    for value in values
                    if value is not None
                }
            )
            == 1
        ):
            accepted.append(rows[0])
    return product.model_copy(update={"attributes": accepted})
