"""Coordinate language admission and one UNKNOWN-only proposal.

The turn owns stream events, transcript persistence and the final permit reset.
State is updated at the original await boundaries so failures retain partial
clarification and diagnostic evidence without dispatching any commerce action.
"""

import re
import time
from collections.abc import Callable, Mapping
from contextvars import Token
from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

from app.commerce_action_engine.actions.shopping.contracts import ShoppingClarification
from app.commerce_action_engine.application import followups
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.handlers.shopping_clarification import (
    shopping_reply_interpretation,
)
from app.commerce_action_engine.application.interpretation import (
    InterpretationDecision,
    interpret_resolution,
)
from app.commerce_action_engine.application.interpretation_diagnostics import (
    diagnostic_summary,
)
from app.commerce_action_engine.application.literal_cart_selection import (
    CatalogLookup,
    literal_cart_selection,
)
from app.commerce_action_engine.application.semantic_recovery import Retriever
from app.commerce_action_engine.contracts import AssistantChatInput
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate as language_gate
from app.commerce_action_engine.execution.language.selection import ShoppingFollowup
from app.commerce_action_engine.platform import Settings, phase
from app.commerce_resolution_engine.admission import (
    FallbackPermit,
    ReasoningGateway,
    install_permit,
    issue_unknown_permit,
    reset_permit,
)
from app.commerce_resolution_engine.contracts import Message, ModelError, ModelProvider
from app.commerce_resolution_engine.diagnostics import debug_record
from app.commerce_resolution_engine.language import propose_language


class ModelBudget(Protocol):
    async def model_budget_available(
        self,
        tenant: UUID,
        conversation: UUID | None,
        daily_limit: int,
        session_limit: int,
    ) -> bool: ...


@dataclass(frozen=True)
class LanguageAdmissionPorts:
    context: TurnContext
    config: Settings
    tenant_id: UUID
    models: Mapping[str, ReasoningGateway]
    budget: ModelBudget | None
    retrieve_intent_examples: Retriever | None
    select_provider: Callable[[ReasoningGateway], ModelProvider]
    lookup_cart_product: CatalogLookup | None = None


@dataclass
class LanguageAdmissionState:
    """Progress retained even when an awaited dependency fails or is cancelled."""

    body: AssistantChatInput
    clarification_reply: bool = False
    interpretation: InterpretationDecision | None = None
    selected_followup: ShoppingFollowup | None = None
    original_followup_message: str | None = None
    language_fallback: bool = False
    gate_route: str = "fallback"
    permit_token: Token[FallbackPermit | None] | None = field(
        default=None, init=False, repr=False
    )

    def close(self) -> None:
        """Restore the caller's context in the turn's final cleanup, exactly once."""
        if self.permit_token is not None:
            reset_permit(self.permit_token)
            self.permit_token = None


@dataclass(frozen=True)
class LanguageBudgetBlocked:
    """The turn must render the existing budget response and stop before dispatch."""


