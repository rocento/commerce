"""Conflicting policy and product evidence must never be selected by rank."""

import asyncio
from uuid import uuid4

import pytest
from test_knowledge import AGENT, SOURCE, WHO, Embeddings, Index, hit
from test_product_facts import ring

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.product_facts import factual_product
from app.commerce_knowledge_rag import KnowledgeError, Retriever


def test_same_title_policy_sources_fail_closed_even_below_score_cutoff():
    other = SOURCE.model_copy(update={"id": uuid4(), "title": "  RETURNS  POLICY "})
    with pytest.raises(KnowledgeError, match="policy_source_conflict"):
        asyncio.run(
            Retriever(
                Embeddings(), Index([hit(), hit("Return in 7 days", 0.1, other)])
            ).retrieve(AGENT, WHO, "returns")
        )


def test_inaccessible_policy_does_not_block_visible_policy():
    other = SOURCE.model_copy(
        update={"id": uuid4(), "permissions": frozenset({"private"})}
    )
    result = asyncio.run(
        Retriever(Embeddings(), Index([hit(), hit("private", 0.9, other)])).retrieve(
            AGENT, WHO, "returns"
        )
    )
    assert len(result) == 1


def test_card_does_not_display_contradictory_aliases():
    product = Product.model_validate(ring())
    from app.commerce_action_engine.actions.catalog import Attribute

    product = product.model_copy(
        update={
            "attributes": [
                Attribute(name="material", value="gold", source="MERCHANT"),
                Attribute(name="metal", value="silver", source="VERIFIED"),
            ]
        }
    )
    assert not factual_product(product).attributes


def test_exact_guide_cannot_mix_source_revisions():
    from pydantic import ValidationError

    from app.commerce_action_engine.actions.policy import PolicyAnswers

    source = {
        "id": "guide:returns",
        "title": "Returns",
        "revision": 1,
        "approved_at": "2026-01-01T00:00:00Z",
        "valid_until": "2099-01-01T00:00:00Z",
    }
    with pytest.raises(ValidationError, match="Conflicting exact guide"):
        PolicyAnswers.model_validate(
            {
                "schema_version": "2",
                "tenant_id": str(uuid4()),
                "answers": [
                    {"phrases": ["returns?"], "answer": "30 days", "source": source},
                    {
                        "phrases": ["return time?"],
                        "answer": "7 days",
                        "source": {**source, "revision": 2},
                    },
                ],
            }
        )


def test_conflicting_approved_knowledge_cannot_reach_model_composition():
    from test_runtime import FakeProvider, consume, final

    from app.commerce_action_engine.adapters.runtime_knowledge import RuntimeKnowledge
    from app.commerce_action_engine.execution.agents import AgentCatalog
    from app.commerce_resolution_engine.runtime import AgentRuntime

    other = SOURCE.model_copy(update={"id": uuid4()})
    provider = FakeProvider([final("Unsafe arbitrary policy")])
    runtime = AgentRuntime(
        AgentCatalog((AGENT,)),
        {"test": provider},
        (),
        retriever=RuntimeKnowledge(
            Retriever(Embeddings(), Index([hit(), hit("Other policy", 0.9, other)]))
        ),
    )
    events = asyncio.run(consume(runtime, who=WHO, message="returns"))
    assert "conflicts" in events[-1].answer.text
    assert not provider.requests
