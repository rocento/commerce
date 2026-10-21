"""Public shopping API and ordered coordination of typed application stages."""

import re
from collections.abc import Callable, Mapping
from uuid import uuid4

from app.commerce_action_engine.actions.domain_evidence.contracts import EvidenceReader
from app.commerce_action_engine.actions.shopping.constraints import (
    matches_attribute,
    mismatches,
    normalized,
    preserve_schema_constraints,
    schema_value,
    structured_filters,
    values,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.meaning import assess_action
from app.commerce_action_engine.actions.shopping.selection import select
from app.commerce_action_engine.application.shopping_flow.catalog import ShoppingCatalog
from app.commerce_action_engine.application.shopping_flow.contracts import (
    ShoppingAnswer,
)
from app.commerce_action_engine.application.shopping_flow.domain import (
    DomainSelection,
    prepare_domain,
    present_domain,
)
from app.commerce_action_engine.application.shopping_flow.grounding import (
    ground_shopping,
)
from app.commerce_action_engine.application.shopping_flow.preparation import (
    prepare_shopping,
)
from app.commerce_action_engine.application.shopping_flow.presentation import (
    ShoppingResponder,
    present_shopping,
)
from app.commerce_action_engine.application.shopping_flow.references import (
    resolve_references,
)
from app.commerce_action_engine.application.shopping_flow.retrieval import (
    retrieve_candidates,
)
from app.commerce_action_engine.application.shopping_presentation import plain, render
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.agents import Agent, Principal
from app.commerce_action_engine.execution.language.shopping import (
    INSTRUCTIONS as GROUNDED_EXTRACTION,
)
from app.commerce_action_engine.execution.language.shopping import english_query
from app.commerce_action_engine.execution.planning import start_planning
from app.commerce_action_engine.platform import planning_summary, policy_summary
from app.commerce_action_engine.shared.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import Message, ModelProvider
from app.commerce_resolution_engine.prompts import EXTRACTION
from app.commerce_resolution_engine.runtime import RuntimeTool

__all__ = [
    "EXTRACTION",
    "GROUNDED_EXTRACTION",
    "ShoppingAnswer",
    "ShoppingIntent",
    "matches_attribute",
    "mismatches",
    "normalized",
    "plain",
    "preserve_schema_constraints",
    "render",
    "schema_value",
    "select",
    "shopping_answer",
    "structured_filters",
    "values",
]


async def shopping_answer(
    message: str,
    provider: ModelProvider,
    agent: Agent,
    principal: Principal,
    tools: Mapping[str, RuntimeTool],
    on_tool: Callable[[str], None] | None = None,
    history: tuple[Message, ...] = (),
    grounded_intent: bool = False,
    commerce_meaning: bool = False,
    commerce_planning: bool = False,
    planning_prices: tuple[int, int] | None = None,
    *,
    interpretation: InterpretedRequest | InterpretationFailure | None = None,
    shopping_resume: ShoppingIntent | None = None,
    shopping_resume_revision: str | None = None,
    shopping_resume_question: ShoppingClarification | None = None,
    domain_evidence: EvidenceReader | None = None,
) -> ShoppingAnswer | None:
    message = re.sub(
        r"\b(?:do not|don't) personali[sz]e(?: this request)?[.,;]?",
        "",
        message,
        flags=re.IGNORECASE,
    ).strip()
    commerce_meaning = (
        commerce_meaning and english_query(message) and shopping_resume is None
    )
    if commerce_meaning:
        policy = assess_action(principal, "catalog_read", request_id=str(uuid4()))
        policy_summary(policy)
        if policy.outcome != "allow":
            raise RuntimeErrorCode("policy_denied")
    planning = start_planning(
        commerce_planning and english_query(message) and shopping_resume is None,
        "discovery",
        principal,
        tools,
        tool_limit=agent.safety.max_tool_calls,
        timeout_ms=int(agent.safety.timeout_seconds * 1000),
        prices=planning_prices,
        record_planning=planning_summary,
    )
    catalog = ShoppingCatalog(tools, agent, principal, planning, on_tool)
    schema, default_currency = await catalog.discover()
    prepared = await prepare_shopping(
        message=message,
        schema=schema,
        catalog=catalog,
        provider=provider,
        agent=agent,
        history=history,
        grounded_intent=grounded_intent,
        commerce_meaning=commerce_meaning,
        interpretation=interpretation,
        shopping_resume=shopping_resume,
        shopping_resume_revision=shopping_resume_revision,
        shopping_resume_question=shopping_resume_question,
    )
    if isinstance(prepared, ShoppingAnswer):
        return prepared
    responder = ShoppingResponder(
        prepared.response,
        prepared.gate,
        prepared.interpreted,
        agent.safety.max_output_characters,
    )
    domain_selection = None
    if domain_evidence is not None:
        domain_selection = await prepare_domain(
            prepared, schema, catalog, responder, domain_evidence
        )
        if isinstance(domain_selection, ShoppingAnswer):
            return domain_selection
    grounded = await ground_shopping(
        prepared,
        schema=schema,
        default_currency=default_currency,
        catalog=catalog,
        responder=responder,
        commerce_meaning=commerce_meaning,
        history=history,
    )
    if grounded is None or isinstance(grounded, ShoppingAnswer):
        return grounded
    references = await resolve_references(
        prepared, grounded, catalog=catalog, responder=responder
    )
    if isinstance(references, ShoppingAnswer):
        return references
    retrieved = await retrieve_candidates(
        prepared, grounded, references, catalog=catalog, responder=responder
    )
    if isinstance(retrieved, ShoppingAnswer):
        return retrieved
    if isinstance(domain_selection, DomainSelection) and domain_evidence is not None:
        return await present_domain(
            prepared,
            grounded,
            references,
            retrieved,
            selection=domain_selection,
            reader=domain_evidence,
            catalog=catalog,
            responder=responder,
        )
    return present_shopping(
        prepared, grounded, references, retrieved, catalog=catalog, responder=responder
    )
