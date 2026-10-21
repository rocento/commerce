"""Deterministic bridge from known language-engine search intents to catalog plans.

This module maps semantic query fields only. Catalog eligibility, market currency,
price, stock, and verified product facts remain owned by the commerce catalog.
"""

import re
from typing import Any, Protocol, Self

from app.commerce_action_engine.contracts.interpretation import Confidence


class DiscoveryInput(Protocol):
    """Validated semantic fields; no wire envelope or execution authority."""

    @property
    def status(self) -> str: ...

    @property
    def confidence(self) -> Confidence: ...

    @property
    def legacy_intent(self) -> str | None: ...

    @property
    def request_type(self) -> str | None: ...

    @property
    def requires_confirmation(self) -> bool: ...

    @property
    def entities(self) -> dict[str, Any]: ...


class ShoppingIntentType(Protocol):
    @classmethod
    def model_validate(cls, value: Any) -> Self: ...


RECOMMENDATION_CATEGORY_TERMS = frozenset(
    {
        "fruit",
        "vegetable",
        "dates",
        "cereal",
        "snacks",
        "meat",
        "seafood",
        "bakery",
        "dairy",
        "running_shoes",
        "shoes",
        "shirt",
        "jeans",
        "jacket",
        "dress",
        "socks",
        "sweater",
        "phone",
        "laptop",
        "headphones",
        "tablet",
        "keyboard",
        "monitor",
        "speaker",
        "milk",
        "rice",
        "coffee",
        "tea",
        "bread",
        "olive_oil",
        "pasta",
        "cream",
        "shampoo",
        "sunscreen",
        "lipstick",
        "conditioner",
        "vitamins",
        "bandages",
        "thermometer",
        "ring",
        "necklace",
        "bracelet",
        "earrings",
        "sofa",
        "chair",
        "table",
        "curtains",
        "towels",
        "rug",
        "tires",
        "motor_oil",
        "wiper_blades",
        "car_battery",
        "bolts",
        "screws",
        "safety_gloves",
        "packing_tape",
    }
)


def search_constraint_text(entities: dict[str, Any], message: str) -> str:
    if "shoppingContext" in entities:
        from app.commerce_action_engine.actions.shopping.context import (
            contextual_message,
            verified_context,
        )

        return contextual_message(
            verified_context(entities["shoppingContext"], message), message
        )
    # A whole explicitly quoted product name is data, including words such as
    # "without" or "under $20". Only trust this scope when the engine retained
    # exactly that literal as its sole entity; other constraints remain guarded.
    literal = re.fullmatch(
        r'\s*(?:please\s+)?(?:search\s+for|look\s+for|find|show\s+me)\s+"([^"\n]+)"\s*[.!?]?\s*',
        message,
        re.IGNORECASE,
    )
    constraint_message = message
    if (
        literal
        and set(entities) == {"productText"}
        and " ".join(literal[1].lower().split()) == entities["productText"]
    ):
        constraint_message = ""
    return constraint_message


def _contextual_budget_connector(entities: dict[str, Any], message: str) -> str:
    """A proven money suffix is a price bound, not a product 'with' attribute.

    Keep the numeric source in the constraint message so ordinary bound and
    currency intersection remains authoritative. No unmatched tail is removed.
    """
    if "shoppingContext" not in entities:
        return message
    price = entities.get("price")
    if not isinstance(price, dict) or price.get("operator") not in {"<=", "BETWEEN"}:
        return message
    from decimal import Decimal, InvalidOperation

    from app.commerce_action_engine.actions.shopping.context import (
        published_budget_rules,
    )
    from app.commerce_action_engine.actions.shopping.pricing import iter_price_bounds

    # Match complete published literal templates, then prove both values against
    # the ordinary money reader. Unmatched words and mixed currencies stay intact.
    for rule in published_budget_rules():
        expected_operator = "BETWEEN" if rule["output"] == "price_range" else "<="
        if price["operator"] != expected_operator:
            continue
        for template in rule["templates"]:
            parts = re.split(r"(\{(?:amount|min|max)\})", template)
            pattern = "".join(
                rf"(?P<{part[1:-1]}>.{{1,100}}?)"
                if part.startswith("{")
                else re.escape(part).replace(r"\ ", r"\s+")
                for part in parts
            )
            head = re.search(
                r"\bwith\s+" + pattern + r"[.!?]*\s*$", message, re.IGNORECASE
            )
            if not head:
                continue
            canonical = (
                "between " + head["min"] + " and " + head["max"]
                if expected_operator == "BETWEEN"
                else "at most " + head["amount"]
            )
            try:
                bounds = iter_price_bounds(canonical)
                expected = (
                    [("gte", price.get("min")), ("lte", price.get("max"))]
                    if expected_operator == "BETWEEN"
                    else [("lte", price.get("value"))]
                )
                if (
                    len(bounds) != len(expected)
                    or any(
                        bound.operator != operator
                        or Decimal(bound.amount) != Decimal(str(value))
                        or bound.currency is not None
                        and price.get("currency") != bound.currency
                        for bound, (operator, value) in zip(bounds, expected)
                    )
                    or not bounds
                    or bounds[0].start != 0
                    or bounds[-1].end != len(canonical)
                ):
                    continue
            except (ValueError, InvalidOperation):
                continue
            return message[: head.start()] + canonical
    if price["operator"] != "<=":
        return message

    for head in re.finditer(
        r"\bwith\s+(?:(?:a|my|our|the)\s+)?(?:budget|limit)(?:\s+(?:of|is))?\s+",
        message,
        re.IGNORECASE,
    ):
        tail = "at most " + message[head.end() :]
        try:
            bounds = iter_price_bounds(tail)
            if (
                len(bounds) != 1
                or bounds[0].start != 0
                or bounds[0].operator != "lte"
                or re.fullmatch(r"[\s.!?]*", tail[bounds[0].end :]) is None
                or Decimal(bounds[0].amount) != Decimal(str(price.get("value")))
                or price.get("currency") is not None
                and price["currency"] != bounds[0].currency
            ):
                continue
        except (ValueError, InvalidOperation):
            continue
        return message[: head.start()] + tail
    return message


