"""Reviewed prefix recovery retains current values and validates a single read."""

import asyncio
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from pydantic import ValidationError
from test_enterprise_contracts import context as turn_context
from test_language_fallback import unknown

from app.commerce_action_engine.actions.shopping.pricing import retain_price_bounds
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.semantic_recovery import (
    recover_read,
    retrieve_examples,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.semantic_recovery import (
    read_candidates,
)
from app.commerce_contracts.intent_example import IntentEvidence, IntentExample


def evidence(prefix="could ya rustle up", target="find"):
    example = IntentExample.model_validate(
        {
            "id": "rustle-up",
            "intent": "PRODUCT_SEARCH" if target == "find" else "PRODUCT_RECOMMEND",
            "utterance": prefix + " two bananas under 20 EGP",
            "canonical_text": target + " two bananas under 20 EGP",
            "review": {
                "label": "positive",
                "expected_status": "RESOLVED",
                "family": "rustle",
                "split": "train",
                "provenance": "synthetic",
                "review_status": "approved",
                "recovery": {"from_prefix": prefix, "to_prefix": target},
            },
        }
    )
    return IntentEvidence(
        example=example,
        source_id=UUID(int=1),
        revision=1,
        chunk_id="a" * 64,
        validation_fingerprint="b" * 64,
        embedding_score=0.99,
    )


def test_current_suffix_is_the_only_source_of_product_quantity_price_and_comparator():
    message = "could ya rustle up three apples under 150 EGP"
    (candidate,) = read_candidates(message, (evidence(),))
    assert candidate.canonical_text == "find three apples under 150 EGP"
    assert (
        "bananas" not in candidate.canonical_text
        and "20" not in candidate.canonical_text
    )
    assert retain_price_bounds({}, candidate.canonical_text)["exclusive_max"] is True
    (inclusive,) = read_candidates(message.replace("under", "up to"), (evidence(),))
    assert retain_price_bounds({}, inclusive.canonical_text)["exclusive_max"] is False


@pytest.mark.parametrize(
    "message",
    [
        "could ya rustle up milk and add two",
        "could ya rustle up milk then delete my cart",
        "could ya rustle up milk without nuts",
        "do not could ya rustle up milk",
        "could ya rustle up milk if cheap",
        "could ya rustle up milk or bread",
        "could ya rustle up",
        '"could ya rustle up milk"',
        "unrelated bananas",
    ],
)
def test_compound_negative_conditional_quoted_or_unmatched_input_is_not_a_read_candidate(
    message,
):
    assert not read_candidates(message, (evidence(),))


def test_similarity_alone_and_nontraining_records_never_admit_recovery():
    e = evidence()
    assert e.example.review
    for fields in [
        {"split": "test"},
        {"review_status": "pending"},
        {"recovery": None},
        {"context_requirements": ["PRODUCT_VISIBLE"]},
    ]:
        changed = e.model_copy(
            update={
                "example": e.example.model_copy(
                    update={"review": e.example.review.model_copy(update=fields)}
                )
            }
        )
        assert not read_candidates("could ya rustle up milk", (changed,))
    assert not read_candidates(
        "could ya rustle up milk",
        (e.model_copy(update={"validation_fingerprint": None}),),
    )


def test_patterns_cannot_rename_neighbor_values_or_attach_to_a_write():
    payload = evidence().example.model_dump()
    payload["canonical_text"] = "find three apples under 150 EGP"
    with pytest.raises(ValidationError):
        IntentExample.model_validate(payload)
    payload = evidence().example.model_dump()
    payload["intent"] = "ADD_TO_CART"
    with pytest.raises(ValidationError):
        IntentExample.model_validate(payload)


@pytest.fixture(scope="module")
def real_reads():
    script = """
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';import {resolve} from './app/commerce_language_engine/src/engine.ts';const c=await loadRuntime();console.log(JSON.stringify(resolve(c,'find three apples under 150 EGP')));
"""
    root = Path(__file__).resolve().parents[1]
    return gate.Resolution.model_validate_json(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script], cwd=root, text=True
        )
    )


def test_recovery_uses_standard_node_decision_and_never_neighbor_values(
    monkeypatch, real_reads
):
    context = turn_context.__wrapped__()
    original = interpret_resolution(unknown(), context)
    resolve = AsyncMock(return_value=real_reads)
    monkeypatch.setattr(gate, "resolve", resolve)
    decision = asyncio.run(
        recover_read(
            "http://engine",
            original,
            "could ya rustle up three apples under 150 EGP",
            (evidence(),),
            context=context,
            timeout=1,
        )
    )
    assert decision.route == "search"
    assert decision.result.request_id == context.actor.request_id
    assert decision.result.entities["quantity"] == 3
    assert decision.result.entities["productText"] == "apples"
    resolve.assert_awaited_once_with("http://engine", "find three apples under 150 EGP")


