"""Full-list compound clarification policy over validated interpretations."""

from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language.followup_ports import (
    FollowupInterpretation,
    FollowupInterpreter,
)
from app.commerce_action_engine.execution.planning.compound_review import (
    is_reviewed_pair,
)


async def resume[Result: FollowupInterpretation](
    original: str,
    reply: str,
    interpreter: FollowupInterpreter[Result],
    rejected: Result,
) -> tuple[Result, str]:
    """Reparse the full request after the application has atomically claimed it."""
    previous = await interpreter.resolve(original)
    prior = previous.result
    if isinstance(prior, InterpretationFailure):
        return (rejected if prior.code == "unavailable" else previous), original
    if not is_reviewed_pair(prior) or prior.status in {"DENIED", "UNSUPPORTED"}:
        return rejected, original
    resumed = await interpreter.resolve(
        reply, context={"pendingActionRequest": original}
    )
    result = resumed.result
    if isinstance(result, InterpretationFailure):
        return (previous if result.code == "unavailable" else resumed), original
    if not result.compound_reply:
        return previous, original
    if result.compound_reply in {"filled", "replaced"}:
        actions = result.requested_actions.requestedActions or []
        valid = (
            result.requested_actions.intentCountStatus == "EXACT"
            and 0 < len(actions) <= 2
            and all(a.intent in {"ADD_TO_CART", "ADD_TO_WISHLIST"} for a in actions)
            and bool(result.interpretation_text)
            and "requestConstraints" not in result.entities
        )
        if result.compound_reply == "filled":
            previous_actions = prior.requested_actions.requestedActions or []
            valid = (
                valid
                and len(actions) == len(previous_actions)
                and all(
                    a.intent == b.intent
                    and a.after == b.after
                    and len(a.items) == len(b.items)
                    and all(
                        (not x.productText or x.productText == y.productText)
                        and x.quantity == y.quantity
                        and x.unit == y.unit
                        for x, y in zip(a.items, b.items, strict=True)
                    )
                    for a, b in zip(previous_actions, actions, strict=True)
                )
            )
        if not valid:
            return previous, original
        return resumed, result.interpretation_text or original
    if result.compound_reply == "cancelled":
        return resumed, original
    return previous, original
