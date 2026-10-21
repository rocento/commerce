"""Coordinate an admitted turn; transport and concrete dependency wiring live outside."""

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import aclosing
from uuid import UUID

from app.commerce_action_engine.actions.shopping import cart as cart_actions
from app.commerce_action_engine.application.compound_coordinator import (
    CompoundPreparationFailed,
    CompoundRequest,
    PreparedCompound,
    RecoveredCompound,
    prepare_compound_review,
    publish_compound_clarification,
    recover_compound,
    review_compound,
)
from app.commerce_action_engine.application.handler_dispatch import (
    HandlerContext,
    standard_handler,
)
from app.commerce_action_engine.application.handlers.cart import CartSelection
from app.commerce_action_engine.application.handlers.cart_read import cart_read_events
from app.commerce_action_engine.application.handlers.clarification import (
    clarification_event,
)
from app.commerce_action_engine.application.handlers.customer import (
    saved_address_events,
)
from app.commerce_action_engine.application.handlers.delivery import delivery_events
from app.commerce_action_engine.application.handlers.guidance import guidance
from app.commerce_action_engine.application.handlers.product_guidance import (
    product_prompts,
    prompt_message,
)
from app.commerce_action_engine.application.handlers.support import (
    support_create_events,
)
from app.commerce_action_engine.application.interpretation import (
    InterpretationDecision,
    reasoning_fallback_message,
    shopping_plan,
)
from app.commerce_action_engine.application.interpretation_diagnostics import (
    diagnostic_summary,
)
from app.commerce_action_engine.application.language_admission import (
    LanguageAdmissionPorts,
    LanguageAdmissionState,
    LanguageBudgetBlocked,
    admit_language,
)
from app.commerce_action_engine.application.shopping_continuation import (
    ShoppingContinuationScope,
    ShoppingResume,
    ShoppingStop,
    resolve_shopping_continuation,
)
from app.commerce_action_engine.application.shopping_runtime_responses import (
    ShoppingResponseScope,
    ShoppingRuntimeResponses,
)
from app.commerce_action_engine.application.turn_dependencies import PreparedTurn
from app.commerce_action_engine.application.turn_finalization import TurnFinalization
from app.commerce_action_engine.application.turn_output import TurnOutput
from app.commerce_action_engine.application.turn_routing import TurnRouting
from app.commerce_action_engine.contracts import AssistantChatInput, AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import (
    TurnTrace,
    phase,
    trace_turn,
)
from app.commerce_action_engine.platform.failures import classify
from app.commerce_action_engine.platform.live_tracking import feed as live_feed
from app.commerce_action_engine.platform.tracking_control import (
    status as tracking_status,
)
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_resolution_engine.boundaries import gateway_dispatch
from app.commerce_resolution_engine.chat import stream_chat
from app.commerce_resolution_engine.contracts import Message
from app.commerce_resolution_engine.diagnostics import (
    begin_debug,
)


