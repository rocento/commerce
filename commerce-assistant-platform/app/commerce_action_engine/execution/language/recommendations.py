"""Reconstruct recommendation requests from validated, customer-scoped history."""

from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import JsonValue

from app.commerce_action_engine.actions.catalog.followups import (
    FOLLOWUP,
    HistoryMessage,
    discovery_context,
    latest_products,
)
from app.commerce_action_engine.actions.shopping.context import recommendation_reference
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language.followup_ports import (
    FollowupInterpretation,
    FollowupInterpreter,
)


@dataclass(frozen=True)
class RecommendationFollowup[Result: FollowupInterpretation]:
    interpretation: Result
    message: str
    original_message: str | None = None


def _first_rejections(history: Sequence[HistoryMessage], original: str) -> list[str]:
    """Only assistant-rendered product identities can become rejected candidates."""
    start = next(
        (
            i
            for i in range(len(history) - 1, -1, -1)
            if history[i].role == "user" and history[i].text == original
        ),
        len(history),
    )
    latest: list[str] = []
    seen: list[str] = []
    rejected: list[str] = []
    for row in history[start + 1 :]:
        if row.role == "assistant":
            latest = latest_products([row])
            seen.extend(latest)
        elif row.role == "user":
            if recommendation_reference(row.text) == "FIRST":
                rejected.extend(latest[:1])
            elif FOLLOWUP.fullmatch(row.text.strip()):
                rejected.extend(seen)
    return list(dict.fromkeys(rejected))


def _missing_first_question(entities: dict[str, JsonValue]) -> str:
    product = entities.get("productText")
    description = product if isinstance(product, str) and product != "*" else "product"
    context = entities.get("shoppingContext")
    rows = context.get("relations") if isinstance(context, dict) else None
    if isinstance(rows, list):
        uses = []
        for row in rows:
            if (
                isinstance(row, dict)
                and row.get("relation") == "intended_use"
                and not row.get("negated")
            ):
                value = row.get("value")
                if isinstance(value, str):
                    uses.append(value)
        if uses:
            description += " for " + " and ".join(uses)
    price = entities.get("price")
    if isinstance(price, dict) and price.get("operator") in {"<", "<="}:
        description += f" with your maximum budget of {price.get('value')} {price.get('currency') or ''}"
    return (
        f"I still have your {description} request, but I cannot identify a first product suggestion in the saved results. "
        "Which product name or link would you like me to exclude?"
    )


async def resolve_recommendation_followup[Result: FollowupInterpretation](
    message: str,
    history: Sequence[HistoryMessage],
    initial: Result,
    interpreter: FollowupInterpreter[Result],
) -> RecommendationFollowup[Result]:
    request = initial.result
    if isinstance(request, InterpretationFailure):
        return RecommendationFollowup(initial, message)
    mode = request.entities.get("recommendationFollowup")
    if mode not in ("different", "cheaper"):
        return RecommendationFollowup(initial, message)
    reference = request.entities.get("recommendationReference")
    if reference not in (None, "FIRST") or (
        reference is not None and mode != "different"
    ):
        return RecommendationFollowup(
            interpreter.question(
                "Which product name or link would you like me to exclude?",
                intent="PRODUCT_RECOMMEND",
            ),
            message,
        )
    prior = discovery_context(
        history,
        additional_followup=lambda text: recommendation_reference(text) is not None,
    )
    if prior:
        original = await interpreter.resolve(prior[0])
        result = original.result
        if isinstance(result, InterpretationFailure):
            if result.code != "unavailable":
                return RecommendationFollowup(original, message)
        elif result.legacy_intent in {
            "PRODUCT_SEARCH",
            "PRODUCT_RECOMMEND",
        } and interpreter.has_plan(original, prior[0], complete=True):
            latest = latest_products(history)
            if reference == "FIRST" and not latest:
                return RecommendationFollowup(
                    interpreter.clarify(
                        original,
                        _missing_first_question(result.entities),
                        missing=["previousRecommendation"],
                    ),
                    message,
                )
            if not prior[1]:
                return RecommendationFollowup(
                    interpreter.question(
                        "Which product or category would you like recommendations for? Include any budget or required features.",
                        intent="PRODUCT_RECOMMEND",
                        confidence=1.0,
                    ),
                    message,
                )
            excluded: list[JsonValue] = (
                list(
                    dict.fromkeys([*_first_rejections(history, prior[0]), *latest[:1]])
                )
                if reference == "FIRST"
                else list(prior[1])
            )
            references: list[JsonValue] = list(
                latest_products(history) if mode == "cheaper" else prior[2]
            )
            entities: dict[str, JsonValue] = {
                **result.entities,
                "recommendationFollowup": mode,
                "excludedProducts": excluded,
                "cheaperReferences": references,
            }
            return RecommendationFollowup(
                interpreter.with_entities(original, entities),
                prior[0],
                message,
            )
    return RecommendationFollowup(
        interpreter.question(
            "I do not have a verified first suggestion in this chat. Which product name or link would you like me to exclude?"
            if reference == "FIRST"
            else "Which product or category would you like recommendations for? Include any budget or required features.",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
        ),
        message,
    )
