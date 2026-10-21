"""Validate the language result before selecting an action or admitting reasoning.

The standard contract owns status/failure, fallback decisions, compound semantics
and route selection. Wire objects are validated only at ingress; decisions retain standard semantics.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import JsonValue

from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.routing import route
from app.commerce_action_engine.execution.language.search_context import (
    HistoryMessage,
)
from app.commerce_action_engine.execution.language.search_context import (
    resolve_search_update as replay_search_update,
)
from app.commerce_resolution_engine.diagnostics import traced

# Keep instrumentation at application composition; the policy itself stays pure.
_traced_route = traced(route)


@dataclass(frozen=True)
class InterpretationDecision:
    result: InterpretedRequest | InterpretationFailure
    route: str

    @property
    def allows_fallback(self) -> bool:
        return (
            isinstance(self.result, InterpretedRequest) and self.result.allows_fallback
        )


@traced
def interpret_resolution(
    resolution: gate.Resolution | gate.ResolutionFailure | None, context: TurnContext
) -> InterpretationDecision:
    """Bind interpretation to trusted identity, retaining every live routing field.

    A failure has no actionable resolution, and keeps the existing unavailable
    response path. Never convert malformed or unavailable input into UNKNOWN.
    """
    if isinstance(resolution, gate.ResolutionFailure):
        return InterpretationDecision(
            InterpretationFailure(
                request_id=context.actor.request_id, code=resolution.code
            ),
            "unavailable",
        )
    try:
        provenance = None
        if resolution is not None:
            # Local follow-up code may use model_copy; validate its routing fields
            # as well as the standard projection before dispatching anything.
            if not isinstance(resolution, gate.Resolution):
                raise TypeError("Invalid routing result")
            provenance = resolution._provenance
            resolution = gate.Resolution.model_validate(resolution.model_dump())
        result = adapt_legacy_resolution(
            resolution.model_dump() if resolution is not None else None,
            context,
            provenance=provenance,
        )
    except (ValueError, TypeError, RecursionError):
        result = InterpretationFailure(
            request_id=context.actor.request_id, code="invalid_response"
        )
    if isinstance(result, InterpretationFailure):
        return InterpretationDecision(result, "unavailable")
    return InterpretationDecision(result, _traced_route(result))


async def resolve_search_update(
    url: str,
    message: str,
    history: Sequence[HistoryMessage],
    initial: InterpretationDecision,
    *,
    context: TurnContext,
) -> tuple[InterpretationDecision, str]:
    """Validate every replayed response with the admitted turn's trusted identity."""

    async def resolve(
        text: str, language_context: dict[str, JsonValue]
    ) -> InterpretationDecision:
        source = await gate.resolve(url, text, context=language_context)
        return interpret_resolution(source, context)

    return await replay_search_update(message, history, initial, resolve)


def shopping_plan(
    result: InterpretedRequest | InterpretationFailure, message: str
) -> ShoppingIntent | None:
    """Map validated live semantics; failures cannot produce a catalog plan."""
    from app.commerce_action_engine.actions.catalog.workflow import (
        map_discovery_request,
    )

    if isinstance(result, InterpretationFailure):
        return None
    return map_discovery_request(result, message, ShoppingIntent)


def reasoning_fallback_message(
    result: InterpretedRequest | InterpretationFailure | None,
) -> str | None:
    """A known or failed interpretation cannot fall through to model reasoning."""
    if isinstance(result, InterpretationFailure):
        return "The language engine is unavailable. Please try again."
    return result.message if result is not None and result.status != "UNKNOWN" else None
