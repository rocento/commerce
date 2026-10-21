"""Compose basket proposal planning with application-owned telemetry.

This entry point does not re-enable retired shopping modes in the chat route.
"""

from uuid import UUID

from app.commerce_action_engine.actions.shopping import basket_workflow
from app.commerce_action_engine.actions.shopping.basket_ports import BasketGateway
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.platform import (
    execution_summary,
    meaning_summary,
    planning_summary,
    policy_summary,
)
from app.commerce_resolution_engine.contracts import ModelProvider
from app.commerce_resolution_engine.runtime import RuntimeTool


async def plan_basket(
    message: str,
    mode: str,
    task: UUID,
    provider: ModelProvider,
    catalog: dict[str, RuntimeTool],
    principal: Principal,
    baskets: BasketGateway,
    commerce_meaning: bool = False,
    commerce_planning: bool = False,
    planning_prices: tuple[int, int] | None = None,
) -> tuple[str, list[AssistantBlock]]:
    return await basket_workflow.plan_basket(
        message,
        mode,
        task,
        provider,
        catalog,
        principal,
        baskets,
        commerce_meaning,
        commerce_planning,
        planning_prices,
        record_meaning=meaning_summary,
        record_planning=planning_summary,
        record_policy=policy_summary,
        record_execution=execution_summary,
    )