def test_conflicting_patterns_clarify_without_trying_both(monkeypatch):
    context = turn_context.__wrapped__()
    original = interpret_resolution(unknown(), context)
    resolve = AsyncMock()
    monkeypatch.setattr(gate, "resolve", resolve)
    decision = asyncio.run(
        recover_read(
            "url",
            original,
            "could ya rustle up milk",
            (evidence(), evidence(target="recommend")),
            context=context,
            timeout=1,
        )
    )
    assert decision.result.status == "NEEDS_CONTEXT"
    resolve.assert_not_awaited()


def test_retrieval_timeout_does_not_retry_and_propagates_external_cancellation():
    async def slow(_):
        await asyncio.Event().wait()

    async def run():
        retrieved = await retrieve_examples(slow, "milk", 0.001)
        assert (
            retrieved.evidence == ()
            and retrieved.metadata["embedding_query_attempts"] == 1
        )
        assert retrieved.metadata["status"] == "unavailable"
        task = asyncio.create_task(retrieve_examples(slow, "milk", 1))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())


@pytest.mark.parametrize(
    "status",
    ["RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "DENIED", "UNSUPPORTED", "UNAVAILABLE"],
)
def test_recovery_cannot_reopen_nonunknown_or_failed_interpretations(
    monkeypatch, status
):
    from test_language_fallback import resolved

    context = turn_context.__wrapped__()
    original = interpret_resolution(
        None if status == "UNAVAILABLE" else resolved(status=status), context
    )
    resolve = AsyncMock()
    monkeypatch.setattr(gate, "resolve", resolve)
    assert (
        asyncio.run(
            recover_read(
                "url",
                original,
                "could ya rustle up milk",
                (evidence(),),
                context=context,
                timeout=1,
            )
        )
        is original
    )
    resolve.assert_not_awaited()


def test_language_validation_outage_is_not_converted_back_to_unknown(monkeypatch):
    context = turn_context.__wrapped__()
    original = interpret_resolution(unknown(), context)
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=None))
    result = asyncio.run(
        recover_read(
            "url",
            original,
            "could ya rustle up milk",
            (evidence(),),
            context=context,
            timeout=1,
        )
    )
    assert result.route == "unavailable" and not result.allows_fallback


def test_embedding_budget_is_opt_in_and_bounded(monkeypatch):
    from app.commerce_action_engine.platform.settings import Settings

    assert Settings().semantic_recovery_embedding_budget == 0
    monkeypatch.setenv("AI_FEATURE_FLAGS", "semantic_read_recovery")
    monkeypatch.setenv("AI_SEMANTIC_RECOVERY_EMBEDDING_BUDGET", "1")
    assert Settings.environment().semantic_recovery_embedding_budget == 1
    monkeypatch.setenv("AI_SEMANTIC_RECOVERY_EMBEDDING_BUDGET", "2")
    with pytest.raises(ValueError, match="budget"):
        Settings.environment()


def test_recovery_checks_real_unknown_partial_fields_against_real_node(
    monkeypatch, real_reads
):
    script = """
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';import {resolve} from './app/commerce_language_engine/src/engine.ts';console.log(JSON.stringify(resolve(await loadRuntime(),'could ya rustle up three apples under 150 EGP')));
"""
    root = Path(__file__).resolve().parents[1]
    wire = gate.Resolution.model_validate_json(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script], cwd=root, text=True
        )
    )
    context = turn_context.__wrapped__()
    original = interpret_resolution(wire, context)
    assert original.allows_fallback and original.result.entities["currency"] == "EGP"
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=real_reads))
    decision = asyncio.run(
        recover_read(
            "url",
            original,
            "could ya rustle up three apples under 150 EGP",
            (evidence(),),
            context=context,
            timeout=1,
        )
    )
    assert decision.route == "search"
    assert all(
        decision.result.entities[k] == v for k, v in original.result.entities.items()
    )


def test_prefix_schema_cannot_consume_product_or_constraint_values():
    from app.commerce_contracts.intent_example import ReadRecoveryPattern

    for prefix in ["rustle up organic", "rustle up apples", "get me red", "remove all"]:
        with pytest.raises(ValidationError):
            ReadRecoveryPattern(from_prefix=prefix, to_prefix="find")
    assert not read_candidates("could ya rustle up حليب", (evidence(),))
