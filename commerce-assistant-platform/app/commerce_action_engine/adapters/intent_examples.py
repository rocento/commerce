"""Validate retrieved example wording against the active commerce language engine."""

from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.example_policy import (
    resolution_fingerprint,
)
from app.commerce_action_engine.execution.language.routing import route
from app.commerce_contracts.intent_example import IntentExample


class LanguageExampleValidator:
    def __init__(self, engine_url: str, actor: ActorContext):
        self.engine_url = engine_url
        self.actor = actor

    async def __call__(self, example: IntentExample) -> str | None:
        wire = await gate.resolve(self.engine_url, example.canonical_text)
        result = adapt_legacy_resolution(
            wire.model_dump() if wire is not None else None,
            self,
            provenance=wire._provenance if isinstance(wire, gate.Resolution) else None,
        )
        review = example.review
        if review is not None:
            if (
                isinstance(result, InterpretationFailure)
                or review.review_status != "approved"
            ):
                return None
            if result.status != review.expected_status:
                return None
            if any(
                result.entities.get(key) != value for key, value in review.slots.items()
            ):
                return None
            if review.label != "positive":
                # Negative/ambiguous records are validation fixtures only, never
                # retrievable proposal evidence or permission to select an action.
                return resolution_fingerprint(result)
        if (
            isinstance(result, InterpretationFailure)
            or result.status != "RESOLVED"
            or result.legacy_intent != example.intent
            or result.request_type
            or (
                result.operations
                and not (
                    result.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
                    and result.operations == ["SEARCH_PRODUCTS"]
                    and result.requested_actions.intentCount == 1
                    and result.requested_actions.intentCountStatus == "EXACT"
                )
            )
            or result.requires_confirmation
            or route(result)
            not in {
                "search",
                "cart",
                "wishlist",
                "locations",
                "order",
                "delivery",
                "bestsellers",
                "discounts",
            }
        ):
            return None
        return resolution_fingerprint(result)