class HandleTurn:
    def __init__(self, prepared: PreparedTurn, body: AssistantChatInput):
        self.prepared = prepared
        self.body = body

    async def aclose(self) -> None:
        await self.prepared.lease.aclose()

    async def run(self) -> AsyncGenerator[AssistantEvent, None]:
        prepared = self.prepared
        body = self.body
        config = prepared.config
        active_config = prepared.active_config
        caller = prepared.caller
        tracked = prepared.tracked
        store = prepared.store
        persistence = prepared.persistence
        assert persistence is not None  # PreparedTurn binds optional ports once.
        shopping_storage = persistence.shopping
        compound_storage = persistence.compound
        policy_answers = prepared.policy_answers
        intent_frame = prepared.intent_frame
        address_request = prepared.address_request
        commerce_tools = prepared.commerce_tools
        provider = prepared.provider
        trace = TurnTrace()
        trace_context = trace_turn(trace)
        trace_context.__enter__()
        capture_enabled = bool(tracking_status(config)["enabled"])
        debug_token = begin_debug(
            str(body.request_id),
            body.message,
            enabled=bool(store and capture_enabled),
            allowed=capture_enabled,
            publish=lambda request_id, kind, data: live_feed.publish(
                config.tenant_id, request_id, kind, data
            ),
        )
        gateway_dispatch(prepared.gateway_trace)
        started = time.monotonic()
        output = TurnOutput(body.request_id, config, active_config, tracked, trace)
        outcome = "completed"
        metadata = output.metadata
        routing = TurnRouting(prepared, trace, metadata)
        fallback_model_used = False
        # Every authenticated run records a route, even if history retrieval
        # fails before journey execution. The selected branch refines it below.
        routing.select("general", deterministic=True)
        if "extraction" in tracked:
            metadata["model_route"] = "small_extraction"

        finalization = TurnFinalization(
            prepared,
            body,
            output,
            routing,
            started=started,
            trace_context=trace_context,
            debug_token=debug_token,
        )

        from app.commerce_action_engine.actions.shopping import personalization
        from app.commerce_action_engine.application.handlers import (
            compound as compound_planning,
        )

        admission: LanguageAdmissionState | None = None
        interpretation: InterpretationDecision | None = None
        language_fallback = False
        selected_followup = None
        gate_route = "fallback"
        memory_token = None
        original_followup_message = None
        history: tuple[Message, ...] = ()
        prior_completion: dict[str, object] | None = None
        clarification_reply = False
        request_revision = None
        shopping_resume = None
        shopping_resume_revision = None
        shopping_resume_question = None
        shopping_owner = caller.subject or UUID(prepared.context.actor.session_id)
        shopping_store_id = UUID(prepared.context.actor.store_id)
        shopping_session_id = UUID(prepared.context.actor.session_id)
        compound_input_hash = compound_planning.input_hash(body)

        def record_completion() -> None:
            finalization.record_completion(
                outcome=outcome,
                clarification_reply=clarification_reply,
                prior_completion=prior_completion,
            )

        def make_event(kind: str, **fields: object) -> AssistantEvent:
            return output.event(kind, fallback_model_used=fallback_model_used, **fields)

        try:
            async with asyncio.timeout(config.turn_timeout):
                yield make_event("progress", stage="preparing")
                memory_token = await prepared.begin_memory()
                if (
                    store
                    and caller.subject
                    and body.conversation_id
                    and not address_request
                ):
                    with phase("history"):
                        past = await store.context(
                            caller.tenant, caller.subject, body.conversation_id
                        )
                    history = tuple(Message(row["role"], row["text"]) for row in past)
                    if body.clarification and persistence.completion is not None:
                        try:
                            async with asyncio.timeout(1):
                                prior_completion = await persistence.completion.completion_context(
                                    caller.tenant,
                                    caller.subject,
                                    body.conversation_id,
                                    expected_question=body.clarification.original_message,
                                )
                        except Exception:  # noqa: BLE001 -- measurement cannot block a reply
                            prior_completion = None
                memory_session = personalization.current()
                if memory_session and memory_session.recall() and not address_request:
                    history = memory_session.recall()
                recovery = await recover_compound(
                    caller,
                    CompoundRequest(
                        body.request_id,
                        body.conversation_id,
                        None,
                        compound_input_hash,
                        body.message,
                    ),
                    storage=compound_storage,
                    commerce_tools=commerce_tools,
                    store_present=store is not None,
                )
                if isinstance(recovery, RecoveredCompound):
                    # Recovery remains ahead of continuation and fresh admission.
                    assert store is not None and caller.subject and body.conversation_id
                    recovered = recovery.plan
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "compound_plan_recovery"
                    metadata["completion_disposition"] = "unverified"
                    metadata["compound_plan_id"] = str(recovered.plan_id)
                    metadata["compound_action_states"] = list(recovered.action_states)
                    metadata["response_source"] = "R"
                    if recovered.verified_receipts:
                        metadata.pop("completion_disposition", None)
                        metadata["completion_evidence"] = "action_receipt"
                    recovered_blocks = []
                    if recovered.choice:
                        metadata["completion_disposition"] = "clarification"
                        recovered_blocks = [
                            {
                                "kind": "text",
                                "text": compound_planning.PRODUCT_CHOICE_MESSAGE,
                            },
                            recovered.choice.model_dump(mode="json", exclude_none=True),
                        ]
                    record_completion()
                    await finalization.save_recovery(recovered.text, recovered_blocks)
                    yield make_event("message.delta", text=recovered.text)
                    if recovered_blocks:
                        yield make_event("content.blocks", blocks=recovered_blocks)
                    yield make_event("done", saved=True)
                    return
                from app.commerce_action_engine.application.handlers.shopping_clarification import (
                    shopping_question_view,
                )

                continuation = await resolve_shopping_continuation(
                    body,
                    scope=ShoppingContinuationScope(
                        tenant_id=caller.tenant,
                        owner_id=shopping_owner,
                        store_id=shopping_store_id,
                        session_id=shopping_session_id,
                    ),
                    storage=shopping_storage,
                    has_catalog=prepared.has_catalog,
                )
                if isinstance(continuation, ShoppingStop):
                    metadata["route_reason"] = continuation.route_reason
                    metadata["completion_disposition"] = continuation.disposition
                    yield make_event(
                        "message.delta",
                        text=continuation.text,
                        **(
                            {
                                "clarification": shopping_question_view(
                                    continuation.prompt.original_message,
                                    continuation.prompt.revision,
                                    continuation.prompt.plan,
                                )
                            }
                            if continuation.prompt is not None
                            else {}
                        ),
                    )
                    yield make_event("done", saved=False)
                    return
                if isinstance(continuation, ShoppingResume):
                    request_revision = continuation.request_revision
                    shopping_resume = continuation.frame
                    shopping_resume_revision = continuation.descriptor_revision
                    shopping_resume_question = continuation.question
                    clarification_reply = True
                    metadata["route_reason"] = continuation.route_reason
                    body = body.model_copy(
                        update={"message": continuation.original_message}
                    )
                if continuation.clear_clarification:
                    body = body.model_copy(update={"clarification": None})
                if (
                    persistence.revisions is not None
                    and body.conversation_id
                    and shopping_resume is None
                ):
                    request_revision = await persistence.revisions.begin_request(
                        caller.tenant,
                        shopping_owner,
                        body.conversation_id,
                        expected_revision=body.clarification.revision
                        if body.clarification
                        else None,
                        original=body.clarification.original_message
                        if body.clarification
                        else "",
                        question=body.clarification.question
                        if body.clarification
                        else "",
                    )
                if (
                    body.clarification
                    and body.clarification.revision
                    and request_revision is None
                ):
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "stale_compound_clarification"
                    metadata["completion_disposition"] = "unverified"
                    yield make_event(
                        "message.delta",
                        text="This clarification has expired or was replaced. Please send the complete request again. No changes have been made.",
                    )
                    yield make_event("done", saved=False)
                    return
                if (
                    shopping_resume is not None
                    or (body.clarification and body.clarification.revision)
                    or not (body.ticket or (address_request and not body.clarification))
                ):
                    if shopping_resume is not None:
                        assert shopping_resume_question is not None
                    admission = LanguageAdmissionState(body, clarification_reply)
                    try:
                        admission_stop = await admit_language(
                            admission,
                            ports=LanguageAdmissionPorts(
                                context=prepared.context,
                                config=config,
                                tenant_id=caller.tenant,
                                models=tracked,
                                budget=store,
                                retrieve_intent_examples=prepared.retrieve_intent_examples,
                                select_provider=routing.language_provider,
                                lookup_cart_product=(
                                    lambda query: commerce_tools().search_cart_product(
                                        query
                                    )
                                )
                                if caller.subject is not None
                                else None,
                            ),
                            history=history,
                            metadata=metadata,
                            shopping_question=shopping_resume_question,
                        )
                    finally:
                        # Preserve partial progress for completion/error telemetry
                        # even when an admission dependency raises or is cancelled.
                        body = admission.body
                        interpretation = admission.interpretation
                        clarification_reply = admission.clarification_reply
                        selected_followup = admission.selected_followup
                        original_followup_message = admission.original_followup_message
                        language_fallback = admission.language_fallback
                        gate_route = admission.gate_route
                    if isinstance(admission_stop, LanguageBudgetBlocked):
                        yield make_event(
                            "message.delta",
                            text="The assistant model budget is currently unavailable. You can browse the catalog or open a support ticket.",
                            code="unavailable",
                        )
                        yield make_event("done")
                        return
                routed_request = (
                    interpretation.result
                    if interpretation is not None
                    and isinstance(interpretation.result, InterpretedRequest)
                    else None
                )
                # Only an explicit UNKNOWN may enter model-assisted paths.
                if routed_request is not None and routed_request.status != "UNKNOWN":
                    if gate_route == "search" and (
                        (
                            shopping_resume is None
                            and shopping_plan(routed_request, body.message) is None
                        )
                        or (
                            "semantic_read_recovery" in metadata
                            and not prepared.has_catalog
                        )
                    ):
                        gate_route = "unmapped"
                    metadata["language_gate"] = diagnostic_summary(
                        interpretation.result if interpretation else None, gate_route
                    )
                    if (
                        gate_route in {"search", "cart", "order", "reorder"}
                        and routed_request.legacy_intent
                        not in cart_actions.WRITE_INTENTS
                        and not (body.order_id and gate_route == "order")
                    ):
                        yield make_event(
                            "message.delta", text=routed_request.message + "\n\n"
                        )
                if (
                    routed_request is not None
                    and (review := review_compound(routed_request)) is not None
                ):
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "compound_request_review"
                    metadata["compound_review"] = review.state
                    metadata["completion_disposition"] = (
                        "clarification" if review.needs_reply else "unverified"
                    )
                    compound_request = CompoundRequest(
                        body.request_id,
                        body.conversation_id,
                        request_revision,
                        compound_input_hash,
                        body.message,
                    )
                    preparation = await prepare_compound_review(
                        review,
                        routed_request,
                        caller,
                        compound_request,
                        storage=compound_storage,
                        commerce_tools=commerce_tools,
                        store_available=bool(store),
                        planning_enabled="commerce_planning" in config.feature_flags,
                        execution_enabled="compound_execution" in config.feature_flags,
                    )
                    plan_message = None
                    choice_block = None
                    if isinstance(
                        preparation, (PreparedCompound, CompoundPreparationFailed)
                    ):
                        metadata["route_reason"] = "compound_plan_review"
                        if isinstance(preparation, CompoundPreparationFailed):
                            plan_message = preparation.text
                        else:
                            plan = preparation.plan
                            plan_message, choice_block = plan.text, plan.choice
                            if choice_block:
                                metadata["completion_disposition"] = "clarification"
                            metadata["compound_plan_id"] = str(plan.plan_id)
                            metadata["compound_action_states"] = list(
                                plan.action_states
                            )
                            if plan.verified_receipts:
                                metadata.pop("completion_disposition", None)
                                metadata["completion_evidence"] = "action_receipt"
                                metadata["route_reason"] = (
                                    "compound_execution_completed"
                                )
                    published_question = await publish_compound_clarification(
                        review,
                        caller,
                        compound_request,
                        publisher=persistence.questions,
                        store_available=bool(store),
                    )
                    question = (
                        {
                            "original_message": published_question.original_message,
                            "question": published_question.question,
                            "revision": published_question.revision,
                        }
                        if published_question is not None
                        else None
                    )
                    yield make_event(
                        "message.delta",
                        text=(plan_message or review.message)
                        + (
                            " Please send the complete request again to continue."
                            if review.needs_reply and question is None
                            else ""
                        ),
                        **({"clarification": question} if question else {}),
                    )
                    if choice_block:
                        yield make_event(
                            "content.blocks",
                            blocks=[
                                {
                                    "kind": "text",
                                    "text": compound_planning.PRODUCT_CHOICE_MESSAGE,
                                },
                                choice_block,
                            ],
                        )
                elif (
                    routed_request is not None
                    and routed_request.legacy_intent == "PRODUCT_ACTION_CHOICE"
                    and routed_request.status == "NEEDS_CONTEXT"
                ):
                    prompts = product_prompts(routed_request)
                    routing.select("discovery", deterministic=True)
                    metadata["route_reason"] = "product_action_choice"
                    yield make_event(
                        "message.delta",
                        text=prompt_message(prompts),
                    )
                    for offset in range(0, len(prompts), 8):
                        yield make_event(
                            "content.blocks",
                            blocks=[
                                {
                                    "kind": "product_prompt",
                                    "product_prompt": prompt.model_dump(),
                                }
                                for prompt in prompts[offset : offset + 8]
                            ],
                        )
                elif routed_request is not None and gate_route == "denied":
                    routing.select("general", deterministic=True)
                    metadata["resolution_status"] = "DENIED"
                    metadata["route_reason"] = "access_denied"
                    yield make_event(
                        "message.delta",
                        text=ToolDenied().message,
                        code="support_required",
                    )
                elif address_request and not body.clarification:
                    routing.select("general", deterministic=True)
                    async with aclosing(
                        saved_address_events(
                            authenticated=caller.subject is not None,
                            metadata=metadata,
                            make_event=make_event,
                        )
                    ) as events:
                        async for event in events:
                            yield event
                elif (
                    routed_request is not None
                    and (handler := standard_handler(gate_route)) is not None
                ):
                    routing.select(handler.journey, deterministic=True)
                    handler_context = HandlerContext(
                        request=routed_request,
                        authenticated=caller.subject is not None,
                        message=body.message,
                        commerce_tools=commerce_tools,
                        metadata=metadata,
                        make_event=make_event,
                        product_id=body.product_id,
                        order_id=body.order_id,
                        cart_selection=CartSelection(
                            product_id=body.product_id,
                            intent=selected_followup.intent,
                            product=selected_followup.product,
                            confirmed=selected_followup.confirmed,
                        )
                        if selected_followup
                        else None,
                    )
                    async with aclosing(handler.events(handler_context)) as events:
                        async for event in events:
                            yield event
                elif routed_request is not None and gate_route == "unsupported":
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "unsupported_capability"
                    yield make_event(
                        "message.delta",
                        text=routed_request.message
                        or "This capability is not supported. No changes have been made.",
                    )
                elif gate_route == "unavailable":
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "language_engine_unavailable"
                    yield make_event(
                        "message.delta",
                        text="I couldn't check your request with the language engine. Please try again shortly.",
                        code="unavailable",
                    )
                elif routed_request is not None and gate_route == "unmapped":
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "resolved_intent_without_capability"
                    yield make_event(
                        "message.delta",
                        text="I understood your request, but this store action is not connected to a live commerce capability yet. Please use the matching store page or contact support.",
                        code="unknown",
                    )
                elif routed_request is not None and gate_route == "conversation":
                    from app.commerce_action_engine.application.handlers.conversation import (
                        conversation_reply,
                    )

                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "agent_conversation"
                    metadata["completion_evidence"] = "conversation_reply"
                    yield make_event(
                        "message.delta",
                        text=conversation_reply(routed_request.legacy_intent),
                    )
                elif routed_request is not None and gate_route in {
                    "handoff",
                    "context",
                }:
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "language_engine_" + gate_route
                    yield make_event(
                        "message.delta",
                        text=policy_answers.match(body.message)
                        or guidance(routed_request),
                    )
                elif (
                    gate_route == "clarify"
                    and interpretation is not None
                    and isinstance(interpretation.result, InterpretedRequest)
                ):
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "language_engine_clarify"
                    yield clarification_event(
                        interpretation.result,
                        body.message,
                        allow_reply=not language_fallback,
                        make_event=make_event,
                    )
                elif routed_request is not None and gate_route in {
                    "engine_response",
                    "guided_action",
                }:
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "language_engine_" + gate_route
                    yield make_event(
                        "message.delta",
                        text=routed_request.message
                        if gate_route != "guided_action"
                        else routed_request.message + "\n\n" + guidance(routed_request),
                    )
                elif body.ticket:
                    routing.select("general", deterministic=True)
                    async with aclosing(
                        support_create_events(
                            submission=body.ticket,
                            commerce_tools=commerce_tools,
                            metadata=metadata,
                            make_event=make_event,
                        )
                    ) as events:
                        async for event in events:
                            yield event
                elif policy_answer := policy_answers.match(body.message):
                    routing.select("general", deterministic=True)
                    metadata["route_reason"] = "exact_policy"
                    metadata["completion_evidence"] = "policy_answer"
                    yield make_event("message.delta", text=policy_answer)
                elif (
                    gate_route == "cart"
                    if routed_request is not None
                    and routed_request.status == "RESOLVED"
                    and routed_request.confidence.raw >= 0.65
                    else intent_frame.route == "cart"
                    if intent_frame is not None
                    else any(
                        word in body.message.lower() for word in ("cart", "basket")
                    )
                ):
                    routing.select("cart", deterministic=True)
                    async with aclosing(
                        cart_read_events(
                            authenticated=caller.subject is not None,
                            commerce_tools=commerce_tools,
                            metadata=metadata,
                            make_event=make_event,
                        )
                    ) as events:
                        async for event in events:
                            yield event
                elif (
                    gate_route == "delivery"
                    if routed_request is not None
                    and routed_request.status == "RESOLVED"
                    else intent_frame.route == "delivery"
                    if intent_frame is not None
                    else any(
                        word in body.message.lower()
                        for word in (
                            "deliver",
                            "delivery area",
                            "ship to",
                            "shipping area",
                        )
                    )
                ):
                    routing.select("general", deterministic=True)
                    async with aclosing(
                        delivery_events(
                            commerce_tools=commerce_tools,
                            metadata=metadata,
                            make_event=make_event,
                        )
                    ) as events:
                        async for event in events:
                            yield event
                elif not (prepared.has_catalog) and any(
                    word in body.message.lower()
                    for word in (
                        "recommend",
                        "product",
                        "snack",
                        "breakfast",
                        "luxury",
                    )
                ):
                    metadata["route_reason"] = "catalog_unavailable"
                    routing.select("discovery", deterministic=True)
                    yield make_event(
                        "message.delta",
                        text="Product recommendations are not available until we can verify stock for your delivery area. You can browse the catalog or ask our support team.",
                        code="area_unavailable",
                    )
                elif (
                    intent_frame.route == "order"
                    if intent_frame is not None
                    else any(
                        word in body.message.lower() for word in ("order", "track")
                    )
                ):
                    metadata["route_reason"] = "order_guidance"
                    routing.select("order", deterministic=True)
                    yield make_event(
                        "message.delta",
                        text="Choose an order from My orders to ask about its status."
                        if caller.subject
                        else "Please sign in to view your orders.",
                        code="unknown" if caller.subject else "login_required",
                    )
                else:
                    routing.select(
                        "discovery" if prepared.has_catalog else "general",
                        deterministic=gate_route == "search",
                    )
                    metadata["route_reason"] = (
                        "language_engine_search"
                        if gate_route == "search"
                        else "catalog_model"
                        if prepared.has_catalog
                        else "general_model"
                        if routing.runtime
                        else "unconfigured_model"
                    )
                    if (
                        routing.runtime
                        and gate_route == "fallback"
                        and store
                        and not await store.model_budget_available(
                            caller.tenant,
                            body.conversation_id,
                            config.model_daily_token_budget,
                            config.model_session_token_budget,
                        )
                    ):
                        metadata.update(
                            {
                                "route_reason": "model_budget_exhausted",
                                "budget_blocked": True,
                            }
                        )
                        yield make_event(
                            "message.delta",
                            text="The assistant model budget is currently unavailable. You can browse the catalog or open a support ticket.",
                            code="unavailable",
                        )
                        yield make_event("done")
                        return
                    if routing.runtime:
                        from functools import partial

                        from app.commerce_action_engine.application.shopping import (
                            shopping_answer,
                        )

                        shopping_override = (
                            partial(
                                shopping_answer,
                                domain_evidence=(
                                    routing.runtime.shopping_handler.keywords.get(
                                        "domain_evidence"
                                    )
                                    if isinstance(
                                        routing.runtime.shopping_handler, partial
                                    )
                                    else None
                                ),
                                interpretation=interpretation.result
                                if interpretation
                                else None,
                                shopping_resume=shopping_resume,
                                shopping_resume_revision=shopping_resume_revision,
                                shopping_resume_question=shopping_resume_question,
                            )
                            if (
                                routing.runtime.shopping_handler is shopping_answer
                                or (
                                    isinstance(
                                        routing.runtime.shopping_handler, partial
                                    )
                                    and routing.runtime.shopping_handler.func
                                    is shopping_answer
                                )
                            )
                            else None
                        )
                        runtime_responses = ShoppingRuntimeResponses(
                            scope=ShoppingResponseScope(
                                tenant_id=caller.tenant,
                                owner_id=shopping_owner,
                                store_id=shopping_store_id,
                                session_id=shopping_session_id,
                                conversation_id=body.conversation_id,
                                request_revision=request_revision,
                                message=body.message,
                            ),
                            active_writer=shopping_storage.active_publication,
                            question_publisher=shopping_storage.publication,
                            metadata=metadata,
                            model_provider=active_config.model_provider,
                        )
                        async with aclosing(
                            routing.runtime.stream(
                                agent_id="shopper",
                                principal=caller,
                                message=body.message,
                                history=history,
                                shopping_handler=shopping_override,
                                fallback_message=reasoning_fallback_message(
                                    interpretation.result if interpretation else None
                                ),
                            )
                        ) as runtime_events:
                            async for runtime_event in runtime_events:
                                response = await runtime_responses.handle(runtime_event)
                                if response is not None:
                                    yield make_event(response.kind, **response.fields)
                    else:
                        length = 0
                        fallback_model_used = prepared.fallback_model_configured
                        async with aclosing(
                            stream_chat(
                                provider,
                                question=body.message,
                                max_tokens=1024,
                            )
                        ) as chunks:
                            async for chunk in chunks:
                                length += len(chunk)
                                if length > 8000:
                                    raise ToolUnavailable()
                                yield make_event("message.delta", text=chunk)
                saved = await finalization.persist(
                    question=original_followup_message or body.message,
                    outcome=outcome,
                    clarification_reply=clarification_reply,
                    prior_completion=prior_completion,
                    fallback_model_used=fallback_model_used,
                )
                yield make_event("done", saved=saved)
        except ToolDenied as error:
            outcome = "denied"
            metadata["resolution_status"] = "DENIED"
            metadata["route_reason"] = "access_denied"
            yield make_event(
                "message.delta", text=error.message, code="support_required"
            )
            yield make_event("done")
        except (asyncio.CancelledError, GeneratorExit):
            outcome = "disconnected"
            raise
        except Exception as error:  # noqa: BLE001 -- fail-closed provider boundary
            outcome = "unavailable"
            safe = classify(error, body.request_id)
            metadata["failure_code"] = safe.code
            metadata["recovery"] = safe.recovery
            logging.getLogger("assistant").warning(
                "assistant_request_failed request_id=%s code=%s retryable=%s recovery=%s",
                body.request_id,
                safe.code,
                safe.retryable,
                safe.recovery,
            )
            if "typed_errors" in config.feature_flags:
                yield make_event(
                    "error",
                    text=safe.message,
                    code="unavailable",
                    failure=safe.model_dump(mode="json"),
                )
            else:
                yield make_event(
                    "error",
                    text="Assistant temporarily unavailable. Retry or open a support ticket.",
                    code="unavailable",
                )
            yield make_event("done")
        finally:
            if admission is not None:
                admission.close()
            if memory_token is not None:
                personalization.reset(memory_token)
            await finalization.finish(
                outcome=outcome,
                clarification_reply=clarification_reply,
                prior_completion=prior_completion,
            )
