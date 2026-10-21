"""Publish and retrieve typed intent examples using the approved knowledge index."""

import asyncio
import hashlib
import json
import unicodedata
from typing import Protocol

from pydantic import ValidationError

from app.commerce_contracts.agents import (
    Agent,
    KnowledgePolicy,
    Principal,
)
from app.commerce_contracts.intent_example import (
    IndexedIntentExample,
    IntentEvidence,
    IntentExample,
)
from app.commerce_knowledge_rag.service import (
    Chunk,
    Embedder,
    Hit,
    KnowledgeError,
    KnowledgeIndex,
    Retriever,
    Source,
    validate_vectors,
)

# First-release corpus covers reads only. Existing write interpretation still
# follows the ordinary proposal/authorization path; examples grant no capability.
EXAMPLE_INTENTS = frozenset(
    {
        "PRODUCT_SEARCH",
        "PRODUCT_RECOMMEND",
        "VIEW_CART",
        "CART_TOTAL",
        "CART_ITEM_COUNT",
        "TRACK_ORDER",
        "ORDER_HISTORY",
        "ORDER_DETAILS",
        "VIEW_WISHLIST",
        "ACCOUNT_ADDRESS_LIST",
        "DELIVERY_STATUS",
    }
)
MAX_EXAMPLES = 3
MAX_CHARACTERS = 6000


class IntentExampleValidator(Protocol):
    """Return the active semantic fingerprint, or None for incompatible wording.

    The application supplies language resolution and its read-route validation.
    Knowledge retains the intent allowlist and compares indexed fingerprints.
    """

    async def __call__(self, example: IntentExample) -> str | None: ...


async def _fingerprint(
    validator: IntentExampleValidator, example: IntentExample
) -> str | None:
    if example.review is not None and example.review.review_status != "approved":
        return None
    if (
        example.review is None or example.review.label == "positive"
    ) and example.intent not in EXAMPLE_INTENTS:
        return None
    return await validator(example)


async def ingest_intent_examples(
    source: Source,
    examples: list[IntentExample],
    principal: Principal,
    embedder: Embedder,
    index: KnowledgeIndex,
    validator: IntentExampleValidator,
    collection: str,
) -> bool:
    """Validate all records before embedding or atomically replacing the source.

    Each record is one intact JSON chunk. Embed its reviewed shopper wording,
    not a document containing unrelated facts or split JSON fragments.
    """
    if (
        not collection
        or source.collection != collection
        or source.kind != "imported"
        or source.language != "en"
        or principal.tenant != source.tenant
        or principal.persona != "merchant"
        or principal.subject is None
        or "knowledge.write" not in principal.permissions
        or not source.current()
    ):
        raise KnowledgeError("approval_required")
    if not 1 <= len(examples) <= 128 or len({e.id for e in examples}) != len(examples):
        raise KnowledgeError("invalid_intent_examples")
    # Stable identities and splits are reviewed before embedding; duplicate pairs
    # collapse deterministically while conflicting semantics fail the whole batch.
    examples = review_examples(examples)
    chunks: list[Chunk] = []
    for example in examples:
        fingerprint = await _fingerprint(validator, example)
        if fingerprint is None:
            raise KnowledgeError("incompatible_intent_example")
        record = IndexedIntentExample(
            **example.model_dump(exclude_none=True),
            schema_version="intent-example-v2"
            if example.review
            else "intent-example-v1",
            resolution_fingerprint=fingerprint,
        )
        text = record.model_dump_json(exclude_none=True)
        if len(text) > 1200:
            raise KnowledgeError("chunk_limit")
        chunks.append(
            Chunk(hashlib.sha256(text.encode()).hexdigest(), 1, len(chunks), text)
        )
    digest = hashlib.sha256(json.dumps([c.text for c in chunks]).encode()).hexdigest()
    approved = source.model_copy(update={"approved_by": principal.subject})
    if await index.unchanged(approved, digest, embedder.model):
        return False
    preflight = getattr(index, "validate_example_chunks", None)
    if preflight is not None:
        await preflight(approved, chunks, embedder.model)
    vectors: list[list[float]] = []
    for start in range(0, len(examples), 16):
        batch = examples[start : start + 16]
        embeddings = await embedder.embed([e.utterance for e in batch])
        validate_vectors(embeddings, len(batch))
        vectors.extend(embeddings)
    return await index.replace(approved, digest, chunks, vectors, embedder.model)


