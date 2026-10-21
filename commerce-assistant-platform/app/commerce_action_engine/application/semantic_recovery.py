"""One embedding retrieval shared by read recovery and the existing model fallback."""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import (
    InterpretationDecision,
    interpret_resolution,
)
from app.commerce_action_engine.application.language_proposals import (
    accept_proposal,
    clarification,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.semantic_recovery import (
    READ_RECOVERY_INTENTS,
    read_candidates,
)
from app.commerce_contracts.conversation_context import HistoryMessage, recent_exchange
from app.commerce_contracts.intent_example import IntentEvidence
from app.commerce_resolution_engine.diagnostics import capture_enabled, debug_record

Retriever = Callable[[str], Awaitable[tuple[IntentEvidence, ...]]]


@dataclass(frozen=True)
class RetrievedExamples:
    evidence: tuple[IntentEvidence, ...]
    metadata: dict[str, object]


async def retrieve_examples(
    retrieve: Retriever | None,
    message: str,
    timeout: float,
    *,
    history: Sequence[HistoryMessage] = (),
) -> RetrievedExamples:
    started = time.monotonic()
    evidence: tuple[IntentEvidence, ...] = ()
    status = "unconfigured"
    exchange = recent_exchange(message, history)
    query = (
        json.dumps(
            {"current_request": message, "untrusted_recent_exchange": exchange},
            ensure_ascii=False,
        )
        if exchange
        else message
    )
    if retrieve is not None:
        try:
            async with asyncio.timeout(timeout):
                evidence = await retrieve(query)
                if (
                    len(evidence) > 3
                    or sum(len(e.model_dump_json()) for e in evidence) > 6000
                ):
                    raise ValueError("Oversized example evidence")
            status = "retrieved" if evidence else "empty"
        except Exception:  # noqa: BLE001 -- optional retrieval failure never retries
            evidence = ()
            status = "unavailable"
    if capture_enabled():
        debug_record(
            "intent_retrieval",
            {
                "query": query,
                "status": status,
                "examples": [item.model_dump(mode="json") for item in evidence],
                "example_refs": [
                    {
                        "source_id": str(item.source_id),
                        "revision": item.revision,
                        "chunk_id": item.chunk_id,
                        "example_id": item.example.id,
                    }
                    for item in evidence
                ],
            },
        )
    return RetrievedExamples(
        evidence,
        {
            "status": status,
            "count": len(evidence),
            "latency_ms": round((time.monotonic() - started) * 1000),
            "embedding_query_attempts": int(retrieve is not None),
            "embedding_tokens": None,
            "context_message_count": len(exchange),
            "sources": [
                {
                    "source_id": str(e.source_id),
                    "revision": e.revision,
                    "chunk_id": e.chunk_id,
                    "example_id": e.example.id,
                }
                for e in evidence
            ],
        },
    )


async def recover_read(
    url: str,
    original: InterpretationDecision,
    message: str,
    evidence: tuple[IntentEvidence, ...],
    *,
    context: TurnContext,
    timeout: float,
) -> InterpretationDecision:
    if not original.allows_fallback:
        return original
    candidates = read_candidates(message, evidence)
    if not candidates:
        return original
    if len(candidates) != 1:
        return clarification(context)
    try:
        async with asyncio.timeout(timeout):
            decision = await accept_proposal(
                url, original, message, candidates[0], context=context
            )
    except TimeoutError:
        return interpret_resolution(None, context)
    result = decision.result
    if (
        isinstance(result, InterpretedRequest)
        and result.status == "RESOLVED"
        and (
            result.legacy_intent not in READ_RECOVERY_INTENTS
            or result.requires_confirmation
            or result.operations
            or result.request_type
            or result.requested_actions.intentCount != 1
            or result.requested_actions.intentCountStatus != "EXACT"
        )
    ):
        return clarification(context)
    return decision
