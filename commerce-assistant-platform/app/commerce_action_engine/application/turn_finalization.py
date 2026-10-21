"""Persist turn output and finalize resources and private telemetry in order."""

import asyncio
import logging
import time
from contextlib import AbstractContextManager
from contextvars import Token

from anyio import CancelScope

from app.commerce_action_engine.actions.shopping import personalization
from app.commerce_action_engine.application.turn_dependencies import PreparedTurn
from app.commerce_action_engine.application.turn_output import TurnOutput
from app.commerce_action_engine.application.turn_routing import TurnRouting
from app.commerce_action_engine.contracts import AssistantChatInput
from app.commerce_action_engine.platform import phase
from app.commerce_resolution_engine.diagnostics import (
    IntentDebug,
    debug_record,
    finish_debug,
)


class TurnFinalization:
    def __init__(
        self,
        prepared: PreparedTurn,
        body: AssistantChatInput,
        output: TurnOutput,
        routing: TurnRouting,
        *,
        started: float,
        trace_context: AbstractContextManager[None],
        debug_token: Token[IntentDebug | None],
    ):
        self.prepared = prepared
        self.body = body
        self.output = output
        self.routing = routing
        self.started = started
        self.trace_context = trace_context
        self.debug_token = debug_token

    def record_completion(
        self,
        outcome: str,
        clarification_reply: bool,
        prior_completion: dict[str, object] | None,
    ) -> None:
        self.output.record_completion(
            outcome=outcome,
            clarification_reply=clarification_reply,
            prior_completion=prior_completion,
        )

    async def save_recovery(self, text: str, blocks: list[dict[str, object]]) -> None:
        """Recovery saves before emitting its answer, without a memory flush."""
        prepared, body = self.prepared, self.body
        store, caller = prepared.store, prepared.caller
        assert (
            store is not None
            and caller.subject is not None
            and body.conversation_id is not None
        )
        await store.save(
            caller.tenant,
            caller.subject,
            body.conversation_id,
            body.request_id,
            body.message,
            text,
            blocks,
            self.output.metadata,
        )

    async def persist(
        self,
        *,
        question: str,
        outcome: str,
        clarification_reply: bool,
        prior_completion: dict[str, object] | None,
        fallback_model_used: bool,
    ) -> bool:
        """Prepare completion, save the transcript, then flush memory before done."""
        prepared, body, output = self.prepared, self.body, self.output
        store, caller, trace = prepared.store, prepared.caller, output.trace
        metadata = output.metadata
        metadata.update(output.usage_metadata())
        metadata["response_source"] = (
            "L"
            if fallback_model_used or any(p.attempts for p in prepared.tracked.values())
            else "R"
        )
        if trace.planning:
            metadata["planning"] = {
                key: trace.planning[key]
                for key in ("playbook", "version", "reason")
                if key in trace.planning
            }
        self.record_completion(outcome, clarification_reply, prior_completion)
        if store and caller.subject and body.conversation_id:
            with phase("persistence"):
                await store.save(
                    caller.tenant,
                    caller.subject,
                    body.conversation_id,
                    body.request_id,
                    question,
                    "".join(output.answer),
                    output.blocks,
                    metadata,
                )
        await personalization.flush()
        return bool(store and caller.subject and body.conversation_id)

    async def finish(
        self,
        *,
        outcome: str,
        clarification_reply: bool,
        prior_completion: dict[str, object] | None,
    ) -> None:
        """Run after admission/memory reset, including on errors and disconnects."""
        prepared, body, output = self.prepared, self.body, self.output
        config, caller, store = prepared.config, prepared.caller, prepared.store
        persistence = prepared.persistence
        assert persistence is not None
        tracked, trace = prepared.tracked, output.trace
        metadata, answer, blocks = output.metadata, output.answer, output.blocks
        routing, started = self.routing, self.started
        trace_context, debug_token = self.trace_context, self.debug_token
        usage_metadata = output.usage_metadata
        if tracked:
            metadata.update(usage_metadata())
        self.record_completion(outcome, clarification_reply, prior_completion)
        try:
            await prepared.lease.aclose()
        finally:
            metadata.update(trace.summary())
            try:
                trace.emit(str(body.request_id), outcome)
            finally:
                trace_context.__exit__(None, None, None)
                debug_record(
                    "final_result",
                    {
                        "outcome": outcome,
                        "answer": "".join(answer),
                        "response_blocks": blocks,
                        "language_gate": metadata.get("language_gate"),
                        "route_reason": metadata.get("route_reason"),
                        "completion_evidence": metadata.get("completion_evidence"),
                        "language_fallback": metadata.get("language_fallback"),
                        "intent_retrieval": metadata.get("intent_retrieval"),
                        **output.diagnostic_evidence(),
                    },
                )
                debug_document = finish_debug(debug_token)
        if (
            debug_document
            and persistence.tracking is not None
            and config.intent_tracking_enabled
        ):
            try:
                with CancelScope(shield=True):
                    async with asyncio.timeout(2):
                        await persistence.tracking.save_tracking(
                            caller.tenant, body.request_id, debug_document
                        )
            except Exception:  # noqa: BLE001 -- diagnostics must not fail chat
                logging.getLogger("assistant").warning(
                    "assistant_tracking_save_unavailable"
                )
        if store and routing.decision_trace is not None:
            try:
                async with asyncio.timeout(2):
                    await prepared.record_trace(
                        routing.decision_trace,
                        outcome,
                        int((time.monotonic() - started) * 1000),
                        metadata,
                    )
            except Exception:  # noqa: BLE001 -- telemetry cannot take down streaming
                logging.getLogger("assistant").warning("assistant_metric_unavailable")
