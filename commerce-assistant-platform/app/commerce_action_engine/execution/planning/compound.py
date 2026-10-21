"""Bind a complete reviewed pair using the existing bounded planning runtime."""

import json
import time
from collections.abc import Callable
from uuid import UUID, uuid5

from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog import (
    CatalogResult,
    Product,
    ProductArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.catalog.bindings import (
    ProductReader,
    exact_candidate,
    verify_identity,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.planning import PlanningError
from app.commerce_action_engine.execution.planning.compound_review import (
    admitted_pair,
    is_reviewed_pair,
    review,
)
from app.commerce_action_engine.execution.planning.runtime import PlanningSession
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable
from app.commerce_contracts.compound_plan import (
    CompoundAction,
    CompoundPlan,
    CompoundScope,
    ProductBinding,
    ProductChoice,
)


def admissible(result: InterpretedRequest) -> bool:
    reviewed = review(result)
    return bool(
        is_reviewed_pair(result)
        and reviewed
        and reviewed.state == "understood"
        and result.compound_reply != "cancelled"
        and all(
            a.id == f"request{i + 1}"
            and len(a.items) == 1
            and a.items[0].productText
            and len(a.items[0].productText) <= 200
            and not a.items[0].unit
            and not a.items[0].reference
            and not a.items[0].selectionStrategy
            for i, a in enumerate(result.requested_actions.requestedActions or [])
        )
    )


async def prepare(
    result: InterpretedRequest,
    principal: Principal,
    reader: ProductReader,
    *,
    conversation: UUID,
    request: UUID,
    revision: UUID,
    input_hash: str,
    record_planning: Callable[[dict[str, object]], None] | None = None,
) -> CompoundPlan:
    if not principal.subject or not admissible(result):
        raise PlanningError("compound_request_not_admitted")
    # Compile the entire procedure before the first read. There is no legacy
    # fallback here if a definition, capability or planner requirement fails.
    session = PlanningSession(
        "compound-review",
        principal,
        frozenset({"catalog.search_products", "catalog.get_product"}),
        tool_limit=4,
        record_planning=record_planning,
    )
    now = int(time.time())
    scope = CompoundScope(
        tenant_id=principal.tenant,
        customer_id=principal.subject,
        conversation_id=conversation,
    )
    requested = result.requested_actions.requestedActions or []
    ids = [uuid5(revision, f"action:{i}") for i in range(2)]
    candidates: list[list[Product]] = [[], []]
    failures: set[int] = set()
    for i, source in enumerate(requested):
        query = source.items[0].productText or ""

        async def search(query: str = query) -> CatalogResult:
            return CatalogResult(
                products=[
                    Product.model_validate(p)
                    for p in await reader.search_cart_product(query)
                ],
                category=None,
            )

        try:
            found = await session.perform(
                "catalog.search_products",
                SearchToolArgs(query=query),
                search,
                lambda r: r,
                node_id=f"lookup{i + 1}",
            )
            candidates[i] = found.products
        except (ToolUnavailable, RuntimeErrorCode, ValidationError, TimeoutError):
            failures.update(range(i, 2))
            break
    actions = []
    for i, source in enumerate(requested):
        item = source.items[0]
        query = item.productText or ""
        candidate = exact_candidate(candidates[i], query)
        binding = None
        reason: str | None = (
            "catalog_unavailable"
            if failures
            else "selection_required"
            if candidates[i]
            else "not_found"
        )
        if candidate and not failures:

            async def facts(
                candidate: Product | None = candidate, query: str = query
            ) -> CatalogResult:
                if candidate is None:
                    raise ToolUnavailable()
                value = Product.model_validate(await reader.product(candidate.id))
                if not verify_identity(value, candidate, query):
                    raise ToolUnavailable()
                return CatalogResult(products=[value], category=None)

            try:
                found = await session.perform(
                    "catalog.get_product",
                    ProductArgs(product_id=str(candidate.id)),
                    facts,
                    lambda r: r,
                    node_id=f"product{i + 1}",
                )
                product = found.products[0]
                if product.product_type != "simple":
                    reason = "selection_required"
                elif source.intent == "ADD_TO_WISHLIST" and (item.quantity or 1) != 1:
                    reason = "quantity_not_supported"
                elif source.intent == "ADD_TO_CART" and product.in_stock is not True:
                    reason = "stock_unverified"
                else:
                    observed = int(time.time())
                    binding = ProductBinding(
                        product_id=product.id,
                        name=product.name,
                        sku=product.sku,
                        observed_at=observed,
                        expires_at=observed + 30,
                    )
                    reason = None
            except (ToolUnavailable, RuntimeErrorCode, ValidationError, TimeoutError):
                failures.add(i)
                reason = "catalog_unavailable"
        destination = "cart" if source.intent == "ADD_TO_CART" else "wishlist"
        choices = (
            tuple(
                ProductChoice(product_id=p.id, name=p.name, sku=p.sku)
                for p in candidates[i][:5]
            )
            if not binding
            else ()
        )
        actions.append(
            CompoundAction.model_validate_json(
                json.dumps(
                    {
                        "id": str(ids[i]),
                        "operation_id": str(uuid5(ids[i], "add:" + destination)),
                        "source_label": source.id,
                        "intent": source.intent,
                        "destination": destination,
                        "query": query,
                        "quantity": item.quantity or 1,
                        "operation": "cart.add"
                        if destination == "cart"
                        else "cart.save_to_wishlist",
                        "customer_after": str(ids[i - 1])
                        if source.after and i
                        else None,
                        "depends_on": str(ids[i - 1]) if i else None,
                        "lookup_node": f"lookup{i + 1}",
                        "product_node": f"product{i + 1}",
                        "state": "ready" if binding else "needs_input",
                        "binding": binding.model_dump(mode="json") if binding else None,
                        "reason": reason,
                        "choices": [c.model_dump(mode="json") for c in choices],
                    }
                )
            )
        )
    # A binding is per action even when both actions happen to name the same SKU.
    return CompoundPlan(
        id=uuid5(revision, "compound-plan"),
        scope=scope,
        request_id=request,
        input_hash=input_hash,
        revision=revision,
        created_at=now,
        actions=(actions[0], actions[1]),
        language_status="RESOLVED"
        if admitted_pair(result)
        else ("AMBIGUOUS" if result.status == "AMBIGUOUS" else "NEEDS_CONTEXT"),
        interpretation_issues=("INTERPRETATION_CONFLICT",)
        if "INTERPRETATION_CONFLICT"
        in (result.requested_actions.requestedActionIssues or [])
        else (),
    )
