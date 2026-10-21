"""Bounded data contracts shared by the importer, database reader and evaluator."""

import hashlib
import json
from datetime import datetime
from typing import Annotated, Literal, Protocol
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

Key = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]{0,99}$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Scalar = StrictStr | StrictInt | StrictFloat | StrictBool


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


class Reviewed(Record):
    reviewed_at: AwareDatetime
    recheck_at: AwareDatetime
    review_method: Literal["human", "ai_assisted"]
    reviewer: str = Field(min_length=1, max_length=100)
    state: Literal["reviewed", "conflicted", "withdrawn"] = "reviewed"

    @model_validator(mode="after")
    def valid_dates(self) -> "Reviewed":
        if not self.reviewed_at < self.recheck_at:
            raise ValueError("Recheck must follow review")
        return self

    def current(self, now: datetime) -> bool:
        return self.state == "reviewed" and self.reviewed_at <= now < self.recheck_at


class Source(Reviewed):
    id: Key
    url: str = Field(pattern=r"^https://[^\s]+$", max_length=1000)
    title: str = Field(min_length=1, max_length=200)
    document_ref: str = Field(pattern=r"^sources/[a-z0-9-]+\.md$", max_length=150)
    document_sha256: Digest


class Requirement(Record):
    id: Key
    attribute: Key
    label: str = Field(min_length=1, max_length=120)
    operator: Literal["gte", "eq", "one_of"]
    value: Scalar | tuple[StrictStr, ...]
    unit: str | None = Field(default=None, max_length=30)
    source_ids: tuple[Key, ...] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def typed_operator(self) -> "Requirement":
        if self.operator == "gte" and (
            type(self.value) not in (int, float) or self.unit is None
        ):
            raise ValueError("Numeric thresholds require a number and explicit unit")
        if self.operator == "one_of" and (
            not isinstance(self.value, tuple) or not 1 <= len(self.value) <= 20
        ):
            raise ValueError("one_of requires bounded alternatives")
        if self.operator != "one_of" and isinstance(self.value, tuple):
            raise ValueError("Scalar operator requires a scalar")
        return self


class Profile(Reviewed):
    id: Key
    domain: Literal["electronics"]
    activity_values: tuple[Key, ...] = Field(min_length=1, max_length=10)
    product_terms: tuple[str, ...] = Field(min_length=1, max_length=10)
    label: str = Field(min_length=1, max_length=120)
    conditions: tuple[str, ...] = Field(min_length=1, max_length=10)
    limitations: str = Field(min_length=1, max_length=700)
    requirements: tuple[Requirement, ...] = Field(min_length=1, max_length=20)


class DomainPack(Record):
    executor: Literal["domain-evidence-v1"]
    revision: int = Field(ge=1)
    language: Literal["en"]
    sources: tuple[Source, ...] = Field(min_length=1, max_length=100)
    profiles: tuple[Profile, ...] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def references(self) -> "DomainPack":
        sources = {s.id for s in self.sources}
        if len(sources) != len(self.sources) or len(
            {p.id for p in self.profiles}
        ) != len(self.profiles):
            raise ValueError("Duplicate source/profile ID")
        for p in self.profiles:
            if len({r.id for r in p.requirements}) != len(p.requirements):
                raise ValueError("Duplicate requirement ID")
            if len({r.attribute for r in p.requirements}) != len(p.requirements):
                raise ValueError("Conflicting requirements need a new reviewed profile")
            if any(not set(r.source_ids) <= sources for r in p.requirements):
                raise ValueError("Unknown requirement source")
        return self

    @property
    def fingerprint(self) -> str:
        return digest(self.model_dump(mode="json"))


class ProductFact(Reviewed):
    id: UUID
    tenant_id: UUID
    product_id: UUID
    identity_sha256: Digest
    attribute: Key
    value: Scalar
    unit: str | None = Field(default=None, max_length=30)
    source_kind: Literal["manufacturer", "merchant"]
    source_url: str = Field(pattern=r"^https://[^\s]+$", max_length=1000)
    source_document_id: str = Field(min_length=1, max_length=150)


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode()
    ).hexdigest()


class EvidenceReader(Protocol):
    async def active_pack(self, tenant: UUID) -> DomainPack | None: ...

    async def product_facts(
        self, tenant: UUID, products: tuple[UUID, ...]
    ) -> tuple[ProductFact, ...]: ...
