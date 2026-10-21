"""Optional DB-backed suitability stage. It never chooses software for the shopper."""

import asyncio
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.domain_evidence.assessment import (
    assess,
    product_in_scope,
)
from app.commerce_action_engine.actions.domain_evidence.contracts import (
    DomainPack,
    EvidenceReader,
    Profile,
)
from app.commerce_action_engine.actions.shopping.context import response_product_limit
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingChoice,
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.selection import select
from app.commerce_action_engine.application.responses import card, catalog_block, finish
from app.commerce_action_engine.application.shopping_presentation import plain
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_resolution_engine.diagnostics import debug_record

from .catalog import ShoppingCatalog
from .contracts import (
    GroundedShopping,
    PreparedShopping,
    ReferenceSelection,
    RetrievedShopping,
    ShoppingAnswer,
)
from .presentation import ShoppingResponder


@dataclass(frozen=True)
class DomainSelection:
    pack: DomainPack
    profile: Profile


def activities(plan: ShoppingIntent) -> set[str]:
    values = (
        {
            r.value
            for r in plan.shopping_context.relations
            if r.relation == "intended_use" and not r.negated
        }
        if plan.shopping_context
        else set()
    )
    if plan.intended_use:
        values.add(plan.intended_use)
    return {"_".join(v.casefold().replace("_", " ").split()) for v in values}


async def prepare_domain(
    prepared: PreparedShopping,
    schema: CatalogSchema,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
    reader: EvidenceReader,
) -> DomainSelection | ShoppingAnswer | None:
    plan = prepared.plan
    uses = activities(plan)
    if schema.industry != "electronics" or not uses:
        return None
    if not prepared.resuming:
        plan.domain_profile = None

    def answer(
        text: str, question: ShoppingClarification | None = None
    ) -> ShoppingAnswer:
        return responder.build(
            text,
            plan=plan,
            schema=schema,
            calls=catalog.calls,
            clarification=text,
            pending_shopping=question,
        )

    try:
        async with asyncio.timeout(2):
            pack = await reader.active_pack(catalog.principal.tenant)
    except Exception:  # noqa: BLE001 -- bounded evidence boundary, no unverified fallback
        return answer(
            "I cannot access the reviewed requirement evidence right now, so suitability is unknown. Please try again."
        )
    if pack is None:
        return answer(
            "There is no active reviewed requirement profile for this store, so I cannot verify suitability for your intended use yet."
        )
    terms = {plan.query.strip().casefold(), (plan.category or "").strip().casefold()}
    if plan.category_id:
        for category in schema.categories:
            if str(category.id) == plan.category_id:
                terms.update(
                    [
                        category.name.casefold(),
                        *(a.casefold() for a in category.aliases),
                    ]
                )
    candidates = [
        p
        for p in pack.profiles
        if uses <= set(p.activity_values) and terms.intersection(p.product_terms)
    ]
    if not candidates:
        return answer(
            "I do not have one reviewed profile covering this product and all your intended uses. Which software, operating system and workload should I check? Please include them in your complete request; suitability remains unknown."
        )
    now = datetime.now(UTC)
    sources = {s.id: s for s in pack.sources}
    candidates = [
        p
        for p in candidates
        if p.current(now)
        and all(sources[s].current(now) for r in p.requirements for s in r.source_ids)
    ]
    if not candidates:
        return answer(
            "The requirement sources need review, so suitability is unknown. I cannot use expired or conflicting requirements to recommend a product."
        )
    chosen = next(
        (p for p in candidates if plan.domain_profile == f"{pack.fingerprint}:{p.id}"),
        None,
    )
    if chosen is not None:
        return DomainSelection(pack, chosen)
    plan.domain_profile = None
    budget = (
        f" I’ll keep your maximum budget of {plan.max_price} {plan.currency or ''}."
        if plan.max_price is not None
        else ""
    )
    text = f"Which software and workload match your request?{budget} Choose a reviewed option below to check its hardware requirements. If none fits, send your software, operating system and workload in a complete request."
    question = ShoppingClarification(
        question=text,
        field="domain_profile",
        choices=[
            ShoppingChoice(label=p.label, value=f"{pack.fingerprint}:{p.id}")
            for p in candidates[:8]
        ],
        frame=plan.model_copy(deep=True),
        descriptor_revision=schema.version,
        optional=False,
        currency=plan.currency,
    )
    return answer(text, question)