class IntentExampleRetriever:
    def __init__(
        self,
        retriever: Retriever,
        agent: Agent,
        principal: Principal,
        collection: str,
        validator: IntentExampleValidator,
    ):
        self.retriever = retriever
        self.agent = agent.model_copy(
            update={
                "knowledge": KnowledgePolicy(
                    sources=frozenset({collection}),
                    max_documents=MAX_EXAMPLES,
                    max_characters=MAX_CHARACTERS,
                )
            }
        )
        self.principal = principal
        self.collection = collection
        self.validator = validator

    async def retrieve(self, message: str) -> tuple[IntentEvidence, ...]:
        if not self.collection or self.agent.status != "active":
            return ()
        hits = await self.retriever.retrieve(
            self.agent,
            self.principal,
            message,
            language="en",
            kinds=frozenset({"imported"}),
        )

        async def validate(hit: Hit) -> IntentEvidence | None:
            source = hit.source
            if (
                source.approved_by is None
                or not source.current()
                or source.tenant != self.principal.tenant
                or source.collection != self.collection
                or source.kind != "imported"
                or source.language != "en"
                or self.principal.persona not in source.personas
                or not source.permissions <= self.principal.permissions
            ):
                return None
            try:
                record = IndexedIntentExample.model_validate_json(hit.chunk.text)
            except ValidationError:
                return None
            if record.review is not None and (
                record.review.label != "positive"
                or record.review.review_status != "approved"
                or record.review.context_requirements
                or record.review.split != "train"
            ):
                return None
            fingerprint = await _fingerprint(self.validator, record)
            if fingerprint is None or fingerprint != record.resolution_fingerprint:
                return None
            return IntentEvidence(
                example=IntentExample.model_validate(
                    record.model_dump(
                        exclude={"schema_version", "resolution_fingerprint"}
                    )
                ),
                source_id=source.id,
                revision=source.revision,
                chunk_id=hit.chunk.id,
                embedding_score=hit.score if record.review else None,
                validation_fingerprint=fingerprint if record.review else None,
            )

        # At most three independent read-only engine validations, under the
        # application's retrieval deadline. Cancellation propagates to all calls.
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(validate(hit)) for hit in hits[:MAX_EXAMPLES]]
        candidates = [task.result() for task in tasks]
        selected: list[IntentEvidence] = []
        seen: set[str] = set()
        for item in candidates:
            if item is not None and item.example.id not in seen:
                selected.append(item)
                seen.add(item.example.id)
        # A conflicting neighbor is a miss, never a tie broken by similarity.
        frames: dict[str, str] = {}
        unique: list[IntentEvidence] = []
        for item in selected:
            key = normalized_utterance(item.example.utterance)
            frame = json.dumps(
                {
                    "intent": item.example.intent,
                    "canonical": normalized_utterance(item.example.canonical_text),
                },
                sort_keys=True,
            )
            if key in frames:
                if frames[key] != frame:
                    return ()
                continue
            frames[key] = frame
            unique.append(item)
        return tuple(unique)


def normalized_utterance(text: str) -> str:
    """Preserve punctuation/numbers; only Unicode form, case and space fold."""
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def review_examples(examples: list[IntentExample]) -> list[IntentExample]:
    identities: dict[str, str] = {}
    families: dict[str, str] = {}
    seen: dict[str, str] = {}
    selected: list[IntentExample] = []
    ordered = (
        examples
        if all(item.review is None for item in examples)
        else sorted(examples, key=lambda item: item.id)
    )
    for example in ordered:
        identity = example.model_dump_json(exclude_none=True)
        if example.id in identities and identities[example.id] != identity:
            raise KnowledgeError("example_identity_conflict")
        identities[example.id] = identity
        review = example.review
        if review:
            if review.review_status != "approved":
                raise KnowledgeError("example_review_required")
            prior = families.setdefault(review.family, review.split)
            if prior != review.split:
                raise KnowledgeError("example_family_split_conflict")
        key = normalized_utterance(example.utterance)
        frame = json.dumps(
            {
                "intent": example.intent,
                "canonical": normalized_utterance(example.canonical_text),
                "review": review.model_dump() if review else None,
            },
            sort_keys=True,
        )
        if key in seen:
            if seen[key] != frame:
                raise KnowledgeError("example_label_conflict")
            continue
        seen[key] = frame
        selected.append(example)
    return selected
