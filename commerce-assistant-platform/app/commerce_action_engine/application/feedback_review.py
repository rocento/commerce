"""Operator-owned minimized feedback review; never publishes or executes data."""

import hashlib
import json
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class FailureRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    tenant_id: UUID
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: Literal[
        "UNKNOWN",
        "NEEDS_CONTEXT",
        "AMBIGUOUS",
        "UNSUPPORTED",
        "DENIED",
        "INVALID",
        "UNAVAILABLE",
        "RESOLVED",
    ]
    actual_intent: str | None = Field(default=None, pattern=r"^[A-Z][A-Z_]{1,63}$")
    expected_intent: str | None = Field(default=None, pattern=r"^[A-Z][A-Z_]{1,63}$")
    evidence_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    expires_at: AwareDatetime

    @property
    def key(self) -> str:
        # Tenant and evidence release form part of identity; no raw utterance,
        # customer identifier, address or free-form reviewer note is accepted.
        payload = self.model_dump(mode="json", exclude={"expires_at"})
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


class ReviewEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    record_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewer_id: UUID
    at: AwareDatetime
    decision: Literal["approved", "rejected", "proposed"]
    artifact_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    regression_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def proposal_evidence(self) -> Self:
        if self.decision == "proposed" and (
            not self.artifact_sha256 or not self.regression_sha256
        ):
            raise ValueError(
                "Proposal requires reviewed artifact and regression evidence"
            )
        if self.decision != "proposed" and (
            self.artifact_sha256 or self.regression_sha256
        ):
            raise ValueError("Release hashes belong only to a proposal")
        return self


class ReviewQueue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal[1] = 1
    tenant_id: UUID
    records: tuple[FailureRecord, ...] = Field(default=(), max_length=1000)
    events: tuple[ReviewEvent, ...] = Field(default=(), max_length=3000)

    @model_validator(mode="after")
    def valid_history(self) -> Self:
        keys = {record.key for record in self.records}
        if len(keys) != len(self.records) or any(
            r.tenant_id != self.tenant_id for r in self.records
        ):
            raise ValueError("Duplicate or foreign feedback record")
        state: dict[str, str] = {}
        times: dict[str, datetime] = {}
        for event in self.events:
            if event.record_key not in keys:
                raise ValueError("Unknown feedback record")
            if event.record_key in times and event.at < times[event.record_key]:
                raise ValueError("Review time moved backwards")
            previous = state.get(event.record_key)
            if (
                previous is None and event.decision not in {"approved", "rejected"}
            ) or (
                previous is not None
                and not (previous == "approved" and event.decision == "proposed")
            ):
                raise ValueError("Invalid review transition")
            state[event.record_key] = event.decision
            times[event.record_key] = event.at
        return self

    def update(
        self,
        *,
        now: datetime,
        records: Iterable[FailureRecord] = (),
        events: Iterable[ReviewEvent] = (),
        delete: Iterable[str] = (),
    ) -> "ReviewQueue":
        events = tuple(events)
        expired = {r.key for r in self.records if r.expires_at <= now} | set(delete)
        merged = {r.key: r for r in self.records if r.key not in expired}
        for record in records:
            if (
                record.tenant_id != self.tenant_id
                or record.expires_at <= now
                or (
                    record.key not in merged
                    and record.expires_at > now + timedelta(days=30)
                )
            ):
                raise ValueError("Foreign or expired feedback")
            if record.key in expired:
                raise ValueError(
                    "Deleted record cannot be reintroduced in the same update"
                )
            # Duplicate imports cannot extend retention.
            if (
                record.key not in merged
                or record.expires_at < merged[record.key].expires_at
            ):
                merged[record.key] = record
        for event in events:
            if event.at > now or event.record_key not in merged:
                raise ValueError("Future review or missing/expired feedback")
        return ReviewQueue(
            tenant_id=self.tenant_id,
            records=tuple(merged.values()),
            events=tuple(e for e in self.events if e.record_key not in expired)
            + tuple(events),
        )
