"""Project server-owned discovery questions and admit only their typed read reply."""

from uuid import UUID

from app.commerce_action_engine.actions.shopping.contracts import ShoppingClarification
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import InterpretationDecision
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretedRequest,
)


def shopping_question_view(
    original: str, revision: UUID, plan: ShoppingClarification
) -> dict[str, object]:
    return {
        "original_message": original,
        "question": plan.question,
        "revision": revision,
        "kind": "shopping",
        "choices": [choice.label for choice in plan.choices],
        "optional": plan.optional,
    }


def shopping_reply_interpretation(
    context: TurnContext, plan: ShoppingClarification
) -> InterpretationDecision:
    """A claimed owner-bound frame admits a fixed discovery read, never a write.

    This is a separate server-owned admission path. It does not relabel UNKNOWN
    engine output or issue a model permit, and requires fresh catalog validation.
    """
    request = InterpretedRequest(
        request_id=context.actor.request_id,
        status="RESOLVED",
        legacy_intent="PRODUCT_SEARCH",
        message="",
        confidence=Confidence(raw=1.0),
        entities={
            "productText": plan.frame.query,
            **({"category": plan.frame.category} if plan.frame.category else {}),
        },
        clarification_reply=True,
    )
    return InterpretationDecision(request, "search")