async def _interpret(
    state: LanguageAdmissionState,
    *,
    context: TurnContext,
    language_url: str,
    history: tuple[Message, ...],
    shopping_question: ShoppingClarification | None,
    lookup_cart_product: CatalogLookup | None = None,
) -> None:
    gate = None
    if shopping_question is not None:
        state.interpretation = shopping_reply_interpretation(context, shopping_question)
    elif state.body.clarification and state.body.clarification.revision:
        (
            compound_reply,
            resolved_message,
        ) = await followups.resume_compound(
            language_url,
            state.body.clarification.original_message,
            state.body.message,
            context=context,
        )
        state.interpretation = compound_reply
        state.clarification_reply = isinstance(
            compound_reply.result, InterpretedRequest
        ) and compound_reply.result.compound_reply in {
            "filled",
            "replaced",
        }
        state.body = state.body.model_copy(update={"message": resolved_message})
    elif state.body.clarification:
        clarification_context = state.body.clarification
        # A complete browser comparison command can replace a stale
        # slot question. Only the language engine decides its intent;
        # other replies retain the existing clarification safeguards.
        fresh = (
            await language_gate.resolve(language_url, state.body.message)
            if re.search(
                r"\b(?:clear|reset|empty)\b.*\bcompar",
                state.body.message,
                re.IGNORECASE,
            )
            else None
        )
        if (
            fresh is not None
            and interpret_resolution(fresh, context).route == "comparison_clear"
        ):
            gate = fresh
            state.body = state.body.model_copy(update={"clarification": None})
        else:
            (
                reply_interpretation,
                resolved_message,
            ) = await followups.resolve_reply(
                language_url,
                clarification_context.original_message,
                state.body.message,
                context=context,
            )
            state.interpretation = reply_interpretation
            state.clarification_reply = (
                resolved_message != clarification_context.original_message
                and isinstance(reply_interpretation.result, InterpretedRequest)
                and reply_interpretation.result.status
                not in {"UNKNOWN", "DENIED", "UNSUPPORTED"}
            )
            state.body = state.body.model_copy(update={"message": resolved_message})
    else:
        from app.commerce_action_engine.actions.orders import (
            contextual_order_message,
        )

        contextual_read = (
            contextual_order_message(state.body.message)
            if state.body.order_id
            else None
        )
        from app.commerce_action_engine.execution.language.selection import (
            shopping_followup,
        )

        literal = (
            await literal_cart_selection(state.body.message, lookup_cart_product)
            if lookup_cart_product is not None and state.body.product_id is None
            else None
        )
        if literal is not None:
            product_id, quantity = literal
            state.body = state.body.model_copy(update={"product_id": product_id})
            state.selected_followup = ShoppingFollowup(
                f"add {quantity} selected product to cart", "ADD_TO_CART", True
            )
        else:
            state.selected_followup = shopping_followup(
                state.body.message,
                product=bool(state.body.product_id),
                cart=bool(state.body.cart_context),
            )
        # UI selection supplies linguistic context only. Product
        # handlers still fetch and verify the scoped catalog item.
        selected_language_context = (
            {"states": ["PRODUCT_SELECTED"]} if state.body.product_id else None
        )
        gate = await language_gate.resolve(
            language_url,
            state.selected_followup.message
            if state.selected_followup
            else contextual_read or state.body.message,
            **(
                {"context": selected_language_context}
                if selected_language_context
                else {}
            ),
        )
        state.interpretation = interpret_resolution(gate, context)
        initial_request = state.interpretation.result
        if (
            isinstance(initial_request, InterpretedRequest)
            and initial_request.search_update
            and not state.selected_followup
            and not contextual_read
        ):
            from app.commerce_action_engine.application.interpretation import (
                resolve_search_update,
            )

            (
                search_interpretation,
                search_message,
            ) = await resolve_search_update(
                language_url,
                state.body.message,
                history,
                state.interpretation,
                context=context,
            )
            state.interpretation = search_interpretation
            # The complete edited search is needed by the catalog's
            # independent budget/requirement checks and next turn.
            state.body = state.body.model_copy(update={"message": search_message})
        if (
            contextual_read
            and isinstance(initial_request, InterpretedRequest)
            and initial_request.status == "UNKNOWN"
        ):
            gate = language_gate.Resolution(
                status="RESOLVED",
                intent="ORDER_DETAILS",
                message="",
                confidence=1.0,
            )
            state.interpretation = None

    state.original_followup_message = None
    if state.interpretation is None:
        state.interpretation = interpret_resolution(gate, context)
    replay_request = state.interpretation.result
    debug_record(
        "initial_language_result",
        diagnostic_summary(replay_request, state.interpretation.route),
    )
    if isinstance(replay_request, InterpretedRequest) and replay_request.entities.get(
        "recommendationFollowup"
    ) in (
        "different",
        "cheaper",
    ):
        recommendation = await followups.resolve_recommendation_followup(
            language_url,
            state.body.message,
            history,
            state.interpretation,
            context=context,
        )
        state.interpretation = recommendation.interpretation
        state.original_followup_message = recommendation.original_message
        state.body = state.body.model_copy(update={"message": recommendation.message})


