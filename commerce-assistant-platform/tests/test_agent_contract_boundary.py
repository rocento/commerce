"""Shared policy/error types preserve identity, validation and authorization behavior."""

import importlib
import subprocess
import sys
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.commerce_contracts import agents, errors


@pytest.mark.parametrize(
    "name",
    [
        "Agent",
        "Principal",
        "Persona",
        "DomainModel",
        "ModelConfig",
        "ToolPolicy",
        "KnowledgePolicy",
        "SafetyPolicy",
    ],
)
def test_action_agent_exports_preserve_neutral_type_identity(name):
    action_agents = importlib.import_module(
        "app.commerce_action_engine.execution.agents"
    )
    assert getattr(action_agents, name) is getattr(agents, name)


@pytest.mark.parametrize("name", ["RuntimeErrorCode", "ToolDenied", "ToolUnavailable"])
def test_legacy_error_imports_reexport_the_same_exceptions(name):
    old = importlib.import_module("app.commerce_action_engine.shared.errors")
    assert getattr(old, name) is getattr(errors, name)


def test_neutral_contracts_do_not_load_either_engine():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import app.commerce_contracts.agents
import app.commerce_contracts.base
import app.commerce_contracts.compound_plan
import app.commerce_contracts.compound_write
import app.commerce_contracts.errors
import sys
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine', 'app.commerce_resolution_engine', 'app.commerce_orchestration_engine', 'httpx', 'psycopg')), name
""",
        ],
        check=True,
    )


def test_principal_still_requires_merchant_identity_and_rejects_extra_authority():
    with pytest.raises(ValidationError, match="Merchant identity required"):
        agents.Principal(tenant=UUID(int=1), persona="merchant")
    with pytest.raises(ValidationError):
        agents.Principal(tenant=UUID(int=1), persona="shopper", admin=True)
    principal = agents.Principal(tenant=UUID(int=1), persona="shopper")
    assert principal.permissions == frozenset()
    with pytest.raises(ValidationError):
        principal.permissions = frozenset({"orders.write"})


def test_default_agent_configuration_and_tenant_isolation_stay_action_owned():
    from app.commerce_action_engine.execution.agents import (
        DEFAULT_SHOPPER_TOOLS,
        default_agents,
    )

    tenant = UUID(int=1)
    catalog = default_agents(tenant, frozenset({"faq"}))
    shopper = catalog.load(tenant, "shopper")
    merchant = catalog.load(tenant, "merchant")
    assert isinstance(shopper, agents.Agent)
    assert shopper.tools.allowed == DEFAULT_SHOPPER_TOOLS
    assert shopper.knowledge.sources == frozenset({"faq"})
    assert shopper.safety.max_tool_result_characters == 16000
    assert merchant.tools.allowed == frozenset()
    assert catalog.load(UUID(int=2), "shopper") is None


def test_denial_retains_partial_completion_and_customer_message():
    from app.commerce_action_engine.shared.errors import ToolDenied

    denied = errors.ToolDenied()
    denied.completed_action = "cart_add"
    with pytest.raises(ToolDenied) as caught:
        raise denied
    assert caught.value is denied
    assert denied.message == (
        "The item was added to your cart, but wishlist removal was denied. "
        "Rocento supports this action, but your current access does not allow it. Contact the store for help."
    )


def test_action_contract_export_preserves_shared_base_identity():
    from app.commerce_action_engine.contracts.action import Contract as ActionContract
    from app.commerce_contracts.base import Contract
    from app.commerce_contracts.compound_plan import CompoundPlan
    from app.commerce_contracts.compound_write import CompoundCommand

    assert ActionContract is Contract
    assert issubclass(CompoundPlan, Contract)
    assert issubclass(CompoundCommand, Contract)