def broad_value_request(message: str) -> bool:
    """Only an unconstrained whole request permits a disclosed price-first default."""
    return bool(
        re.fullmatch(
            r"\s*(?:(?:please|pls|plz)\s+)?(?:recommend|suggest|show)(?:\s+me)?"
            r"\s+(?:the\s+)?(?:best[ -]value|best\s+value\s+for\s+money)"
            r"\s+(?:products|items)(?:\s+please)?[.!?\s]*",
            message,
            re.IGNORECASE,
        )
    )


def map_discovery_request[IntentT: ShoppingIntentType](
    result: DiscoveryInput | None, message: str, intent_type: type[IntentT]
) -> IntentT | None:
    """Build the existing ShoppingIntent contract for a safe, supported search.

    Return None when the request contains unsupported semantics so the caller can
    keep its established deterministic clarification/fallback behavior.
    """
    if (
        result is None
        or result.status != "RESOLVED"
        or result.confidence.raw < 0.65
        or result.request_type
        or "requestConstraints" in result.entities
        or (result.requires_confirmation and result.legacy_intent != "ADD_TO_WISHLIST")
        or result.legacy_intent
        not in {
            "PRODUCT_SEARCH",
            "PRODUCT_RECOMMEND",
            "ADD_TO_CART",
            "PRODUCT_REVIEWS",
            "PRODUCT_RATING",
            "PRODUCT_PHOTOS",
            "PRODUCT_VIDEO",
            "PRODUCT_MANUAL",
            "PRODUCT_ALLERGENS",
            "PRODUCT_NUTRITION",
            "PRODUCT_SIZE_GUIDE",
            "ADD_TO_WISHLIST",
        }
    ):
        return None
    # Value is a comparison goal, not a literal product name or proof of quality.
    # Keep this whole-request rule bounded so extra constraints/actions are preserved.
    if result.legacy_intent in {
        "PRODUCT_RECOMMEND",
        "PRODUCT_SEARCH",
    } and broad_value_request(message):
        return intent_type.model_validate(
            {
                "shopping": True,
                "query": "*",
                "sort_by": "price_asc",
                "in_stock": True,
            }
        )
    if "evidenceRequirements" in result.entities:
        from app.commerce_action_engine.actions.shopping.evidence import (
            requirement_clarification,
        )

        clarification = requirement_clarification(
            result.entities["evidenceRequirements"], message
        )
        if clarification and result.legacy_intent in {
            "PRODUCT_SEARCH",
            "PRODUCT_RECOMMEND",
        }:
            return intent_type.model_validate(
                {"shopping": True, "query": "", "clarification": clarification}
            )
        return None
    if "shoppingContext" in result.entities and result.legacy_intent not in {
        "PRODUCT_SEARCH",
        "PRODUCT_RECOMMEND",
    }:
        return None
    try:
        constraint_message = _contextual_budget_connector(
            result.entities, search_constraint_text(result.entities, message)
        )
    except ValueError:
        return None
    explicit_attribute = (
        result.legacy_intent == "PRODUCT_RECOMMEND"
        and result.entities.get("productText") == "*"
        and re.search(
            # The language engine has retained a complete generic attribute
            # request. Polite question wrappers do not change its requirements.
            r"\b(?:products|items)\s+with\s+(?:color|size|material|flavor)\s+[\w -]+[.!?]*\s*$",
            message,
            re.IGNORECASE,
        )
    )
    if re.search(
        r"\b(without|except|not|must|allerg\w*|vegan|organic|gluten)\b"
        if explicit_attribute
        else r"\b(with|without|except|not|must|allerg\w*|vegan|organic|gluten)\b",
        constraint_message,
        re.IGNORECASE,
    ):
        return None
    entities = dict(result.entities)
    entities.pop("recommendationFollowup", None)
    entities.pop("excludedProducts", None)
    entities.pop("cheaperReferences", None)
    merchant_attributes = entities.pop("merchantAttributes", [])
    if (
        not isinstance(merchant_attributes, list)
        or len(merchant_attributes) > 10
        or any(
            not isinstance(attribute, dict)
            or set(attribute) != {"name", "value"}
            or not all(
                isinstance(value, str) and value.strip() for value in attribute.values()
            )
            for attribute in merchant_attributes
        )
    ):
        return None
    items = entities.pop("items", None)
    if items is not None and items != [{"productText": entities.get("productText")}]:
        return None
    if entities.get("sort_by") not in {None, "price_asc", "price_desc"}:
        return None
    if set(entities) - {
        "productText",
        "catalogPurpose",
        "giftContext",
        "shoppingContext",
        "category",
        "color",
        "brand",
        "material",
        "flavor",
        "size",
        "price",
        "currency",
        "quantity",
        "destination",
        "sort_by",
    }:
        return None
    expected_destination = (
        "wishlist" if result.legacy_intent == "ADD_TO_WISHLIST" else "cart"
    )
    if entities.get("destination", expected_destination) != expected_destination:
        return None
    category = entities.get("category")
    query = entities.get("productText") or category or ""
    if result.legacy_intent == "PRODUCT_RECOMMEND":
        query = re.sub(
            r"^(?:(?:the|some)\s+)?(?:best|top|great|good|popular|recommended)\s+",
            "",
            query.strip(),
            flags=re.IGNORECASE,
        )
        # Attribute-only requests browse using verified filters, not attribute words as names.
        remainder = query
        for key in ("color", "material", "size", "flavor"):
            value = entities.get(key)
            if isinstance(value, str):
                remainder = re.sub(
                    r"^" + re.escape(value) + r"\s+", "", remainder, flags=re.IGNORECASE
                )
        if (
            remainder.casefold() in {"products", "items", "product", "item"}
            or "catalogPurpose" not in entities
            and category in RECOMMENDATION_CATEGORY_TERMS
            and _same_category_query(remainder, category)
        ):
            query = "*"
        # Category-only recommendations should fan out across products of that
        # class, not search their names for a category word.
        if (
            "catalogPurpose" not in entities
            and category
            and category in RECOMMENDATION_CATEGORY_TERMS
            and _same_category_query(query, category)
        ):
            query = "*"
    if entities.get("sort_by") in {"price_asc", "price_desc"} and isinstance(
        query, str
    ):
        query = re.sub(
            r"^(?:the\s+)?cheapest\s+", "", query.strip(), flags=re.IGNORECASE
        )
        if query.casefold() in {"items", "products", "things"} or (
            category in RECOMMENDATION_CATEGORY_TERMS
            and _same_category_query(query, category)
        ):
            query = "*"
    if entities.get("giftContext") and query in {"products", "items"}:
        query = "*"
    if not isinstance(query, str) or not query.strip():
        return None
    data: dict[str, Any] = {
        "shopping": True,
        "gift_context": entities.get("giftContext"),
        "shopping_context": entities.get("shoppingContext"),
        "sort_by": entities.get("sort_by"),
        "presentation": "recommend"
        if result.legacy_intent == "PRODUCT_RECOMMEND"
        else "search",
        "query": query,
        "intended_use": entities.get("catalogPurpose"),
        "category": category,
        "brand": entities.get("brand"),
        "attributes": merchant_attributes
        + [
            {"name": key, "value": str(entities[key])}
            for key in ("color", "material", "size", "flavor")
            if key in entities
        ],
    }
    price = entities.get("price")
    if price:
        if not isinstance(price, dict):
            return None
        operator = price.get("operator")
        if operator not in {"<", "<=", ">", ">=", "=", "BETWEEN"}:
            return None
        data["currency"] = price.get("currency") or entities.get("currency")
        # Omitted currency is supplied by the authoritative store market at
        # execution time, not guessed by the language engine or the model.
        if operator in {"<", "<=", "="}:
            data["max_price"] = str(price.get("value"))
        if operator in {">", ">=", "="}:
            data["min_price"] = str(price.get("value"))
            data["exclusive_min"] = operator == ">"
        if operator == "BETWEEN":
            data.update(
                min_price=str(price.get("min")), max_price=str(price.get("max"))
            )
        data["exclusive_max"] = operator == "<"
    try:
        from app.commerce_action_engine.actions.shopping.pricing import (
            retain_price_bounds,
        )

        return intent_type.model_validate(retain_price_bounds(data, constraint_message))
    except ValueError:
        # Retain a deterministic clarification instead of silently relaxing a range.
        return intent_type.model_validate(
            {
                "shopping": True,
                "query": query,
                "clarification": "Please clarify the price range using one currency and a non-empty range.",
            }
        )


def _same_category_query(query: str, category: str) -> bool:
    def singular(value: str) -> str:
        words = re.sub(r"[^\w\s-]", " ", value.casefold().replace("_", " ")).split()
        return " ".join(
            word[:-1] if len(word) > 3 and word.endswith("s") else word
            for word in words
        )

    return singular(query) == singular(category)
