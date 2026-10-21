"""Project approved retrieval hits into the resolution runtime's knowledge port."""

from collections.abc import Callable

from app.commerce_action_engine.execution.agents import Agent, Principal
from app.commerce_action_engine.execution.planning.library import (
    GoalInput,
    LocalReceipt,
)
from app.commerce_action_engine.execution.planning.runtime import planned_read
from app.commerce_contracts.errors import KnowledgeConflict
from app.commerce_knowledge_rag import KnowledgeError, Retriever, evidence
from app.commerce_resolution_engine.runtime import KnowledgeDocument


class RuntimeKnowledge:
    def __init__(
        self,
        reader: Retriever,
        *,
        record_planning: Callable[[dict[str, object]], None] | None = None,
    ):
        self.record_planning = record_planning
        self.reader = reader

    async def retrieve(
        self, agent: Agent, principal: Principal, message: str, *, planned: bool
    ) -> tuple[KnowledgeDocument, ...]:
        try:
            if planned:
                hits = await planned_read(
                    "knowledge",
                    principal,
                    "knowledge.approved",
                    GoalInput(message=message),
                    lambda: self.reader.retrieve(agent, principal, message),
                    lambda _: LocalReceipt(status="checked"),
                    record_planning=self.record_planning,
                )
            else:
                hits = await self.reader.retrieve(agent, principal, message)
        except KnowledgeError as error:
            if error.code == "policy_source_conflict":
                raise KnowledgeConflict() from None
            raise
        return tuple(
            KnowledgeDocument(
                id=f"{hit.source.id}:{hit.source.revision}:{hit.chunk.id}",
                tenant=hit.source.tenant,
                source=hit.source.collection,
                text=hit.chunk.text,
                personas=hit.source.personas,
                permissions=hit.source.permissions,
                provenance={
                    key: value for key, value in evidence(hit).items() if key != "text"
                },
            )
            for hit in hits[: agent.knowledge.max_documents]
            if hit.source.current() and hit.source.approved_by is not None
        )
