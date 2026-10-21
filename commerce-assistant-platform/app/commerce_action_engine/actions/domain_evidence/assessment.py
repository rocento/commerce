"""Deterministic, order-independent requirement comparison against current catalog facts."""

import json
import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product

from .contracts import DomainPack, ProductFact, Profile, Requirement, digest


@dataclass(frozen=True)
class Check:
    requirement_id: str
    status: Literal["verified", "unmet", "unknown"]
    reason: str
    source_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Assessment:
    profile_id: str
    product_id: str
    status: Literal["verified", "unmet", "unknown"]
    checks: tuple[Check, ...]
    release: str


def product_identity(product: Product) -> str:
    # Deliberately excludes dynamic price/stock and individual facts. Those are
    # read afresh and each required value is compared with its own attestation.
    return digest(
        {
            "id": str(product.id),
            "sku": product.sku,
            "name": product.name,
            "category_id": str(product.category_id),
            "category_ids": sorted(str(v) for v in product.category_ids),
            "category_name": product.category_name,
            "category_names": sorted(product.category_names),
            "product_type": product.product_type,
        }
    )


def product_in_scope(product: Product, profile: Profile) -> bool:
    # Product titles such as "laptop sleeve" cannot establish category membership.
    categories = {
        c.strip().casefold() for c in [product.category_name, *product.category_names]
    }
    return (
        bool(categories.intersection(profile.product_terms))
        and product.product_type == "simple"
    )


def _value(raw: str) -> Any:
    try:
        return json.loads(raw, parse_constant=lambda value: None)
    except ValueError:
        return raw


def _check(
    req: Requirement,
    product: Product,
    schema: CatalogSchema,
    facts: tuple[ProductFact, ...],
    tenant: UUID,
    now: datetime,
) -> Check:
    def result(
        status: Literal["verified", "unmet", "unknown"],
        reason: str,
        ids: Iterable[str] = (),
    ) -> Check:
        return Check(req.id, status, reason, req.source_ids, tuple(sorted(ids)))

    definitions = [d for d in schema.attributes if d.code == req.attribute]
    if len(definitions) != 1 or definitions[0].unit != req.unit:
        return result("unknown", "missing_or_mismatched_unit_schema")
    rows = [
        a
        for a in product.attributes
        if a.name == req.attribute and a.source in {"VERIFIED", "MERCHANT", "IMPORTED"}
    ]
    if not rows:
        return result("unknown", "missing_authoritative_catalog_fact")
    values = [_value(row.value) for row in rows]
    if any(
        type(v) not in (str, int, float, bool)
        or (type(v) is float and not math.isfinite(v))
        for v in values
    ):
        return result("unknown", "malformed_catalog_fact")
    if len({digest(v) for v in values}) != 1:
        return result("unknown", "conflicting_catalog_facts")
    current = values[0]
    scoped = [
        f
        for f in facts
        if f.tenant_id == tenant
        and f.product_id == product.id
        and f.attribute == req.attribute
        and f.identity_sha256 == product_identity(product)
    ]
    # Withdrawn/conflicted evidence must not be overridden by a matching row.
    if any(f.state != "reviewed" for f in scoped):
        return result(
            "unknown", "withdrawn_or_conflicted_evidence", (str(f.id) for f in scoped)
        )
    eligible = [f for f in scoped if f.current(now)]
    if not eligible:
        return result("unknown", "missing_or_expired_product_evidence")
    ids = tuple(str(f.id) for f in eligible)
    if any(f.unit != req.unit or digest(f.value) != digest(current) for f in eligible):
        return result("unknown", "conflicting_or_changed_product_evidence", ids)
    if req.operator == "gte":
        if type(current) not in (int, float) or not Decimal(str(current)).is_finite():
            return result("unknown", "non_numeric_catalog_fact", ids)
        matches = Decimal(str(current)) >= Decimal(str(req.value))
    elif req.operator == "one_of":
        if type(current) is not str or not isinstance(req.value, tuple):
            return result("unknown", "wrong_catalog_fact_type", ids)
        matches = current in req.value
    else:
        if type(req.value) in (int, float) and type(current) in (int, float):
            matches = Decimal(str(current)) == Decimal(str(req.value))
        elif type(current) is not type(req.value):
            return result("unknown", "wrong_catalog_fact_type", ids)
        else:
            matches = current == req.value
    return result(
        "verified" if matches else "unmet",
        "meets_requirement" if matches else "below_or_different_requirement",
        ids,
    )


def assess(
    pack: DomainPack,
    profile: Profile,
    product: Product,
    schema: CatalogSchema,
    facts: tuple[ProductFact, ...],
    tenant: UUID,
    now: datetime,
) -> Assessment:
    sources = {source.id: source for source in pack.sources}
    checks: tuple[Check, ...]
    if schema.industry != profile.domain or not product_in_scope(product, profile):
        checks = (Check("product", "unknown", "product_outside_profile_scope", ()),)
    elif (
        profile not in pack.profiles
        or not profile.current(now)
        or any(
            not sources[source].current(now)
            for req in profile.requirements
            for source in req.source_ids
        )
    ):
        checks = (Check("profile", "unknown", "profile_or_source_not_current", ()),)
    else:
        checks = tuple(
            _check(req, product, schema, facts, tenant, now)
            for req in profile.requirements
        )
    # Incomplete/conflicting evidence remains explicitly unknown, even if another
    # requirement is known to fail; individual failed checks remain visible.
    status: Literal["verified", "unmet", "unknown"] = (
        "unknown"
        if any(c.status == "unknown" for c in checks)
        else "unmet"
        if any(c.status == "unmet" for c in checks)
        else "verified"
    )
    return Assessment(profile.id, str(product.id), status, checks, pack.fingerprint)
