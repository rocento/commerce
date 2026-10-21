"""Compose validated follow-up policies with the retained language wire boundary."""

import json
from collections.abc import Sequence

from pydantic import JsonValue

from app.commerce_action_engine.actions.catalog.followups import HistoryMessage
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import (
    InterpretationDecision,
    interpret_resolution,
    shopping_plan,
)
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.clarification import (
    resolve_reply as fill_reply,
)
from app.commerce_action_engine.execution.language.recommendations import (
    RecommendationFollowup,
)
from app.commerce_action_engine.execution.language.recommendations import (
    resolve_recommendation_followup as replay_recommendation,
)
from app.commerce_action_engine.execution.language.routing import route
from app.commerce_action_engine.execution.planning.interpretation_holds import (
    normalize_holds,
)
from app.commerce_resolution_engine.diagnostics import traced

# Follow-up routing shares the normal turn's opt-in capture without coupling
# deterministic policy to diagnostics or filesystem access.
_traced_route = traced(route)


class _Interpreter:
    def __init__(self, url: str, context: TurnContext):
        self.url, self.context = url, context

    async def resolve(
        self, text: str, *, context: dict[str, JsonValue] | None = None
    ) -> InterpretationDecision:
        source = (
            await gate.resolve(self.url, text, context=context)
            if context is not None
            else await gate.resolve(self.url, text)
        )
        return interpret_resolution(source, self.context)

    def question(
        self, text: str, *, intent: str | None = None, confidence: float = 0
    ) -> InterpretationDecision:
        return interpret_resolution(
            gate.Resolution(
                status="NEEDS_CONTEXT",
                message=text,
                confidence=confidence,
                intent=intent,
            ),
            self.context,
        )

    def clarify(
        self,
        previous: InterpretationDecision,
        message: str,
        *,
        missing: list[str] | None = None,
        reset_confidence: bool = True,
    ) -> InterpretationDecision:
        fields: dict[str, object] = {"status": "NEEDS_CONTEXT", "message": message}
        if missing is not None:
            fields["missing"] = missing
        if reset_confidence:
            fields["confidence"] = Confidence(raw=0.0).model_dump()
        return self._update(previous, fields)

    def with_entities(
        self, previous: InterpretationDecision, entities: dict[str, JsonValue]
    ) -> InterpretationDecision:
        return self._update(previous, {"entities": entities})

    def _update(
        self, previous: InterpretationDecision, fields: dict[str, object]
    ) -> InterpretationDecision:
        if isinstance(previous.result, InterpretationFailure):
            return previous
        try:
            result = InterpretedRequest.model_validate(
                {**previous.result.model_dump(), **fields}
            )
            if len(json.dumps(result.model_dump(), allow_nan=False).encode()) > 262144:
                raise ValueError("Invalid interpretation size")
            hold = normalize_holds(result, result.message)
            metadata = result.requested_actions.model_dump(exclude_unset=True)
            if hold.issues != result.requested_actions.requestedActionIssues:
                metadata["requestedActionIssues"] = hold.issues
            result = InterpretedRequest.model_validate(
                {
                    **result.model_dump(),
                    "status": hold.status,
                    "message": hold.message,
                    "confidence": {
                        **result.confidence.model_dump(),
                        "raw": hold.confidence,
                    },
                    "missing": hold.missing,
                    "requested_actions": metadata,
                }
            )
        except (ValueError, TypeError, RecursionError):
            failure = InterpretationFailure(
                request_id=self.context.actor.request_id, code="invalid_response"
            )
            return InterpretationDecision(failure, "unavailable")
        return InterpretationDecision(result, _traced_route(result))

    def has_plan(
        self, interpretation: InterpretationDecision, text: str, *, complete: bool
    ) -> bool:
        plan = shopping_plan(interpretation.result, text)
        return plan is not None and (not complete or not plan.clarification)


async def resolve_reply(
    url: str,
    original: str,
    reply: str,
    *,
    context: TurnContext,
) -> tuple[InterpretationDecision, str]:
    return await fill_reply(original, reply, _Interpreter(url, context))


async def resolve_recommendation_followup(
    url: str,
    message: str,
    history: Sequence[HistoryMessage],
    initial: InterpretationDecision,
    *,
    context: TurnContext,
) -> RecommendationFollowup[InterpretationDecision]:
    return await replay_recommendation(
        message,
        history,
        initial,
        _Interpreter(url, context),
    )


async def resume_compound(
    url: str, original: str, reply: str, *, context: TurnContext
) -> tuple[InterpretationDecision, str]:
    """Called only after application revision admission."""
    from app.commerce_action_engine.execution.language.compound_clarification import (
        resume,
    )

    rejected = interpret_resolution(
        gate.Resolution(
            status="NEEDS_CONTEXT",
            confidence=0,
            compoundReply="rejected",
            message="Please send the complete request again.",
        ),
        context,
    )
    return await resume(original, reply, _Interpreter(url, context), rejected)
