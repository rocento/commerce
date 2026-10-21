"""Commerce action contracts and descriptive registry boundaries."""

import importlib

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog import SHOPPER_TOOLS
from app.commerce_action_engine.actions.registry import (
    ActionRegistry,
    ActionRegistryError,
    default_registry,
)
from app.commerce_action_engine.actions.shopping.cart import WRITE_INTENTS
from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Confirmation,
    SkillInput,
    SkillResult,
    TypedFailure,
)
from app.commerce_action_engine.contracts.commerce_action import (
    ActionClassification,
    ActionContext,
    ActionError,
    ActionRequest,
    ActionResult,
    CommerceActionDefinition,
)


def test_action_vocabulary_reuses_existing_wire_contracts():
    assert ActionContext is ActorContext
    assert ActionRequest is SkillInput
    assert ActionResult is SkillResult
    assert ActionError is TypedFailure


def test_registry_describes_current_action_owners_without_executing():
    registry = default_registry()
    assert not hasattr(registry, "execute")
    assert {
        item.name.removeprefix("catalog.") for item in registry.for_domain("catalog")
    } == SHOPPER_TOOLS
    assert {
        intent
        for item in registry.for_domain("cart")
        if item.classification is ActionClassification.WRITE
        for intent in item.intents
    } == WRITE_INTENTS

    for item in registry.all():
        module_name, qualified_name = item.implementation.split(":", 1)
        owner = importlib.import_module(module_name)
        for part in qualified_name.split("."):
            owner = getattr(owner, part)
        assert callable(owner)


def test_write_metadata_matches_existing_no_replay_boundary():
    writes = [
        item
        for item in default_registry().all()
        if item.classification is ActionClassification.WRITE
    ]
    assert {item.name for item in writes} == {
        "cart.add",
        "cart.clear",
        "cart.remove",
        "cart.set_quantity",
        "cart.save_to_wishlist",
        "cart.move_to_wishlist",
        "order.reorder",
        "support.create_ticket",
    }
    assert all(item.confirmation is Confirmation.INTENT for item in writes)
    assert all(item.replay == "never" for item in writes)


def test_registry_is_exact_and_rejects_invalid_configuration():
    item = default_registry().get("cart.add")
    with pytest.raises(ActionRegistryError, match="duplicate_action"):
        ActionRegistry((item, item))
    with pytest.raises(ActionRegistryError, match="unknown_action"):
        default_registry().get("cart.missing")
    with pytest.raises(ValidationError, match="Writes require confirmation"):
        CommerceActionDefinition(
            name="cart.unsafe",
            domain="cart",
            classification=ActionClassification.WRITE,
            input_contract="commerce://cart-command-v1",
            output_contract="commerce://cart-v1",
            implementation="app.commerce_action_engine.actions.shopping.cart:execute",
        )
    with pytest.raises(ValidationError, match="Read metadata cannot imply"):
        CommerceActionDefinition(
            name="catalog.unsafe",
            domain="catalog",
            classification=ActionClassification.READ,
            input_contract="catalog://get-product-v1",
            output_contract="catalog://result-v1",
            implementation="app.commerce_action_engine.application.catalog:registry",
            confirmation=Confirmation.INTENT,
        )
