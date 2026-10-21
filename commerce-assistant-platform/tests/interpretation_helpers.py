"""Project wire fixtures through the live boundary with synthetic test identity."""

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.language.routing import route


def standard_route(
    source: Resolution | InterpretedRequest | InterpretationFailure | None,
) -> str:
    if isinstance(source, (InterpretedRequest, InterpretationFailure)):
        return route(source)
    identity = "00000000-0000-0000-0000-000000000001"
    context = TurnContext(
        actor=ActorContext(
            tenant_id=identity,
            store_id=identity,
            session_id=identity,
            request_id=identity,
            channel="evaluation",
        )
    )
    return interpret_resolution(source, context).route
