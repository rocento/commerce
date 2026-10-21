"""Guard the difference between recognized intents and exposed chat workflows."""

import importlib.util
import json
from dataclasses import replace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "ai_capabilities", ROOT / "commerce-ops/scripts/generation/generate_ai_capabilities.py"
)
assert SPEC is not None and SPEC.loader is not None
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


def test_generated_artifacts_match_source():
    manifest = inventory.build_manifest()
    assert {
        "commerce-assistant-platform/app/commerce_action_engine/adapters/catalog.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/memory.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/planned_commerce.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/cart.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/orders.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/wishlist.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/support.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/delivery.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/shopper_catalog.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/http_response.py",
        "commerce-assistant-platform/app/commerce_action_engine/execution/planning/runtime.py",
        "commerce-assistant-platform/app/commerce_action_engine/adapters/runtime_knowledge.py",
        "commerce-assistant-platform/app/commerce_action_engine/application/catalog.py",
    } <= manifest["source_sha256"].keys()
    assert (
        json.loads((ROOT / "commerce-assistant-platform/docs/capabilities.json").read_text()) == manifest
    )
    assert (
        ROOT / "commerce-docs/ai-service/intent-action-coverage.md"
    ).read_text() == inventory.render_inventory(manifest)


def test_write_inventory_does_not_promote_checkout_reorder_or_address_guidance():
    manifest = inventory.build_manifest()
    intents = {row["intent"]: row for row in manifest["baseline"]}
    for intent in (
        "CREATE_ORDER",
        "START_CHECKOUT",
        "CONTINUE_CHECKOUT",
        "ACCOUNT_ADDRESS_ADD",
    ):
        assert intents[intent]["outcome"] == "guided"
    assert intents["REORDER"]["outcome"] == "read_or_guide"
    assert intents["ADD_TO_CART"]["outcome"] == "conditional_write"
    assert intents["REMOVE_FROM_WISHLIST"]["outcome"] == "conditional_write"
    assert manifest["not_exposed_by_chat"] == [
        "app.commerce_action_engine.adapters.reorder:execute"
    ]
    assert {row["route"] for row in manifest["entity_dependent"]} == {
        "bestsellers",
        "discounts",
    }
    assert manifest["context_workflows"]["compound_pair"]["ai_flags"] == [
        "commerce_planning",
        "compound_execution",
    ]


def test_new_unreviewed_route_is_rejected(monkeypatch):
    original = inventory.interpret_resolution

    def unreviewed(source, context):
        decision = original(source, context)
        return (
            replace(decision, route="unreviewed_executor")
            if decision.result.legacy_intent == "PRODUCT_SEARCH"
            else decision
        )

    monkeypatch.setattr(inventory, "interpret_resolution", unreviewed)
    with pytest.raises(ValueError, match="Undocumented route"):
        inventory.build_manifest()


def test_missing_handler_binding_is_rejected():
    with pytest.raises(ValueError, match="Missing implementation binding"):
        inventory.binding_source(inventory.APP + "handlers.cart:nonexistent_handler")
