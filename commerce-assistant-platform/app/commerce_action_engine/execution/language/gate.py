"""Untrusted language JSON selects allowlisted plans, never authorizes commerce writes."""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    PrivateAttr,
    ValidationError,
    model_validator,
)

from app.commerce_action_engine.contracts.interpretation import (
    Action,
    Clause,
    Confidence,
    Fingerprint,
    InterpretationProvenance,
    Name,
    Reference,
    Relationship,
    ResolvedAmbiguity,
    ResolvedSlot,
    SemanticGraph,
    validate_clause_spans,
)
from app.commerce_action_engine.contracts.requested_actions import (
    RequestedActionMetadata,
)
from app.commerce_action_engine.execution.planning.compound_review import (
    ReviewSemantics,
)
from app.commerce_action_engine.execution.planning.interpretation_holds import (
    normalize_holds,
)
from app.commerce_resolution_engine.boundaries import boundary
from app.commerce_resolution_engine.diagnostics import debug_record, traced


class Resolution(RequestedActionMetadata):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)
    # Assigned only after envelope validation, never read from legacy JSON.
    _provenance: InterpretationProvenance = PrivateAttr(
        default_factory=InterpretationProvenance
    )
    status: Literal[
        "RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "UNKNOWN", "UNSUPPORTED", "DENIED"
    ]
    intent: Name | None = None
    message: str = Field(max_length=1000)
    confidence: float = Field(ge=0, le=1)
    confidenceLevel: Literal["HIGH", "MEDIUM", "LOW", "AMBIGUOUS"] | None = None
    entities: dict[str, Any] = Field(default_factory=dict)
    requiresConfirmation: bool = False
    requestType: Name | None = None
    missing: list[Name] = Field(default_factory=list, max_length=128)
    primaryIntent: Name | None = None
    reason: Literal["unsupported_capability", "access_denied"] | None = None
    unsupportedIntents: list[Name] = Field(default_factory=list, max_length=32)
    operations: list[Name] = Field(default_factory=list, max_length=66)
    references: list[Reference] = Field(default_factory=list, max_length=128)
    actions: list[Action] = Field(default_factory=list, max_length=66)
    clauses: list[Clause] = Field(default_factory=list, max_length=33)
    relationships: list[Relationship] = Field(default_factory=list, max_length=256)
    slots: list[ResolvedSlot] = Field(default_factory=list, max_length=64)
    ambiguities: list[ResolvedAmbiguity] = Field(default_factory=list, max_length=32)
    graph: SemanticGraph | None = None
    searchUpdate: bool = False
    clarificationReply: bool = False
    compoundReply: Literal["filled", "replaced", "cancelled", "rejected"] | None = None
    compoundInterpretationVersion: int | None = Field(
        default=None, strict=True, ge=1, le=1
    )
    interpretationText: str | None = Field(default=None, max_length=4000)
    clauseSourceText: str | None = Field(
        default=None,
        max_length=4000,
        description="Exact source addressed by UTF-16 clause offsets. Required when it differs from interpretationText or the request text; evidence keeps its original source.",
    )
    context: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique_slot_codes(self) -> "Resolution":
        if len({slot.code for slot in self.slots}) != len(self.slots):
            raise ValueError("Duplicate semantic slot codes")
        if self.clauseSourceText is not None:
            validate_clause_spans(self.clauses, self.clauseSourceText)
        return self

    def review_input(self) -> ReviewSemantics:
        """Expose current validated fields without recursively interpreting the DTO."""
        return ReviewSemantics(
            status=self.status,
            legacy_intent=self.intent,
            primary_intent=self.primaryIntent,
            request_type=self.requestType,
            confidence=Confidence(raw=self.confidence, band=self.confidenceLevel),
            requires_confirmation=self.requiresConfirmation,
            requested_actions=self,
            compound_reply=self.compoundReply,
            compound_interpretation_version=self.compoundInterpretationVersion,
            entities=self.entities,
            operations=self.operations,
            missing=self.missing,
            unsupported_intents=self.unsupportedIntents,
            reason=self.reason,
        )

    @model_validator(mode="after")
    def preserve_semantic_holds(self) -> "Resolution":
        hold = normalize_holds(self.review_input(), self.message)
        if self.status != hold.status:
            self.status = hold.status
        if self.confidence != hold.confidence:
            self.confidence = hold.confidence
        if self.message != hold.message:
            self.message = hold.message
        if self.missing != hold.missing:
            self.missing = hold.missing
        # Preserve unset optional metadata in serialization.
        if hold.issues != self.requestedActionIssues:
            self.requestedActionIssues = hold.issues
        return self


