"""Strict legacy-v1 projection, also used for validated live routing results."""

import json
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretationFailure,
    InterpretationProvenance,
    InterpretedRequest,
    RequestedActions,
    ResolvedAmbiguity,
    ResolvedSlot,
)


class InterpretationContext(Protocol):
    """Trusted request identity supplied by application composition."""

    @property
    def actor(self) -> ActorContext: ...


class LegacyResolution(BaseModel):
    # Engine debug and scoring diagnostics are additive, not execution inputs.
    model_config = ConfigDict(extra="ignore", strict=True, allow_inf_nan=False)
    status: Literal[
        "RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "UNKNOWN", "UNSUPPORTED", "DENIED"
    ]
    intent: str | None = None
    primaryIntent: str | None = None
    message: str = Field(max_length=1000)
    confidence: float = Field(ge=0, le=1)
    confidenceLevel: Literal["HIGH", "MEDIUM", "LOW", "AMBIGUOUS"] | None = None
    requiresConfirmation: bool = False
    requestType: str | None = None
    reason: Literal["unsupported_capability", "access_denied"] | None = None
    unsupportedIntents: list[str] = Field(default_factory=list, max_length=32)
    searchUpdate: bool = False
    clarificationReply: bool = False


def adapt_legacy_resolution(
    payload: object,
    context: InterpretationContext,
    *,
    wire_contract: str = "legacy-v1",
    provenance: InterpretationProvenance | None = None,
) -> InterpretedRequest | InterpretationFailure:
    request_id = context.actor.request_id
    if wire_contract != "legacy-v1":
        return InterpretationFailure(request_id=request_id, code="incompatible_version")
    if payload is None:
        return InterpretationFailure(request_id=request_id, code="unavailable")
    try:
        if (
            not isinstance(payload, dict)
            or len(json.dumps(payload, allow_nan=False).encode()) > 262144
        ):
            raise ValueError("Invalid engine response size")
        if "schema_version" in payload and payload["schema_version"] != "1.0":
            return InterpretationFailure(
                request_id=request_id, code="incompatible_version"
            )
        if "contractVersion" in payload or "result" in payload:
            # Live envelopes must pass the transport dispatcher first. This
            # legacy adapter never guesses a version after discarding fields.
            return InterpretationFailure(
                request_id=request_id, code="incompatible_version"
            )
        legacy = LegacyResolution.model_validate(payload)
        next_context = payload.get("context", {})
        if not isinstance(next_context, dict):
            raise TypeError("Invalid context envelope")
        raw_slots = payload.get("slots", [])
        raw_ambiguities = payload.get("ambiguities", [])
        if not isinstance(raw_slots, list) or not isinstance(raw_ambiguities, list):
            raise TypeError("Invalid semantic collections")
        slots = [ResolvedSlot.model_validate(slot) for slot in raw_slots]
        if len({slot.code for slot in slots}) != len(slots):
            raise ValueError("Duplicate semantic slot codes")
        ambiguities = [ResolvedAmbiguity.model_validate(row) for row in raw_ambiguities]
        return InterpretedRequest(
            request_id=request_id,
            status=legacy.status,
            reason=legacy.reason,
            unsupported_intents=legacy.unsupportedIntents,
            primary_intent=legacy.primaryIntent or legacy.intent,
            legacy_intent=legacy.intent,
            request_type=legacy.requestType,
            requested_actions=RequestedActions.model_validate(
                {
                    key: payload[key]
                    for key in RequestedActions.model_fields
                    if key in payload
                }
            ),
            compound_reply=payload.get("compoundReply"),
            compound_interpretation_version=payload.get(
                "compoundInterpretationVersion"
            ),
            interpretation_text=payload.get("interpretationText"),
            clause_source_text=payload.get("clauseSourceText"),
            search_update=legacy.searchUpdate,
            clarification_reply=legacy.clarificationReply,
            message=legacy.message,
            confidence=Confidence(raw=legacy.confidence, band=legacy.confidenceLevel),
            requires_confirmation=legacy.requiresConfirmation,
            entities=payload.get("entities", {}),
            slots={slot.code: slot.model_dump(exclude_unset=True) for slot in slots},
            ambiguities=[row.model_dump(exclude_unset=True) for row in ambiguities],
            graph=payload.get("graph"),
            clauses=payload.get("clauses", []),
            actions=payload.get("actions", []),
            operations=payload.get("operations", []),
            references=payload.get("references", []),
            relationships=payload.get("relationships", []),
            missing=payload.get("missing", []),
            context_next=next_context.get("next", {}),
            provenance=provenance or InterpretationProvenance(),
        )
    except (ValidationError, ValueError, TypeError, RecursionError):
        return InterpretationFailure(request_id=request_id, code="invalid_response")
