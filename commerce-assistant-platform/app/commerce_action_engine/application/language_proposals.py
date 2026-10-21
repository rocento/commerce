"""Validate the single proposal reinterpretation with trusted turn identity."""

from collections.abc import Sequence

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import (
    InterpretationDecision,
    interpret_resolution,
)
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.proposals import (
    CONTEXTUAL_READ_INTENTS,
    accepts_result,
    permits_reinterpretation,
)
from app.commerce_contracts.conversation_context import HistoryMessage, recent_exchange
from app.commerce_contracts.language_proposal import (
    CONVERSATION_INTENTS,
    LanguageProposal,
)


def clarification(context: TurnContext) -> InterpretationDecision:
    return interpret_resolution(
        gate.Resolution(
            status="NEEDS_CONTEXT",
            confidence=0.0,
            message=(
                "Please restate the full request so I can understand what you need. "
                "You can ask about products, your cart, an order, or a problem with the store."
            ),
        ),
        context,
    )


async def accept_proposal(
    url: str,
    original: InterpretationDecision,
    message: str,
    proposal: LanguageProposal,
    *,
    context: TurnContext,
    history: Sequence[HistoryMessage] = (),
) -> InterpretationDecision:
    initial = original.result
    if isinstance(initial, InterpretationFailure):
        return original
    if initial.status != "UNKNOWN":
        raise ValueError("Only UNKNOWN permits a language proposal")
    if (
        proposal.status == "CONVERSATION"
        and proposal.intent in CONVERSATION_INTENTS
        and proposal.canonical_text is None
    ):
        return interpret_resolution(
            gate.Resolution(
                status="RESOLVED", intent=proposal.intent, confidence=1.0, message=""
            ),
            context,
        )
    if (
        recent_exchange(message, history)
        and proposal.intent not in CONTEXTUAL_READ_INTENTS
    ) or not permits_reinterpretation(message, proposal):
        return clarification(context)
    assert proposal.canonical_text is not None
    decision = interpret_resolution(
        await gate.resolve(url, proposal.canonical_text), context
    )
    result = decision.result
    if isinstance(result, InterpretationFailure):
        return decision
    if result.status in {"DENIED", "UNSUPPORTED"}:
        return decision
    if not accepts_result(initial, result, message, proposal):
        return clarification(context)
    return decision
