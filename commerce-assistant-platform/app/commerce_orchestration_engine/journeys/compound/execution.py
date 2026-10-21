"""Fresh compound orchestration: revalidate, claim, dispatch once, save receipt."""

import asyncio
import logging

from app.commerce_action_engine.actions.catalog import (
    CatalogResult,
    Product,
    ProductArgs,
)
from app.commerce_action_engine.actions.catalog.bindings import (
    ProductReader,
    exact_candidate,
)
from app.commerce_action_engine.actions.shopping.compound import CompoundWriter
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
)
from app.commerce_contracts.compound_write import CompoundDispatch
from app.commerce_contracts.errors import ToolUnavailable

from .ports import ExecutionSession, ExecutionStore

logger = logging.getLogger(__name__)


async def execute(
    plan: CompoundPlan,
    session: ExecutionSession,
    reader: ProductReader,
    writer: CompoundWriter,
    store: ExecutionStore,
) -> CompoundPlan:
    """Call only immediately after saving a newly admitted execution plan.

    Saved-request recovery never invokes this function. Atomic claims order a
    concurrent cancellation against the current dispatch; no successor is sent
    until the preceding authoritative receipt has been durably recorded.
    """
    command = session.command
    if not plan.execution_enabled or command != type(command).from_plan(plan):
        raise ValueError("compound_execution_mismatch")

    async def transition(
        kind: str, index: int = 0, receipt: CompoundReceipt | None = None
    ) -> CompoundPlan:
        return await store.transition_compound(
            plan.scope,
            plan.request_id,
            plan.actions[index].id,
            transition=kind,
            receipt=receipt,
        )

    async def stopped() -> CompoundPlan:
        local = outcomes.stop(plan)
        try:
            async with asyncio.timeout(1):
                return await transition("stop")
        except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
            return local

    async def facts(index: int, node: str) -> None:
        action = plan.actions[index]
        binding = action.binding
        if binding is None:
            raise ToolUnavailable()

        async def read() -> CatalogResult:
            product = Product.model_validate(await reader.product(binding.product_id))
            if (
                product.id != binding.product_id
                or product.name != binding.name
                or product.sku != binding.sku
                or exact_candidate([product], action.query) is None
                or product.product_type != "simple"
                or action.destination == "cart"
                and product.in_stock is not True
            ):
                raise ToolUnavailable()
            return CatalogResult(products=[product], category=None)

        await session.perform(
            "catalog.get_product",
            ProductArgs(product_id=str(binding.product_id)),
            read,
            lambda r: r,
            node_id=node,
        )

    try:
        await facts(0, "facts1")
        await facts(1, "facts2")
    except asyncio.CancelledError:
        await stopped()
        raise
    except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
        return await stopped()

    for index, action in enumerate(plan.actions):
        if plan.actions[index].state != "ready":
            return plan
        try:
            if index:
                await facts(index, "refresh2")
            session.start(
                "commerce.compound_apply",
                CompoundDispatch(command=command, action_id=action.id),
                node_id=f"write{index + 1}",
            )
        except asyncio.CancelledError:
            await stopped()
            raise
        except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
            return await stopped()
        # A rejected or lost claim must never dispatch, or mark another worker's
        # running action as ours. Recovery is read-only for this request ID.
        try:
            plan = await transition("dispatch", index)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
            session.fail()
            try:
                return await store.get_compound_plan(
                    plan.scope, plan.request_id, plan.input_hash
                ) or outcomes.stop(plan)
            except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
                return outcomes.stop(plan)
        if (
            plan.actions[index].state != "running"
            or not plan.execution_enabled
            or type(command).from_plan(plan) != command
        ):
            session.fail()
            return plan
        proof = None
        claimed_plan = plan
        try:
            async with asyncio.timeout(session.operation_timeout()):
                proof = command.verify(
                    await writer.apply(command, action.id), action.id
                )
            plan = await transition("receipt", index, proof)
            session.finish(proof)
        except BaseException as error:
            session.fail()
            # On cancellation/timeout the running state is also recoverable if
            # the database itself is unavailable. Cleanup never resends a write.
            local = outcomes.uncertain(claimed_plan, action.id)
            if proof is not None:
                local = outcomes.stop(outcomes.record(local, proof))
            try:
                async with asyncio.timeout(1):
                    await transition("uncertain", index)
            except Exception:  # noqa: BLE001 -- failed infrastructure must stop dispatch
                logger.warning("compound_outcome_cleanup_unavailable")
            if isinstance(error, asyncio.CancelledError):
                raise
            if not isinstance(error, Exception):
                raise
            return local
        if proof.outcome != "succeeded":
            session.fail()
            return plan
    return plan