async def present_domain(
    prepared: PreparedShopping,
    grounded: GroundedShopping,
    references: ReferenceSelection,
    retrieved: RetrievedShopping,
    *,
    selection: DomainSelection,
    reader: EvidenceReader,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
) -> ShoppingAnswer:
    plan, schema = references.plan, grounded.schema
    pack, profile = selection.pack, selection.profile
    # Domain recommendations never expand the user's hard bounds through the
    # ordinary alternative-product path. Verify all hard constraints again.
    exact, _ = select(retrieved.result.products, plan, references.product)
    candidates = [p for p, _ in exact if product_in_scope(p, profile)]
    if not candidates:
        text = "I found no catalog candidates meeting your product and price constraints among the results checked. I have kept your budget unchanged; I cannot verify a suitable recommendation from these results."
        return responder.build(
            text, plan=plan, schema=schema, calls=catalog.calls, verified_read=True
        )
    try:
        async with asyncio.timeout(2):
            facts = await reader.product_facts(
                catalog.principal.tenant, tuple(p.id for p in candidates)
            )
            # Re-read the binding before returning evidence: rollback/revocation
            # during catalog retrieval cannot produce a verified stale result.
            active = await reader.active_pack(catalog.principal.tenant)
        if active is None or active.fingerprint != pack.fingerprint:
            raise ValueError("Domain release changed")
    except Exception:  # noqa: BLE001 -- no catalog-tag fallback on failed evidence read
        text = "I could not verify the current product evidence. Suitability is unknown; please retry so I can check the current release and exact product facts."
        return responder.build(text, plan=plan, schema=schema, calls=catalog.calls)
    now = datetime.now(UTC)
    evaluated = [
        (p, assess(pack, profile, p, schema, facts, catalog.principal.tenant, now))
        for p in candidates
    ]
    priority = {"verified": 0, "unknown": 1, "unmet": 2}
    evaluated.sort(key=lambda pair: priority[pair[1].status])
    evaluated = evaluated[: response_product_limit(plan, default=3)]
    debug_record(
        "domain_evidence",
        {
            "tenant_id": str(catalog.principal.tenant),
            "checked_at": now.isoformat(),
            "catalog_revision": schema.version,
            "assessments": [asdict(assessment) for _, assessment in evaluated],
        },
    )
    sources = sorted({s for r in profile.requirements for s in r.source_ids})
    text = f"Profile checked: {profile.label}. {profile.limitations}\n"
    cards = []
    for product, assessment in evaluated:
        issues = [
            r.label
            for r in profile.requirements
            if any(
                c.requirement_id == r.id and c.status != "verified"
                for c in assessment.checks
            )
        ]
        state = {
            "verified": "Verified against this hardware profile",
            "unknown": "Unknown: evidence is incomplete or conflicting",
            "unmet": "Does not meet this hardware profile",
        }[assessment.status]
        reason = state + (" — check " + ", ".join(issues) if issues else "")
        reasons = [
            reason,
            f"Checked for: {profile.label}",
        ]
        cards.append(
            card(product, reasons, [] if assessment.status == "verified" else [reason])
        )
        text += (
            f"\n{plain(product.name)} — {product.price} {product.currency}: {reason}."
        )
    source_text = "Requirement sources: " + "; ".join(
        f"{s.title}: {s.url}" for s in pack.sources if s.id in sources
    )
    text += "\n\n" + source_text
    if any(a.status == "unknown" for _, a in evaluated):
        text += "\nCan you provide the manufacturer's specifications for the exact model so I can check the missing evidence?"
    blocks = finish(
        [
            catalog_block(
                "product_list",
                cards,
                "Hardware evidence check — status shown for each product",
            ),
            AssistantBlock(kind="text", text=f"{profile.limitations}\n{source_text}"),
        ],
        browse_catalog=False,
    )
    return responder.build(
        text, blocks, plan=plan, schema=schema, calls=catalog.calls, verified_read=True
    )
