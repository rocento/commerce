"""Versioned, bounded discovery evidence; never a substitute for product eligibility."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_CATALOG_RESULTS = 8


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Relationship(DTO):
    id: UUID
    product_id: UUID
    relation: Literal[
        "belongs_to",
        "variant_of",
        "compatible_with",
        "incompatible_with",
        "substitutes",
        "complements",
        "required_accessory",
        "used_for",
        "occasion",
        "contains",
        "excludes",
        "selling_unit",
        "policy_restriction",
        "synonym",
    ]
    target_product_id: UUID | None
    value: str = Field(min_length=1, max_length=160)
    dimensions: dict[str, str] = Field(max_length=10)
    source: Literal["merchant", "imported", "generated"]
    reviewed: Literal[True]
    updated_at: datetime
    expires_at: datetime


class Offer(DTO):
    product_id: UUID
    parent_id: UUID | None
    category_id: UUID
    price: str = Field(pattern=r"^\d{1,12}(\.\d{1,6})?$")
    currency: str = Field(min_length=3, max_length=3)
    selling_unit: str = Field(max_length=100)
    in_stock: bool | None
    observed_at: datetime
    expires_at: datetime


class Contribution(DTO):
    code: str = Field(min_length=1, max_length=64, pattern=r"^[a-z_]+$")
    points: int = Field(ge=-10000, le=10000)


class Discovery(DTO):
    schema_version: Literal["1.0.0"]
    rank: int = Field(ge=1, le=MAX_CATALOG_RESULTS)
    score: int = Field(ge=-100000, le=100000)
    contributions: list[Contribution] = Field(max_length=10)
    sponsored: bool
    merchant_boost: int = Field(ge=0, le=10)
    offer: Offer
    relationships: list[Relationship] = Field(max_length=10)

    @model_validator(mode="after")
    def validate_evidence(self) -> "Discovery":
        if sum(c.points for c in self.contributions) != self.score:
            raise ValueError("Ranking contributions must account for the score")
        if (
            self.offer.observed_at.tzinfo is None
            or self.offer.expires_at.tzinfo is None
        ):
            raise ValueError("Offer timestamps must include a timezone")
        if (
            not 0
            < (self.offer.expires_at - self.offer.observed_at).total_seconds()
            <= 30
        ):
            raise ValueError("Offer evidence must be bounded to thirty seconds")
        if any(e.product_id != self.offer.product_id for e in self.relationships):
            raise ValueError("Relationship evidence must belong to this product")
        return self


class DiscoveryReport(DTO):
    schema_version: Literal["1.0.0"]
    retrieval: str = Field(max_length=200)
    ranker: str = Field(max_length=200)
    lexical_candidates: int = Field(ge=0, le=20)
    relation_candidates: int = Field(ge=0, le=20)
    evaluated: int = Field(ge=0, le=40)
    eligible: int = Field(ge=0, le=40)
    returned: int = Field(ge=0, le=MAX_CATALOG_RESULTS)
    exhaustive: Literal[False]
    semantic_enabled: Literal[False]
    outcome: Literal[
        "bounded_no_candidates",
        "current_facts_filtered",
        "availability_unknown",
        "matches",
    ]

    @model_validator(mode="after")
    def validate_counts(self) -> "DiscoveryReport":
        if not self.returned <= self.eligible <= self.evaluated:
            raise ValueError("Invalid discovery counts")
        return self


def labels(discovery: Discovery | None) -> list[str]:
    if discovery is None:
        return []
    result = []
    if discovery.sponsored:
        result.append("Sponsored listing")
    if discovery.merchant_boost:
        result.append("Merchant promotion influences ranking")
    return result


def no_match(report: DiscoveryReport | None) -> str:
    base = (
        "I couldn’t find products matching your request in this store. "
        "Try a different product name, category, or feature."
    )
    if report is not None and report.outcome == "availability_unknown":
        return base + " Delivery availability could not be verified for this location."
    return base
