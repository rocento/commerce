"""Content-free diagnostics from validated interpretation results."""

from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)


def diagnostic_summary(
    result: InterpretedRequest | InterpretationFailure | None, selected_route: str
) -> dict[str, object]:
    request = result if isinstance(result, InterpretedRequest) else None
    summary: dict[str, object] = {
        "status": request.status if request else "UNAVAILABLE",
        "intent": request.legacy_intent if request else None,
        "route": selected_route,
        "requested_actions": request.requested_actions.requested_action_shadow()
        if request
        else {"metadata": "unavailable"},
    }
    if request and request.provenance.wire_contract == "language-v2":
        provenance = request.provenance
        summary["language_release"] = {
            "wire_contract": provenance.wire_contract,
            "release_id": provenance.release_id,
            "generation_fingerprint": provenance.generation_fingerprint,
            "runtime_version": provenance.runtime_version,
            "normalization_version": provenance.normalization_version,
            "clause_span_encoding": provenance.clause_span_encoding,
            "evidence_span_encoding": provenance.evidence_span_encoding,
        }
    if isinstance(result, InterpretationFailure):
        summary["failure_code"] = result.code
    return summary