class ResolutionV2(Resolution):
    """Execution-bearing result fields are closed; diagnostics live in the envelope."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    entities: dict[str, JsonValue] = Field(default_factory=dict, max_length=64)
    context: dict[str, JsonValue] = Field(default_factory=dict, max_length=32)


class ResolutionProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    releaseId: Name | None
    generationFingerprint: Fingerprint
    runtimeVersion: Fingerprint
    normalizationVersion: Literal["english-v1"]
    # Clauses retain JavaScript string offsets. Evidence produced by the
    # shopping/request-constraint recognizers already uses Unicode code points.
    clauseSpanEncoding: Literal["utf-16-code-units"]
    evidenceSpanEncoding: Literal["unicode-code-points"]

    def interpretation_provenance(self) -> InterpretationProvenance:
        return InterpretationProvenance(
            wire_contract="language-v2",
            release_id=self.releaseId,
            generation_fingerprint=self.generationFingerprint,
            runtime_version=self.runtimeVersion,
            normalization_version=self.normalizationVersion,
            clause_span_encoding=self.clauseSpanEncoding,
            evidence_span_encoding=self.evidenceSpanEncoding,
        )


class ResolutionEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    contractVersion: Literal[2]
    provenance: ResolutionProvenance
    result: ResolutionV2
    diagnostics: dict[str, JsonValue] = Field(default_factory=dict, max_length=64)


class ResolutionFailure(BaseModel):
    """Transport failure awaiting trusted request identity from the application."""

    model_config = ConfigDict(extra="forbid", strict=True)
    code: Literal["invalid_response", "incompatible_version", "incompatible_release"]


@lru_cache(maxsize=1)
def packaged_generation_fingerprint() -> str:
    """Compare v2 replies with the artifact used by Python evidence verification."""
    artifact = (
        Path(__file__).resolve().parents[3]
        / "commerce_language_engine/data/compiled.json"
    )
    try:
        value = json.loads(artifact.read_text()).get("generationFingerprint", "")
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def parse_response(
    payload: object, *, source_text: str | None = None
) -> Resolution | ResolutionFailure:
    """Dispatch on the original wire version before any lossy legacy projection."""
    if not isinstance(payload, dict):
        return ResolutionFailure(code="invalid_response")
    if "contractVersion" in payload:
        if (
            type(payload["contractVersion"]) is not int
            or payload["contractVersion"] != 2
        ):
            return ResolutionFailure(code="incompatible_version")
        try:
            envelope = ResolutionEnvelope.model_validate(payload)
            packaged = packaged_generation_fingerprint()
            configured = os.environ.get("AI_LANGUAGE_GENERATION_FINGERPRINT")
            runtime_pin = os.environ.get("AI_LANGUAGE_RUNTIME_SHA256")
            fingerprint = envelope.provenance.generationFingerprint
            if (
                not packaged
                or fingerprint != packaged
                or (configured and fingerprint != configured)
                or (runtime_pin and envelope.provenance.runtimeVersion != runtime_pin)
            ):
                return ResolutionFailure(code="incompatible_release")
            resolution = envelope.result
            clause_source = resolution.clauseSourceText
            if clause_source is None:
                clause_source = resolution.interpretationText or source_text
            if clause_source is not None:
                validate_clause_spans(resolution.clauses, clause_source)
            resolution._provenance = envelope.provenance.interpretation_provenance()
            return resolution
        except (ValidationError, ValueError, TypeError, RecursionError):
            return ResolutionFailure(code="invalid_response")
    if "result" in payload or "provenance" in payload:
        # A damaged envelope must not be interpreted as a legacy UNKNOWN reply.
        return ResolutionFailure(code="invalid_response")
    if "schema_version" in payload and payload["schema_version"] != "1.0":
        return ResolutionFailure(code="incompatible_version")
    if os.environ.get("AI_LANGUAGE_RUNTIME_SHA256"):
        # An explicit runtime pin requires a verifiable envelope. Allowing a
        # legacy reply here would silently disable that deployment requirement.
        return ResolutionFailure(code="incompatible_release")
    try:
        return Resolution.model_validate(payload)
    except (ValidationError, ValueError, TypeError, RecursionError):
        return ResolutionFailure(code="invalid_response")


@traced
async def resolve(
    url: str, message: str, *, context: dict[str, Any] | None = None
) -> Resolution | ResolutionFailure | None:
    if not url or len(message) > 4000:
        return None
    try:
        async with httpx.AsyncClient(timeout=1.5, trust_env=False) as client:
            payload: dict[str, Any] = {"text": message, "contractVersion": 2}
            if context is not None:
                payload["context"] = context
            with boundary("language-engine", "resolve") as call:
                if call:
                    response = await client.post(
                        url.rstrip("/") + "/api/resolve",
                        json=payload,
                        headers=call.headers,
                    )
                    call.received(response.headers, response.status_code)
                else:
                    response = await client.post(
                        url.rstrip("/") + "/api/resolve", json=payload
                    )
            if len(response.content) > 262144:
                return ResolutionFailure(code="invalid_response")
            if response.status_code == 400:
                try:
                    error = response.json()
                except ValueError:
                    error = None
                if (
                    isinstance(error, dict)
                    and error.get("error") == "incompatible_version"
                ):
                    return ResolutionFailure(code="incompatible_version")
            response.raise_for_status()
            envelope = response.json()
            parsed = parse_response(envelope, source_text=message)
            if isinstance(parsed, Resolution) and isinstance(envelope, dict):
                debug_record(
                    "language_rule_evidence",
                    {
                        "provenance": envelope.get("provenance"),
                        "result": envelope.get("result"),
                        "diagnostics": envelope.get("diagnostics"),
                    },
                )
            return parsed
    except httpx.HTTPError:
        return None
    except (ValueError, ValidationError, RecursionError):
        return ResolutionFailure(code="invalid_response")
