"""Reviewed language examples and retrieval evidence, never action authority."""

import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ReadRecoveryPattern(BaseModel):
    """Reviewed command-prefix mapping; the complete suffix is customer data."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    # Initial grammar contains command-only spans, never product/constraint values.
    from_prefix: Literal[
        "could ya rustle up",
        "can ya rustle up",
        "rustle up",
        "i am hunting for",
        "i'm hunting for",
        "help me hunt for",
    ]
    to_prefix: Literal["find", "recommend"]

    def render(self, message: str) -> str | None:
        match = re.fullmatch(
            re.escape(self.from_prefix).replace(r"\ ", r"\s+") + r"\s+(.+)",
            message.strip(),
            re.IGNORECASE,
        )
        return f"{self.to_prefix} {match[1]}" if match else None


class ExampleReview(BaseModel):
    """Versioned reviewed semantics; context names carry no customer values."""

    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, allow_inf_nan=False
    )
    version: Literal[2] = 2
    recovery: ReadRecoveryPattern | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    label: Literal["positive", "negative", "ambiguous"]
    expected_status: Literal["RESOLVED", "UNKNOWN", "AMBIGUOUS", "NEEDS_CONTEXT"]
    slots: dict[str, str | int | float | bool] = Field(
        default_factory=dict, max_length=12
    )
    context_requirements: list[
        Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")]
    ] = Field(default_factory=list, max_length=8)
    family: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    split: Literal["train", "validation", "test"]
    provenance: Literal["authored", "synthetic", "reviewed-customer"]
    review_status: Literal["pending", "approved", "rejected"]

    @model_validator(mode="after")
    def coherent_label(self) -> "ExampleReview":
        if (self.label == "positive") != (self.expected_status == "RESOLVED"):
            raise ValueError("Positive examples require resolved semantics only")
        if self.label == "ambiguous" and self.expected_status not in {
            "AMBIGUOUS",
            "NEEDS_CONTEXT",
        }:
            raise ValueError("Ambiguity examples must abstain")
        return self


class IntentExample(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, allow_inf_nan=False
    )

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    intent: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,99}$")
    utterance: str = Field(min_length=1, max_length=350)
    canonical_text: str = Field(min_length=1, max_length=350)
    review: ExampleReview | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def reviewed_pattern(self) -> "IntentExample":
        if self.review and self.review.recovery:
            pattern = self.review.recovery
            expected = (
                "PRODUCT_SEARCH" if pattern.to_prefix == "find" else "PRODUCT_RECOMMEND"
            )
            if (
                self.intent != expected
                or self.review.label != "positive"
                or self.review.context_requirements
            ):
                raise ValueError(
                    "Recovery patterns require a context-free search/recommendation"
                )
            rendered = pattern.render(self.utterance)
            if rendered is None or " ".join(rendered.casefold().split()) != " ".join(
                self.canonical_text.casefold().split()
            ):
                raise ValueError(
                    "Recovery pattern must preserve the complete reviewed suffix"
                )
        return self


class IndexedIntentExample(IntentExample):
    schema_version: Literal["intent-example-v1", "intent-example-v2"]
    resolution_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def compatible_version(self) -> "IndexedIntentExample":
        if (self.schema_version == "intent-example-v2") != (self.review is not None):
            raise ValueError("Review metadata requires the v2 record")
        return self


class IntentEvidence(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, allow_inf_nan=False
    )

    example: IntentExample
    source_id: UUID
    revision: int = Field(ge=1)
    chunk_id: str = Field(min_length=1, max_length=64)
    embedding_score: float | None = Field(
        default=None, ge=-1, le=1, exclude_if=lambda value: value is None
    )
    validation_fingerprint: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=lambda value: value is None
    )
