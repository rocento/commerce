"""Resolve broad recommendation queries against merchant-managed intended uses."""

import re

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product

from .contracts import Constraint, ShoppingIntent


class CatalogPurposeUnavailable(ValueError):
    """The understood purpose has no match in this store's managed options."""


def product_list_parts(plan: ShoppingIntent, schema: CatalogSchema) -> list[str]:
    """Admit a small bare-item list for fallback only after the full search fails.

    Do not split qualified phrases, quoted identities, or attribute values into
    independent requests: doing so could discard a customer's hard requirement.
    The original search takes precedence for compound names such as salt and pepper.
    """
    if (
        plan.presentation != "recommend"
        or plan.category_id
        or plan.required_product_ids
        or plan.unresolved_requirements
        or plan.shopping_context
        or plan.intended_use
    ):
        return []
    parts = re.split(r"\s+and\s+|\s*&\s*", plan.query.strip(), flags=re.IGNORECASE)
    if not 2 <= len(parts) <= 3 or any(
        not re.fullmatch(r"[A-Za-z]{2,40}", part) for part in parts
    ):
        return []
    # The language dictionary may label only the last item as the category.
    # A separate category restriction must remain mandatory.
    if plan.category and plan.category.casefold().removesuffix("s") not in {
        part.casefold().removesuffix("s") for part in parts
    }:
        return []
    values = {
        name.casefold()
        for definition in schema.attributes
        for option in definition.options
        for name in (option.code, option.label, *option.labels.values())
    }
    if any(part.casefold() in values for part in parts):
        return []
    return list(dict.fromkeys(part.casefold() for part in parts))


def purpose_groups(
    plan: ShoppingIntent, schema: CatalogSchema, purpose: Constraint | None
) -> list[Constraint]:
    """Merchant-ordered groups for broad purpose discovery, not product facts.

    Optional select field <purpose field>_<purpose option>_priority supplies up
    to three ordered groups. Concrete product/category requests never fan out.
    """
    if purpose is None or plan.query != "*" or plan.category or plan.sort_by:
        return []
    code = f"{purpose.name}_{purpose.value}_priority"
    fields = [
        d
        for d in schema.attributes
        if d.code == code
        and d.filterable
        and d.data_type == "select"
        and 1 <= len(d.options) <= 3
    ]
    if len(fields) != 1:
        return []
    return [Constraint(name=code, value=o.code) for o in fields[0].options]


def diversify_purpose_groups(
    ranked: list[tuple[Product, list[str]]], groups: list[Constraint]
) -> list[tuple[Product, list[str]]]:
    """Keep verified matches; alternate merchant groups without relaxing filters."""
    from .constraints import matches_attribute

    if not groups:
        return ranked
    buckets = [
        [item for item in ranked if matches_attribute(item[0], group)]
        for group in groups
    ]
    result, seen = [], set()
    for index in range(max((len(bucket) for bucket in buckets), default=0)):
        for bucket in buckets:
            if index < len(bucket) and bucket[index][0].id not in seen:
                result.append(bucket[index])
                seen.add(bucket[index][0].id)
    return result


def purpose_filter(
    plan: ShoppingIntent, schema: CatalogSchema, *, explicit: bool = False
) -> Constraint | None:
    """Return one unambiguous retrieval selector; never infer product suitability.

    Consume the entire query so product names, exclusions and unknown modifiers
    cannot disappear. Ordinary price/stock/attribute checks remain authoritative.
    Semantic tags narrow this recommendation's candidates, not health evidence.
    """
    if not plan.shopping:
        return None
    query = " ".join(
        ((plan.intended_use or "") if explicit else plan.query).casefold().split()
    ).strip(" .!?")
    query = re.sub(
        r"^(?:(?:something|somehing|anything|products?|items?|groceries|food|ingredients?)\s+)?for\s+",
        "",
        query,
    )
    matches = set()
    nearby = set()
    for definition in schema.attributes:
        if not definition.filterable or definition.semantic_role != "intended_use":
            continue
        for option in definition.options:
            names = {
                " ".join(name.replace("_", " ").casefold().split())
                for name in (option.code, option.label, *option.labels.values())
            }
            if query in names:
                matches.add((definition.code, option.code))
            # A whole single-word query may contain one missing, extra or
            # substituted letter. Match only a unique current merchant option.
            # Never correct a product phrase or weaken additional constraints.
            if (
                not explicit
                and query.isalpha()
                and len(query) >= 5
                and any(
                    name.isalpha() and len(name) >= 5 and _one_edit(query, name)
                    for name in names
                )
            ):
                nearby.add((definition.code, option.code))
    if not matches and len(nearby) == 1:
        matches = nearby
    if len(matches) != 1:
        if explicit:
            if not matches:
                raise CatalogPurposeUnavailable("No matching catalog purpose")
            raise ValueError("Unknown or ambiguous catalog purpose")
        return None
    name, value = matches.pop()
    return Constraint(name=name, value=value)


def _one_edit(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right)) == 1
    short, long = sorted((left, right), key=len)
    return any(long[:i] + long[i + 1 :] == short for i in range(len(long)))
