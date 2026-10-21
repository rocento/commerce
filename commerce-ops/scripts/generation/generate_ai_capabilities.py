"""Generate reviewed chat exposure from actual route policy; never grant authority."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import ast
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SERVICE = ROOT / "commerce-assistant-platform"
sys.path.insert(0, str(SERVICE))

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.language.gate import (
    Resolution,
)
from app.commerce_action_engine.execution.language.handoffs import (
    HANDOFFS,
)

APP = "app.commerce_action_engine.application."
# These are reviewed exposure descriptions, not executable registrations.
# Capabilities are the adapter's named delegated inputs, not JWT scope grants.
WORKFLOWS = {
    "search": (
        "read",
        APP + "shopping:shopping_answer",
        ["catalog_capability"],
        "Catalog discovery with validated constraints and selection.",
    ),
    "product_fact": (
        "read",
        APP + "handlers.product_facts:product_fact_events",
        ["catalog_capability"],
        "Exact product identity and current authoritative facts; missing facts stay unknown.",
    ),
    "comparison": (
        "read",
        APP + "handlers.comparison:comparison_events",
        ["catalog_capability"],
        "Compare verified products; ambiguous identities require selection.",
    ),
    "comparison_clear": (
        "browser_action",
        APP + "handlers.comparison:comparison_events",
        [],
        "Clear browser comparison state; no commerce mutation.",
    ),
    "cart": (
        "read",
        APP + "handlers.cart_read:cart_read_events",
        ["cart_capability"],
        "Read the authenticated cart.",
    ),
    "cart_action": (
        "conditional_write",
        APP + "handlers.cart:cart_events",
        [
            "cart_capability",
            "catalog_capability",
            "cart_write_capability",
            "wishlist_write_capability",
        ],
        "Supported cart/wishlist commands; checkout intents only guide checkout.",
    ),
    "wishlist": (
        "read",
        APP + "handlers.customer:wishlist_events",
        ["wishlist_capability", "catalog_capability"],
        "Read owned saved products.",
    ),
    "wishlist_remove": (
        "conditional_write",
        APP + "handlers.customer:wishlist_events",
        ["wishlist_capability", "wishlist_write_capability", "catalog_capability"],
        "Remove an exact owned item or explicitly all saved items (up to 100); ambiguous requests need selection.",
    ),
    "wishlist_to_cart": (
        "conditional_write",
        APP + "handlers.wishlist_transfer:wishlist_transfer_events",
        [
            "wishlist_capability",
            "catalog_capability",
            "wishlist_cart_transfer_capability",
        ],
        "Scoped transfer with authoritative outcomes; source and destination are preserved.",
    ),
    "order": (
        "read_or_guide",
        APP + "handlers.orders:order_events",
        ["capability"],
        "Read owned orders; issue intents may provide guidance.",
    ),
    "reorder": (
        "read_or_guide",
        APP + "handlers.reorder:reorder_events",
        ["capability"],
        "Read owned order and hand off for review/checkout; no order write from chat.",
    ),
    "locations": (
        "read_or_guide",
        APP + "handlers.customer:location_events",
        ["locations_capability"],
        "Saved-address reads or form/control guidance; no automatic address mutation.",
    ),
    "support": (
        "read_or_guide",
        APP + "handlers.support:support_events",
        ["support_capability"],
        "Read owned tickets; changes remain guided.",
    ),
    "support_detail": (
        "read",
        APP + "handlers.support:support_detail_events",
        ["support_capability"],
        "Read owned ticket history.",
    ),
    "shipment": (
        "read",
        APP + "handlers.orders:shipment_events",
        ["capability"],
        "Read owned shipment status.",
    ),
    "delivery": (
        "read",
        APP + "handlers.delivery:delivery_events",
        ["catalog_capability"],
        "Read scoped delivery availability.",
    ),
    "bestsellers": (
        "read",
        APP + "handlers.bestsellers:bestseller_events",
        ["catalog_capability"],
        "Read authoritative completed-order sales ranking for an allowed period.",
    ),
    "discounts": (
        "read",
        APP + "handlers.discounts:discount_events",
        ["catalog_capability"],
        "Read current discount recommendations.",
    ),
    "handoff": (
        "handoff",
        APP + "handle_turn:HandleTurn.run",
        [],
        "Storefront handoff; no automatic execution.",
    ),
    "context": (
        "clarification",
        APP + "handle_turn:HandleTurn.run",
        [],
        "Request a complete instruction or explicit context control.",
    ),
    "guided_action": (
        "guided",
        APP + "handle_turn:HandleTurn.run",
        [],
        "Guide review in the customer workflow; no direct mutation.",
    ),
}
CHECKOUT = {"CREATE_ORDER", "START_CHECKOUT", "CONTINUE_CHECKOUT"}
TAXONOMY = SERVICE / "app/commerce_language_engine/src/rocento-capabilities.ts"


def binding_source(binding):
    module, symbol = binding.split(":")
    path = SERVICE / (module.replace(".", "/") + ".py")
    tree = ast.parse(path.read_text())
    nodes = tree.body
    for part in symbol.split("."):
        found = next(
            (
                node
                for node in nodes
                if isinstance(
                    node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
                )
                and node.name == part
            ),
            None,
        )
        if found is None:
            raise ValueError(f"Missing implementation binding: {binding}")
        nodes = found.body
    return path


def build_manifest():
    match = re.search(r"new Set\(`(.*?)`", TAXONOMY.read_text(), re.DOTALL)
    if match is None:
        raise ValueError("Cannot read active intent allowlist")
    codes = match.group(1).split()
    if len(codes) != len(set(codes)):
        raise ValueError("Duplicate active intent")
    workflows = {}
    source_files = {
        TAXONOMY,
        SERVICE / "app/commerce_language_engine/src/contextual-language.ts",
        SERVICE / "app/commerce_action_engine/execution/language/gate.py",
        SERVICE / "app/commerce_action_engine/execution/language/routing.py",
        SERVICE / "app/commerce_action_engine/application/interpretation.py",
        SERVICE / "app/commerce_action_engine/application/handler_dispatch.py",
        SERVICE / "app/commerce_action_engine/application/bootstrap.py",
        SERVICE / "app/commerce_action_engine/application/turn_dependencies.py",
        SERVICE / "app/commerce_action_engine/application/persistence.py",
        SERVICE / "app/commerce_action_engine/application/persistence_binding.py",
        SERVICE / "app/commerce_action_engine/application/shopping_continuation.py",
        SERVICE / "app/commerce_action_engine/application/shopping_presentation.py",
        SERVICE / "app/commerce_action_engine/application/compound_coordinator.py",
        SERVICE / "app/commerce_action_engine/application/handlers/compound.py",
        SERVICE / "app/commerce_action_engine/actions/customer/wishlist_transfer.py",
        SERVICE / "app/commerce_action_engine/actions/customer/cart_to_wishlist.py",
        SERVICE / "app/commerce_action_engine/actions/customer/wishlist_removal.py",
        SERVICE / "app/commerce_action_engine/actions/shopping/cart_admission.py",
        SERVICE / "app/commerce_action_engine/actions/customer/transfers.py",
        SERVICE / "app/commerce_action_engine/execution/language/handoffs.py",
        SERVICE / "app/commerce_action_engine/adapters/commerce.py",
        SERVICE / "app/commerce_action_engine/adapters/cart.py",
        SERVICE / "app/commerce_action_engine/adapters/orders.py",
        SERVICE / "app/commerce_action_engine/adapters/wishlist.py",
        SERVICE / "app/commerce_action_engine/adapters/support.py",
        SERVICE / "app/commerce_action_engine/adapters/delivery.py",
        SERVICE / "app/commerce_action_engine/adapters/shopper_catalog.py",
        SERVICE / "app/commerce_action_engine/adapters/http_response.py",
        SERVICE / "app/commerce_action_engine/adapters/catalog.py",
        SERVICE / "app/commerce_action_engine/adapters/memory.py",
        SERVICE / "app/commerce_action_engine/application/catalog.py",
        SERVICE / "app/commerce_action_engine/execution/planning/runtime.py",
        SERVICE / "app/commerce_action_engine/adapters/planned_commerce.py",
        SERVICE / "app/commerce_action_engine/adapters/runtime_knowledge.py",
        SERVICE / "app/commerce_action_engine/application/baskets.py",

    }
    for name, (outcome, binding, capabilities, behavior) in WORKFLOWS.items():
        source_files.add(binding_source(binding))
        workflows[name] = {
            "outcome": outcome,
            "implementation": binding,
            "capability_inputs_by_branch": capabilities,
            "behavior": behavior,
        }

    def entry(intent, entities=None):
        resolution = Resolution.model_validate(
            {
                "status": "RESOLVED",
                "intent": intent,
                "confidence": 0.99,
                "message": "Understood.",
                "entities": entities or {},
            }
        )
        identity = "00000000-0000-0000-0000-000000000001"
        context = TurnContext(actor=ActorContext(tenant_id=identity, store_id=identity, session_id=identity, request_id=identity, channel="evaluation"))
        selected = interpret_resolution(resolution, context).route
        if selected not in workflows:
            raise ValueError(f"Undocumented route: {intent} -> {selected}")
        outcome = "guided" if intent in CHECKOUT else workflows[selected]["outcome"]
        behavior = (
            "Review cart and continue to checkout; no order is placed."
            if intent in CHECKOUT
            else workflows[selected]["behavior"]
        )
        if selected == "handoff":
            behavior = f"Storefront handoff to `{HANDOFFS[intent].path}`; no automatic execution."
        if intent == "ACCOUNT_ADDRESS_ADD":
            outcome, behavior = (
                "guided",
                "Open address-entry form; no automatic address creation.",
            )
        return {
            "intent": intent,
            "entities": entities or {},
            "route": selected,
            "outcome": outcome,
            "behavior": behavior,
        }

    source_files.update((SERVICE / "app/commerce_action_engine/actions").rglob("*.py"))
    source_files.update(
        (SERVICE / "app/commerce_action_engine/application/shopping_flow").rglob("*.py")
    )
    source_files.update(
        (SERVICE / "app/commerce_orchestration_engine/journeys/compound").glob("*.py")
    )
    source_files.update(
        (SERVICE / "app/commerce_action_engine/execution/planning").glob("compound*.py")
    )
    source_files.add(binding_source(APP + "handlers.support:support_create_events"))
    baseline = [entry(code) for code in sorted(codes)]
    conditional = [
        entry(intent, {"salesPeriod": period})
        for intent in ("PRODUCT_RECOMMEND", "PRODUCT_BESTSELLERS")
        for period in ("today", "last_week", "last_month", "last_year")
    ]
    conditional.append(entry("PRODUCT_RECOMMEND", {"discountRanking": True}))
    supplemental = [
        entry(code)
        for code in ("DELIVERY_STATUS", "SHIPMENT_TRACKING", "ORDER_SHIPMENT_STATUS")
        if code not in codes
    ]
    return {
        "schema_version": 1,
        "scope": "English chat source exposure; not deployed enablement or successful execution",
        "conditions": [
            "Gateway authentication and scope checks always apply.",
            "Capability inputs are branch-dependent, not an all-of authorization list.",
            "Status, confidence, missing slots and complete-request checks precede dispatch.",
            "Registry-only implementations are not proof of live chat exposure.",
        ],
        "source_sha256": {
            str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(source_files)
        },
        "baseline_count": len(baseline),
        "route_counts": dict(sorted(Counter(row["route"] for row in baseline).items())),
        "workflows": workflows,
        "baseline": baseline,
        "entity_dependent": conditional,
        "supplemental_routes": supplemental,
        "context_workflows": {
            "compound_pair": {
                "outcome": "conditional_write",
                "composition": ["ADD_TO_CART", "ADD_TO_WISHLIST"],
                "ai_flags": ["commerce_planning", "compound_execution"],
                "gateway_flag": "ASSISTANT_COMPOUND_WRITES_ENABLED",
                "capability_inputs": [
                    "catalog_capability",
                    "compound_read_capability",
                    "compound_write_capability",
                ],
                "conditions": "Fresh full interpretation, revision persistence, product facts and serial receipts; recovery never dispatches successors.",
            },
            "support_ticket": {
                "outcome": "conditional_write",
                "input": "API-validated ticket form context",
                "capability_inputs": ["capability"],
                "implementation": APP + "handlers.support:support_create_events",
            },
        },
        "not_exposed_by_chat": ["app.commerce_action_engine.adapters.reorder:execute"],
    }


def render_inventory(manifest):
    counts = manifest["route_counts"]
    lines = [
        "# Current intent-to-workflow coverage",
        "",
        "Generated by `commerce-ops/scripts/generation/generate_ai_capabilities.py`; do not edit the tables manually.",
        "",
        "The [capability manifest](../../commerce-assistant-platform/docs/capabilities.json) records implementation bindings, branch-dependent capability inputs, conditional routes and feature gates. It describes English source behavior, not deployment enablement or successful execution.",
        "",
        "Baseline: each active source intent is resolved with confidence 0.99, no entities, no missing fields and no compound metadata. Status, authorization, missing context and complete-request checks still precede execution.",
        "",
        "## Route totals",
        "",
        f"**{manifest['baseline_count']} intents**: **{counts.get('handoff', 0)} handoffs**, **{counts.get('context', 0)} context replies**, and **{manifest['baseline_count'] - counts.get('handoff', 0) - counts.get('context', 0)} other workflows** (including reads and guided actions).",
        "",
        "| Route | Intent count |",
        "| --- | ---: |",
    ]
    lines.extend(f"| `{key}` | {count} |" for key, count in counts.items())
    lines += [
        "",
        "## Context-dependent behavior",
        "",
        "Sales-period metadata selects bestseller reads; discount-ranking metadata selects discount reads. Supplemental delivery/shipment aliases are listed separately in the JSON and are not counted as active dictionary entries.",
        "",
        "A complete cart-plus-wishlist request is handled by compound orchestration before ordinary dispatch. Execution requires explicit flags, delegated capabilities, durable revisions and fresh facts. Recovery reads receipts only. Ticket creation uses validated form context. Checkout and reorder chat paths do not place orders.",
        "",
        "Only UNKNOWN admits model interpretation. Ambiguous, unsupported, denied and unavailable results remain distinct. Intent recognition and model confidence never grant authority.",
        "",
        "## Refresh and verification",
        "",
        "From the repository root, run `commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/generation/generate_ai_capabilities.py` to regenerate, or append `--check` to reject drift. CI checks both artifacts. Actual routing is evaluated; bindings must resolve to source definitions. Reviewed metadata and source hashes force review on implementation changes but do not prove semantic correctness or live execution.",
        "",
        "See [service guide](README.md), [architecture](architecture.md) and [configuration](configuration.md).",
        "",
        "## Intent inventory",
        "",
        "| Intent | Baseline route | Behavior / boundary |",
        "| --- | --- | --- |",
    ]
    lines.extend(
        f"| `{row['intent']}` | `{row['route']}` | {row['behavior']} |"
        for row in manifest["baseline"]
    )
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    manifest = build_manifest()
    artifacts = {
        SERVICE / "docs/capabilities.json": json.dumps(manifest, indent=2) + "\n",
        ROOT / "commerce-docs/ai-service/intent-action-coverage.md": render_inventory(manifest),
    }
    for path, content in artifacts.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(
                    f"Capability documentation drift: {path.relative_to(ROOT)}; regenerate and review."
                )
        else:
            path.write_text(content)
    print(
        f"{'Verified' if args.check else 'Generated'} {manifest['baseline_count']} baseline intents and {len(manifest['entity_dependent'])} entity-dependent examples."
    )


if __name__ == "__main__":
    main()
