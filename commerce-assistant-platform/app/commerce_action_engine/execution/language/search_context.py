"""Replay bounded, customer-scoped search history through the language engine.

Only linguistic search text travels back to the engine. Prior messages, model
replies and context never become product identities or mutation authority.
"""

from collections.abc import Awaitable, Callable, Sequence
from typing import Protocol

from pydantic import JsonValue

from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)


class SearchInterpretation(Protocol):
    @property
    def result(self) -> InterpretedRequest | InterpretationFailure: ...


class HistoryMessage(Protocol):
    @property
    def role(self) -> str: ...

    @property
    def text(self) -> str: ...


async def resolve_search_update[Result: SearchInterpretation](
    message: str,
    history: Sequence[HistoryMessage],
    initial: Result,
    resolve: Callable[[str, dict[str, JsonValue]], Awaitable[Result]],
) -> tuple[Result, str]:
    """Replay through an injected validated interpreter; wire objects stay outside."""
    if (
        not isinstance(initial.result, InterpretedRequest)
        or not initial.result.search_update
    ):
        return initial, message
    # History is already scoped by the application. Never consume assistant text.
    messages = [row.text for row in history if row.role == "user"][-3:]
    context: dict[str, JsonValue] = {}
    for previous in messages:
        interpretation = await resolve(previous, context)
        result = interpretation.result
        if isinstance(result, InterpretationFailure):
            return interpretation, message
        active = result.context_next.get("activeSearch")
        if (
            result.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
            and isinstance(active, dict)
            and {"text"} <= set(active) <= {"text", "contextual"}
            and ("contextual" not in active or active["contextual"] is True)
            and isinstance(active["text"], str)
            and 0 < len(active["text"]) <= 4000
        ):
            context = {"activeSearch": active}
        else:
            context = {}
    if not context:
        return initial, message
    interpretation = await resolve(message, context)
    result = interpretation.result
    if isinstance(result, InterpretationFailure):
        return interpretation, message
    if (
        result.search_update
        and result.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
        and result.status in {"RESOLVED", "NEEDS_CONTEXT"}
        and not result.request_type
        and result.interpretation_text
    ):
        return interpretation, result.interpretation_text
    return initial, message
