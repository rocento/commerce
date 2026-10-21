"""Operator-only ingestion. Never mounted as a model tool or public HTTP endpoint."""

import argparse
import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import TypeAdapter

from app.commerce_action_engine.adapters.intent_examples import LanguageExampleValidator
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.platform import Settings, Store
from app.commerce_contracts.agents import Principal
from app.commerce_contracts.intent_example import IntentExample
from app.commerce_knowledge_rag import (
    KnowledgeError,
    PostgresKnowledgeIndex,
    Source,
    ingest,
)
from app.commerce_knowledge_rag.intent_examples import ingest_intent_examples
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers import ProviderConfig, build_embedder

FORMATS = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Publish approved knowledge to the AI-owned index"
    )
    parser.add_argument(
        "metadata",
        type=Path,
        help="Source JSON with explicit approved=true and increasing revision",
    )
    parser.add_argument("--file", type=Path)
    parser.add_argument(
        "--intent-examples",
        action="store_true",
        help="Publish a reviewed JSON array of intent examples to AI_INTENT_EXAMPLE_COLLECTION",
    )
    parser.add_argument(
        "--actor",
        type=UUID,
        required=True,
        help="Operator identity recorded with approval",
    )
    parser.add_argument(
        "--delete", action="store_true", help="Withdraw source and all its chunks"
    )
    args = parser.parse_args()
    settings = Settings.environment()
    source = Source.model_validate_json(args.metadata.read_bytes())
    if str(source.tenant) != settings.tenant_id:
        raise KnowledgeError("tenant_mismatch")
    key = os.getenv("AI_KNOWLEDGE_WRITER_KEY_FILE", "")
    if not key:
        raise KnowledgeError("writer_credential_required")
    if (settings.store_host, settings.store_user) == ("ai-postgres", "ai_runtime"):
        store = Store(key, knowledge_writer=True)
    else:
        store = Store(
            key,
            knowledge_writer=True,
            host=settings.store_host,
            user=settings.store_user,
        )
    await store.open()
    try:
        index = PostgresKnowledgeIndex(store.pool)
        if args.delete:
            await index.delete(source.tenant, source.id)
            print("Source withdrawn")
            return
        formats = {".json"} if args.intent_examples else set(FORMATS)
        if not args.file or args.file.suffix.lower() not in formats:
            raise KnowledgeError("supported_file_required")
        # Bound reads before loading document bytes into the process.
        with args.file.open("rb") as handle:
            data = handle.read(5_000_001)
        embedder = build_embedder(ProviderConfig.from_settings(settings))
        if not embedder:
            raise KnowledgeError("embedding_configuration_required")
        try:
            # Possession of the separately provisioned writer credential is operator authority.
            actor = Principal(
                tenant=source.tenant,
                persona="merchant",
                subject=args.actor,
                permissions=frozenset({"knowledge.write"}),
            )
            async with asyncio.timeout(120):
                if args.intent_examples:
                    if len(data) > 5_000_000:
                        raise KnowledgeError("file_limit")
                    examples = TypeAdapter(list[IntentExample]).validate_json(data)
                    changed = await ingest_intent_examples(
                        source,
                        examples,
                        actor,
                        embedder,
                        index,
                        LanguageExampleValidator(
                            settings.language_engine_url,
                            ActorContext(
                                tenant_id=str(source.tenant),
                                store_id=str(source.tenant),
                                actor_id=str(args.actor),
                                principal_id=str(args.actor),
                                session_id=str(source.id),
                                request_id=str(uuid4()),
                                channel="admin",
                            ),
                        ),
                        settings.intent_example_collection,
                    )
                else:
                    changed = await ingest(
                        source,
                        data,
                        FORMATS[args.file.suffix.lower()],
                        actor,
                        embedder,
                        index,
                    )
            print(
                "Knowledge published"
                if changed
                else "Identical revision already indexed"
            )
        finally:
            await embedder.aclose()
    finally:
        await store.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KnowledgeError, ModelError) as error:
        raise SystemExit(str(error)) from None
    except Exception:  # noqa: BLE001 -- don't print file contents, credentials or DB errors
        raise SystemExit(
            "Knowledge command failed; check input, configuration and AI store readiness"
        ) from None