async def admit_language(
    state: LanguageAdmissionState,
    *,
    ports: LanguageAdmissionPorts,
    history: tuple[Message, ...],
    metadata: dict[str, object],
    shopping_question: ShoppingClarification | None = None,
) -> LanguageBudgetBlocked | None:
    """Resolve context, recover reads, and admit at most one model proposal.

    None continues normal dispatch. Budget exhaustion is returned to the turn;
    dependency errors and cancellation propagate with progress intact.
    """
    await _interpret(
        state,
        context=ports.context,
        language_url=ports.config.language_engine_url,
        history=history,
        shopping_question=shopping_question,
        lookup_cart_product=ports.lookup_cart_product,
    )
    assert state.interpretation is not None
    config = ports.config
    tracked = ports.models
    store = ports.budget
    from app.commerce_action_engine.application.semantic_recovery import (
        recover_read,
        retrieve_examples,
    )

    retrieved_examples = None
    if (
        "semantic_read_recovery" in config.feature_flags
        and config.semantic_recovery_embedding_budget == 1
        and config.intent_example_collection
        and state.interpretation.allows_fallback
        and isinstance(state.interpretation.result, InterpretedRequest)
        and not state.interpretation.result.context_next
        and not state.body.product_id
        and not state.body.order_id
        and not state.body.cart_context
    ):
        recovery_started = time.monotonic()
        recovery_timeout = min(3.0, config.turn_timeout / 4)
        with phase("retrieval"):
            retrieved_examples = await retrieve_examples(
                ports.retrieve_intent_examples,
                state.body.message,
                recovery_timeout,
                history=history,
            )
        metadata["intent_retrieval"] = retrieved_examples.metadata
        remaining = recovery_timeout - (time.monotonic() - recovery_started)
        if remaining > 0:
            state.interpretation = await recover_read(
                config.language_engine_url,
                state.interpretation,
                state.body.message,
                retrieved_examples.evidence,
                context=ports.context,
                timeout=remaining,
            )
        metadata["semantic_read_recovery"] = {
            "outcome": "miss"
            if state.interpretation.allows_fallback
            else state.interpretation.route,
            "generation_calls": 0,
        }

    state.gate_route = state.interpretation.route
    permit = issue_unknown_permit(
        "UNKNOWN" if state.interpretation.allows_fallback else "UNAVAILABLE",
        state.body.request_id,
    )
    state.permit_token = install_permit(permit)
    metadata["language_gate"] = diagnostic_summary(
        state.interpretation.result if state.interpretation else None, state.gate_route
    )
    debug_record("interpretation_before_fallback", metadata["language_gate"])
    if state.interpretation.allows_fallback:
        from app.commerce_action_engine.application.language_proposals import (
            accept_proposal,
            clarification,
        )
        from app.commerce_action_engine.execution.language.proposals import (
            PROPOSABLE_INTENTS,
        )

        state.language_fallback = True
        fallback_outcome: str | None = "unconfigured"
        model = tracked.get("extraction") or tracked.get("default")
        metadata["language_fallback"] = {
            "initial_status": "UNKNOWN",
            "outcome": "unconfigured",
        }
        if model is None:
            state.interpretation = clarification(ports.context)
        else:
            if store and not await store.model_budget_available(
                ports.tenant_id,
                state.body.conversation_id,
                config.model_daily_token_budget,
                config.model_session_token_budget,
            ):
                metadata.update(
                    route_reason="model_budget_exhausted",
                    budget_blocked=True,
                )
                return LanguageBudgetBlocked()
            language_provider = ports.select_provider(model)
            if config.intent_example_collection and retrieved_examples is None:
                with phase("retrieval"):
                    retrieved_examples = await retrieve_examples(
                        ports.retrieve_intent_examples,
                        state.body.message,
                        min(3.0, config.turn_timeout / 4),
                        history=history,
                    )
                metadata["intent_retrieval"] = retrieved_examples.metadata
            intent_evidence = retrieved_examples.evidence if retrieved_examples else ()
            try:
                proposal = await propose_language(
                    language_provider,
                    state.body.message,
                    PROPOSABLE_INTENTS,
                    evidence=intent_evidence,
                    history=history,
                )
            except ModelError as error:
                if error.code != "invalid_response":
                    raise
                state.interpretation = clarification(ports.context)
                fallback_outcome = "invalid_response"
                proposal = None
            finally:
                reset_permit(state.permit_token)
                state.permit_token = install_permit(None)
            if proposal is not None:
                debug_record("model_proposal", proposal.model_dump(mode="json"))
                state.interpretation = await accept_proposal(
                    config.language_engine_url,
                    state.interpretation,
                    state.body.message,
                    proposal,
                    context=ports.context,
                    history=history,
                )
                fallback_outcome = None
        # The model has had its one interpretation attempt. The
        # language engine and normal action handlers own the rest.
        if model is None:
            reset_permit(state.permit_token)
            state.permit_token = install_permit(None)
        metadata["language_fallback"] = {
            "initial_status": "UNKNOWN",
            "outcome": fallback_outcome or state.interpretation.route,
        }
        state.gate_route = state.interpretation.route
        metadata["language_gate"] = diagnostic_summary(
            state.interpretation.result, state.gate_route
        )
    return None
