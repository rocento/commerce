"""Versioned review records cannot widen approved read recovery."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from test_enterprise_contracts import context as test_context
from test_intent_examples import COLLECTION, EXAMPLE, INTENT_SOURCE, record, retrieve
from test_knowledge import WRITER, Embeddings, Index, hit
from test_language_fallback import resolved

from app.commerce_action_engine.adapters.intent_examples import LanguageExampleValidator
from app.commerce_action_engine.execution.language import gate
from app.commerce_contracts.intent_example import ExampleReview, IndexedIntentExample
from app.commerce_knowledge_rag import KnowledgeError
from app.commerce_knowledge_rag.intent_examples import (
    ingest_intent_examples,
    review_examples,
)


def reviewed(**changes):
    review = ExampleReview(
        label="positive",
        expected_status="RESOLVED",
        family="cart-peek",
        split="train",
        provenance="synthetic",
        review_status="approved",
        **changes,
    )
    return EXAMPLE.model_copy(update={"review": review})


def test_normalized_duplicates_conflicts_and_split_leakage():
    a = reviewed()
    b = a.model_copy(
        update={"id": "other", "utterance": "  LET me peek at my basket  "}
    )
    assert review_examples([b, a]) == review_examples([a, b]) == [b]
    with pytest.raises(KnowledgeError, match="label_conflict"):
        review_examples([a, b.model_copy(update={"intent": "CART_TOTAL"})])
    with pytest.raises(KnowledgeError, match="family_split_conflict"):
        review_examples(
            [
                a,
                b.model_copy(
                    update={"review": a.review.model_copy(update={"split": "test"})}
                ),
            ]
        )
    with pytest.raises(KnowledgeError, match="review_required"):
        review_examples(
            [
                a.model_copy(
                    update={
                        "review": a.review.model_copy(
                            update={"review_status": "pending"}
                        )
                    }
                )
            ]
        )


def test_v2_version_is_required_and_v1_stays_compatible():
    with pytest.raises(ValidationError):
        IndexedIntentExample(
            **reviewed().model_dump(),
            schema_version="intent-example-v1",
            resolution_fingerprint="a" * 64,
        )
    assert '"review"' not in record()


@pytest.mark.parametrize(
    "change",
    [
        {"label": "negative", "expected_status": "UNKNOWN"},
        {"label": "ambiguous", "expected_status": "AMBIGUOUS"},
        {"context_requirements": ["PRODUCT_RESULTS_VISIBLE"]},
        {"split": "test"},
        {"split": "validation"},
        {"review_status": "pending"},
    ],
)
def test_nonrecoverable_v2_records_never_reach_validation_or_model(monkeypatch, change):
    a = reviewed()
    a = a.model_copy(update={"review": a.review.model_copy(update=change)})
    indexed = IndexedIntentExample(
        **a.model_dump(),
        schema_version="intent-example-v2",
        resolution_fingerprint="a" * 64,
    )
    assert (
        retrieve(monkeypatch, [hit(indexed.model_dump_json(), source=INTENT_SOURCE)])
        == ()
    )
    gate.resolve.assert_not_awaited()


def test_reviewed_frame_is_checked_against_node_before_embedding(monkeypatch):
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=resolved()))
    index, embeddings = Index(), Embeddings()
    validator = LanguageExampleValidator(
        "http://engine", test_context.__wrapped__().actor
    )
    a = reviewed(slots={"quantity": 2})
    with pytest.raises(KnowledgeError, match="incompatible"):
        asyncio.run(
            ingest_intent_examples(
                INTENT_SOURCE, [a], WRITER, embeddings, index, validator, COLLECTION
            )
        )
    assert not index.writes and embeddings.calls == 0


def test_v2_publication_retrieval_and_idempotence(monkeypatch):
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=resolved()))
    index, embeddings = Index(), Embeddings()
    validator = LanguageExampleValidator(
        "http://engine", test_context.__wrapped__().actor
    )
    assert asyncio.run(
        ingest_intent_examples(
            INTENT_SOURCE,
            [reviewed()],
            WRITER,
            embeddings,
            index,
            validator,
            COLLECTION,
        )
    )
    stored = index.writes[0][2][0].text
    assert (
        IndexedIntentExample.model_validate_json(stored).schema_version
        == "intent-example-v2"
    )
    evidence = retrieve(monkeypatch, [hit(stored, source=INTENT_SOURCE)])
    assert len(evidence) == 1
    assert evidence[0].embedding_score == 0.9
    assert evidence[0].validation_fingerprint is not None
    index.cached = True
    count = embeddings.calls
    assert not asyncio.run(
        ingest_intent_examples(
            INTENT_SOURCE,
            [reviewed()],
            WRITER,
            embeddings,
            index,
            validator,
            COLLECTION,
        )
    )
    assert embeddings.calls == count


@pytest.mark.parametrize(
    "corpus_file",
    [
        "intent-examples.reviewed-v2.en.json",
        "intent-examples.recovery-v1.en.json",
        "intent-examples.discovery-v2.en.json",
    ],
)
def test_reviewed_corpus_matches_real_engine_and_publishes_versioned_records(
    monkeypatch,
    corpus_file,
):
    import json
    import subprocess
    from pathlib import Path

    from pydantic import TypeAdapter

    from app.commerce_contracts.intent_example import IntentExample

    root = Path(__file__).resolve().parents[1]
    examples = TypeAdapter(list[IntentExample]).validate_json(
        (root / "knowledge" / corpus_file).read_bytes()
    )
    script = """
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';
import {resolve} from './app/commerce_language_engine/src/engine.ts';
const c=await loadRuntime();const texts=JSON.parse(process.argv[1]);
console.log(JSON.stringify(Object.fromEntries(texts.map(t=>[t,resolve(c,t)]))));
"""
    results = json.loads(
        subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                script,
                json.dumps([e.canonical_text for e in examples]),
            ],
            cwd=root,
            text=True,
        )
    )
    monkeypatch.setattr(
        gate,
        "resolve",
        AsyncMock(
            side_effect=lambda url, text: gate.Resolution.model_validate(results[text])
        ),
    )
    index = Index()
    validator = LanguageExampleValidator(
        "http://engine", test_context.__wrapped__().actor
    )
    for example in examples:
        assert asyncio.run(validator(example)) is not None, example.id
    assert asyncio.run(
        ingest_intent_examples(
            INTENT_SOURCE, examples, WRITER, Embeddings(), index, validator, COLLECTION
        )
    )
    assert len(index.writes[0][2]) == len(examples)
    assert all(
        IndexedIntentExample.model_validate_json(c.text).schema_version
        == "intent-example-v2"
        for c in index.writes[0][2]
    )
