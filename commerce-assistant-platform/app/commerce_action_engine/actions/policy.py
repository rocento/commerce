"""Exact approved policy answers. This path never invokes a model or retrieval."""

import json
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class PolicySource(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str = Field(pattern=r"^guide:[a-z0-9-]{1,64}$")
    title: str = Field(min_length=1, max_length=120)
    revision: int = Field(ge=1)
    approved_at: AwareDatetime
    valid_until: AwareDatetime
    effective_from: AwareDatetime | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    withdrawn_at: AwareDatetime | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    def current(self, now: datetime) -> bool:
        start = self.effective_from or self.approved_at
        return (
            self.approved_at <= now
            and start <= now < self.valid_until
            and (self.withdrawn_at is None or self.withdrawn_at > now)
        )

    @model_validator(mode="after")
    def validity(self) -> Self:
        if self.valid_until <= (self.effective_from or self.approved_at) or (
            self.effective_from and self.effective_from < self.approved_at
        ):
            raise ValueError("Guide validity must follow approval")
        return self


class PolicyAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    phrases: frozenset[str] = Field(min_length=1, max_length=20)
    answer: str = Field(min_length=1, max_length=2000)
    source: PolicySource | None = None


class PolicyAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["1", "2"] = "1"
    tenant_id: UUID | None = None
    answers: tuple[PolicyAnswer, ...] = Field(default=(), max_length=200)
    unknown_phrases: tuple[str, ...] = Field(default=(), max_length=50)

    @model_validator(mode="after")
    def scoped_sources(self) -> Self:
        if self.schema_version == "2" and (
            self.tenant_id is None or any(a.source is None for a in self.answers)
        ):
            raise ValueError("Version 2 guides require a tenant and dated sources")
        sources: dict[str, PolicySource] = {}
        for answer in self.answers:
            if answer.source:
                previous = sources.setdefault(answer.source.id, answer.source)
                if previous != answer.source:
                    raise ValueError("Conflicting exact guide source revisions")
        phrases = [self.normalize(p) for a in self.answers for p in a.phrases]
        phrases.extend(self.normalize(p) for p in self.unknown_phrases)
        if len(phrases) != len(set(phrases)):
            raise ValueError("Ambiguous exact guide phrases")
        return self

    def current_count(self, now: datetime | None = None) -> int:
        observed = now or datetime.now(UTC)
        return sum(1 for a in self.answers if a.source and a.source.current(observed))

    @staticmethod
    def normalize(value: str) -> str:
        return " ".join(unicodedata.normalize("NFC", value).casefold().split())

    def match(self, message: str, now: datetime | None = None) -> str | None:
        query = self.normalize(message)
        observed = now or datetime.now(UTC)
        for entry in self.answers:
            if query in {self.normalize(phrase) for phrase in entry.phrases}:
                if entry.source:
                    source = entry.source
                    if not source.current(observed):
                        return "This shopping guide is awaiting review. Please contact the store for current information."
                    period = (
                        f"effective {source.effective_from.date().isoformat()} through {source.valid_until.date().isoformat()}"
                        if source.effective_from
                        else f"reviewed {source.approved_at.date().isoformat()}"
                    )
                    return f"{entry.answer}\n\nSource: {source.title} ({source.id}@{source.revision}; {period})."
                return entry.answer
        if query in {self.normalize(p) for p in self.unknown_phrases}:
            return "I do not have an approved answer for that store policy. Please contact the store before relying on a policy or delivery promise."
        return None


def load(path: str, tenant_id: str = "") -> PolicyAnswers:
    if not path:
        return PolicyAnswers()
    try:
        result = PolicyAnswers.model_validate(json.loads(Path(path).read_text()))
        if result.schema_version == "2" and str(result.tenant_id) != tenant_id:
            raise ValueError("Guide tenant mismatch")
        return result
    except (OSError, UnicodeDecodeError, ValueError):
        raise ValueError("Invalid AI exact policy answers file") from None
