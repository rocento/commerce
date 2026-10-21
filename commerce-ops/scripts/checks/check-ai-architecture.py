"""Check canonical engine imports and deterministic domain boundaries."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import ast
from importlib.util import resolve_name
from pathlib import Path

FORBIDDEN_ROOTS = {
    "fastapi",
    "starlette",
    "httpx",
    "psycopg",
    "asyncpg",
    "sqlalchemy",
    "openai",
    "anthropic",
    "boto3",
    "redis",
}
FORBIDDEN_APP_MODULES = {
    "app.commerce_knowledge_rag",
    "app.commerce_resolution_engine.providers",
    "app.commerce_resolution_engine.runtime",
    "app.commerce_resolution_engine.admission",
    "app.commerce_action_engine.application",
    "app.commerce_action_engine.adapters",
    "app.commerce_action_engine.providers",
    "app.commerce_action_engine.platform",
}


def imported_modules(source: str) -> list[str]:
    tree = ast.parse(source)
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
    return modules


def check_workflows(root: Path) -> list[str]:
    workflow_root = root / "commerce-assistant-platform/app/commerce_action_engine/execution/core"
    violations = []
    for path in sorted(workflow_root.rglob("*.py")):
        for module in resolved_imports(
            path, root / "commerce-assistant-platform/app/commerce_action_engine"
        ):
            root_module = module.split(".", 1)[0]
            if root_module in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in FORBIDDEN_APP_MODULES
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


ENGINE = "app.commerce_action_engine"
READ_DOMAINS = ("orders", "customer", "support")
LEGACY_PACKAGES = frozenset(
    {
        "adapters",
        "api",
        "application",
        "catalog",
        "core",
        "interpretation",
        "knowledge",
        "language",
        "planning",
        "platform",
        "providers",
        "reasoning",
        "shopping",
        "workflows",
    }
)
RETIRED_ROOT_MODULES = frozenset(
    {
        "account_intents",
        "agents",
        "baseline",
        "baskets",
        "bootstrap",
        "cart_actions",
        "catalog_cache",
        "catalog_tools",
        "costs",
        "commerce_meaning",
        "contracts",
        "core_facade",
        "core_library",
        "failures",
        "rich_responses",
        "usage",
        "discovery",
        "discovery_workflow",
        "execution",
        "knowledge_store",
        "language_gate",
        "model",
        "personalization",
        "planning_library",
        "planning_runtime",
        "provider_settings",
        "reorder",
        "policy_answers",
        "settings",
        "planning_commerce",
        "provider_factory",
        "runtime",
        "security",
        "shopping_intent",
        "singleflight",
        "store",
        "telemetry",
        "tools",
    }
)
ROOT_ENTRYPOINT_MODULES = frozenset(
    {"__init__", "main", "knowledge_cli", "knowledge_extract", "provider_smoke"}
)
RETIRED_ENGINE_MODULES = frozenset(
    {
        "contracts.intent_example",
        "contracts.language_proposal",
        "contracts.compound_plan",
        "contracts.compound_write",
        "execution.planning.commerce",
        "knowledge",
        "providers",
        "contracts.model",
        "execution.runtime",
        "execution.baseline",
        "execution.reasoning",
        "actions.shopping.service",
        "application.handlers.compound_execution",
        "application.runtime_chat",
    }
)
RETIRED_ENGINE_EXPORTS = frozenset(
    {
        "execution.planning.PlannedCommerceTools",
        "actions.shopping.shopping_answer",
        "actions.shopping.ShoppingAnswer",
        "actions.catalog.registry",
        "actions.catalog.tools.registry",
        "actions.shopping.plain",
        "actions.shopping.render",
        "actions.shopping.BasketTools",
        "actions.shopping.baskets.BasketTools",
        "actions.shopping.reorder.order_number",
        "execution.language.resolve_reply",
        "execution.language.gate.resolve_reply",
        "execution.language.gate.guidance",
        "execution.language.gate.current",
        "execution.language.proposals.resolution_fingerprint",
        "execution.language.proposals.accept_proposal",
        "execution.language.proposals.clarification",
        "execution.language.gate.route",
        "execution.language.gate.ASSISTANT_API_INTENTS",
        "execution.language.gate.CART_ACTION_INTENTS",
        "execution.language.gate.CART_API_INTENTS",
        "execution.language.gate.CATALOG_API_INTENTS",
        "execution.language.gate.CONFIRMATION_CONTEXT_INTENTS",
        "execution.language.gate.DELIVERY_API_INTENTS",
        "execution.language.gate.LOCATION_API_INTENTS",
        "execution.language.gate.ORDER_API_INTENTS",
        "execution.language.gate.PRODUCT_FACT_INTENTS",
        "execution.language.gate.SHIPMENT_API_INTENTS",
        "execution.language.gate.SUPPORT_API_INTENTS",
        "execution.language.gate.SUPPORT_DETAIL_API_INTENTS",
        "execution.language.gate.WISHLIST_API_INTENTS",
        "execution.language.gate.WISHLIST_WRITE_API_INTENTS",

        "execution.language.route",
        "execution.language.gate.shopping_plan",
        "execution.language.shopping_plan",
        "execution.language.current",
        "execution.language.gate.diagnostic_summary",
        "execution.language.guidance",
        "execution.language.gate.reasoning_fallback_message",
        "execution.language.compound_review",
    }
)


def check_legacy_packages(root: Path) -> list[str]:
    """Do not recreate the removed parallel package tree under app/."""
    app_root = root / "commerce-assistant-platform/app"
    duplicate_packages = [
        f"{(app_root / name).relative_to(root)} duplicates the canonical engine"
        for name in sorted(LEGACY_PACKAGES)
        if (app_root / name).is_dir()
    ]
    duplicate_modules = [
        f"{(app_root / (name + '.py')).relative_to(root)} duplicates the canonical engine"
        for name in sorted(RETIRED_ROOT_MODULES)
        if (app_root / (name + ".py")).is_file()
    ]
    unexpected_modules = [
        f"{path.relative_to(root)} has no root entry-point role; use an owning engine package"
        for path in sorted(app_root.glob("*.py"))
        if path.stem not in ROOT_ENTRYPOINT_MODULES | RETIRED_ROOT_MODULES
    ]
    engine_duplicates = []
    for name in sorted(RETIRED_ENGINE_MODULES):
        target = app_root / "commerce_action_engine" / name.replace(".", "/")
        for path in (target, target.with_suffix(".py")):
            if path.is_file() or (path.is_dir() and any(path.rglob("*.py"))):
                engine_duplicates.append(
                    f"{path.relative_to(root)} recreates a retired engine alias"
                )
    return duplicate_packages + duplicate_modules + unexpected_modules + engine_duplicates


def check_retired_module_callers(root: Path) -> list[str]:
    """Reject retired imports and literal dynamic import/patch targets in maintained Python."""
    prefixes = (
        "app.commerce_resolution_engine.baseline",
        "app.commerce_resolution_engine.admission.ChatReasoningGateway",
        "app.commerce_resolution_engine.providers.ChatModel",
        "app.commerce_resolution_engine.providers.chat.ChatModel",
        *(f"app.{name}" for name in sorted(RETIRED_ROOT_MODULES)),
        *(f"{ENGINE}.{name}" for name in sorted(RETIRED_ENGINE_MODULES | RETIRED_ENGINE_EXPORTS)),
    )
    violations = []
    for directory in (
        "commerce-assistant-platform/app", "commerce-assistant-platform/tests", "commerce-assistant-platform/evals", "commerce-assistant-platform/local", "commerce-ops/scripts"
    ):
        for path in sorted((root / directory).rglob("*.py")):
            if any(part in {"node_modules", "__pycache__", ".venv"} for part in path.parts):
                continue
            tree = ast.parse(path.read_text())
            modules = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    if node.level and directory == "commerce-assistant-platform/app":
                        relative = path.relative_to(root / directory).with_suffix("")
                        package = ".".join(("app", *relative.parts[:-1]))
                        module = resolve_name("." * node.level + module, package)
                    modules.append(module)
                    modules.extend(f"{module}.{alias.name}" for alias in node.names)
                elif isinstance(node, ast.Call):
                    name = (
                        node.func.id if isinstance(node.func, ast.Name)
                        else node.func.attr if isinstance(node.func, ast.Attribute)
                        else ""
                    )
                    if name in {"import_module", "__import__", "patch", "setattr"}:
                        values = [*node.args, *(keyword.value for keyword in node.keywords)]
                        modules.extend(
                            value.value for value in values
                            if isinstance(value, ast.Constant) and isinstance(value.value, str)
                        )
            for module in sorted(set(modules)):
                if any(module == prefix or module.startswith(prefix + ".") for prefix in prefixes):
                    violations.append(f"{path.relative_to(root)} references retired {module}")
    return violations


def resolved_imports(
    path: Path, engine_root: Path, package_root: str = ENGINE
) -> list[str]:
    """Include relative imports and from-import names so aliases cannot bypass checks."""
    relative = path.relative_to(engine_root).with_suffix("")
    package = ".".join((package_root, *relative.parts[:-1]))
    modules = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                module = resolve_name("." * node.level + module, package)
            modules.append(module)
            modules.extend(f"{module}.{alias.name}" for alias in node.names)
    return modules


def check_engine_imports(root: Path) -> list[str]:
    """Canonical engine implementations must not depend on legacy app aliases."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for path in sorted(engine_root.rglob("*.py")):
        for module in resolved_imports(path, engine_root):
            if module.startswith("app.") and not (
                module
                in {
                    ENGINE,
                    "app.commerce_resolution_engine",
                    "app.commerce_orchestration_engine",
                    "app.commerce_contracts",
                    "app.commerce_knowledge_rag",
                }
                or module.startswith(
                    (
                        ENGINE + ".",
                        "app.commerce_resolution_engine.",
                        "app.commerce_orchestration_engine.",
                        "app.commerce_contracts.",
                        "app.commerce_knowledge_rag.",
                    )
                )
            ):
                violations.append(
                    f"{path.relative_to(root)} imports noncanonical {module}"
                )
    return violations


def check_read_domains(root: Path) -> list[str]:
    """Extracted read domains own commerce logic, not presentation or infrastructure."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    allowed = tuple(ENGINE + "." + area for area in ("actions", "contracts", "shared"))
    violations = []
    paths = [
        path for domain in READ_DOMAINS
        for path in (engine_root / "actions" / domain).rglob("*.py")
    ]
    for name in ("catalog/comparison", "catalog/bestsellers", "shopping/cart_read"):
        domain = engine_root / f"actions/{name}.py"
        if domain.exists():
            paths.append(domain)
    for path in sorted(paths):
        for module in resolved_imports(path, engine_root):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or (
                module.startswith("app.")
                and not any(
                    module == prefix or module.startswith(prefix + ".")
                    for prefix in allowed
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_catalog_contract_boundary(root: Path) -> list[str]:
    """Catalog values must load without HTTP, application or model runtime code."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    allowed = tuple(
        ENGINE + ".actions.catalog." + name for name in ("contracts", "discovery")
    )
    violations = []
    for name in ("contracts", "discovery"):
        path = owner / f"actions/catalog/{name}.py"
        if not path.exists():
            continue
        for module in resolved_imports(path, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or (
                module.startswith("app.")
                and not any(
                    module == prefix or module.startswith(prefix + ".")
                    for prefix in allowed
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_catalog_transport_boundary(root: Path) -> list[str]:
    """Keep catalog execution in its adapter and runtime wiring in application."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for relative in ("actions/catalog/tools.py", "actions/catalog/ports.py", "adapters/catalog.py"):
        path = owner / relative
        if not path.exists():
            continue
        adapter = relative.startswith("adapters/")
        for module in resolved_imports(path, owner):
            forbidden = (
                ENGINE + ".application",
                ENGINE + ".platform",
                ENGINE + ".execution",
                "app.commerce_resolution_engine.runtime",
                "app.commerce_resolution_engine.providers",
            )
            if (not adapter and module.split(".", 1)[0] in FORBIDDEN_ROOTS) or any(
                module == prefix or module.startswith(prefix + ".") for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_meaning_planning_telemetry_boundary(root: Path) -> list[str]:
    """Meaning and planning report through injected callbacks, never platform code."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for relative in ("actions/shopping/meaning.py", "execution/planning/runtime.py"):
        path = owner / relative
        if not path.exists():
            continue
        for module in resolved_imports(path, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (ENGINE + ".platform", ENGINE + ".application", ENGINE + ".adapters")
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_commerce_transport_boundary(root: Path) -> list[str]:
    """Extracted transports cannot depend on the facade, application or runtime."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for relative in ("adapters/cart.py", "adapters/orders.py", "adapters/wishlist.py", "adapters/support.py", "adapters/delivery.py", "adapters/shopper_catalog.py", "adapters/http_response.py"):
        path = owner / relative
        if not path.exists():
            continue
        for module in resolved_imports(path, owner):
            if any(module == prefix or module.startswith(prefix + ".") for prefix in (
                ENGINE + ".adapters.commerce", ENGINE + ".application",
                ENGINE + ".platform", ENGINE + ".execution",
                "app.commerce_resolution_engine.runtime", "app.commerce_resolution_engine.providers",
            )):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_commerce_facade_composition(root: Path) -> list[str]:
    """The facade composes capability adapters and must not perform HTTP I/O."""
    path = root / "commerce-assistant-platform/app/commerce_action_engine/adapters/commerce.py"
    if not path.exists():
        return []
    violations = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            target = node.func.value
            if (
                isinstance(target, ast.Attribute) and target.attr == "client"
                and isinstance(target.value, ast.Name) and target.value.id == "self"
                and node.func.attr in {"get", "post", "put", "patch", "delete", "request", "stream", "send"}
            ):
                violations.append(f"{path.relative_to(root)} performs {node.func.attr}; delegate HTTP to a capability adapter")
    return violations


def check_planning_adapter_boundary(root: Path) -> list[str]:
    """Planning policy must not import concrete transport or application wiring."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for path in sorted((owner / "execution/planning").rglob("*.py")):
        for module in resolved_imports(path, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (ENGINE + ".adapters", ENGINE + ".application", ENGINE + ".platform")
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_memory_boundary(root: Path) -> list[str]:
    """Personalization owns memory rules; its adapter owns only scoped transport."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for relative in ("actions/shopping/personalization.py", "adapters/memory.py"):
        path = owner / relative
        if not path.exists():
            continue
        adapter = relative.startswith("adapters/")
        forbidden = (
            ENGINE + ".application",
            ENGINE + ".platform",
            ENGINE + ".execution",
            "app.commerce_resolution_engine.runtime",
            "app.commerce_resolution_engine.providers",
        ) + (() if adapter else (ENGINE + ".adapters",))
        for module in resolved_imports(path, owner):
            if (not adapter and module.split(".", 1)[0] in FORBIDDEN_ROOTS) or any(
                module == prefix or module.startswith(prefix + ".") for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_action_adapters(root: Path) -> list[str]:
    """Action workflows depend on owned ports, not concrete commerce adapters."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    prefix = ENGINE + ".adapters"
    violations = []
    for path in sorted((engine_root / "actions").rglob("*.py")):
        for module in resolved_imports(path, engine_root):
            if module == prefix or module.startswith(prefix + "."):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_direct_reorder_boundary(root: Path) -> list[str]:
    """Keep legacy reorder transport out of domain rules and live chat wiring."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    domain = owner / "actions/shopping/reorder.py"
    if domain.exists():
        for module in resolved_imports(domain, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS:
                violations.append(f"{domain.relative_to(root)} imports {module}")
    for path in sorted((owner / "application").rglob("*.py")):
        for module in resolved_imports(path, owner):
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (
                    ENGINE + ".adapters.reorder",
                    ENGINE + ".actions.shopping.reorder",
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_basket_boundary(root: Path) -> list[str]:
    """Basket proposal code uses a context/quote port and injected telemetry."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for name in ("baskets.py", "basket_ports.py", "basket_workflow.py"):
        path = engine_root / "actions/shopping" / name
        if not path.exists():
            continue
        for module in resolved_imports(path, engine_root):
            forbidden = (
                ENGINE + ".adapters",
                ENGINE + ".platform",
                ENGINE + ".application",
                ENGINE + ".actions.shopping.baskets.BasketTools",
                ENGINE + ".actions.shopping.BasketTools",
            )
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_interpretation_adapter_boundary(root: Path) -> list[str]:
    """Interpretation projection and replay policy consume contracts, never application or IO."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for name in ("compatibility", "search_context", "clarification", "recommendations", "followup_ports", "compound_clarification", "routing", "example_policy", "proposals"):
        path = owner / f"execution/language/{name}.py"
        if not path.exists():
            continue
        forbidden = (
            ENGINE + ".application",
            ENGINE + ".adapters",
            ENGINE + ".platform",
            "app.commerce_resolution_engine",
        )
        if name != "compatibility":
            forbidden += (ENGINE + ".execution.language",)
        for module in resolved_imports(path, owner):
            if name == "proposals" and any(module == ENGINE + ".execution.language." + allowed or module.startswith(ENGINE + ".execution.language." + allowed + ".") for allowed in ("routing", "handoffs", "proposal_constraints")):
                continue
            if name == "example_policy" and (module == ENGINE + ".execution.language.routing" or module.startswith(ENGINE + ".execution.language.routing.")):
                continue
            if name == "routing" and (module == ENGINE + ".execution.language.handoffs" or module.startswith(ENGINE + ".execution.language.handoffs.")):
                continue
            port = ENGINE + ".execution.language.followup_ports"
            if name in {"clarification", "recommendations", "compound_clarification"} and (
                module == port or module.startswith(port + ".")
            ):
                continue
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_interpreted_handlers(root: Path) -> list[str]:
    """Migrated handlers consume standard contracts, not legacy language routing."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    paths = [
        owner / f"application/handlers/{name}.py"
        for name in ("orders", "support", "customer", "product_facts", "wishlist_transfer", "compound", "cart", "cart_read", "reorder", "comparison", "delivery", "bestsellers", "clarification", "guidance", "product_guidance")
    ] + [
        owner / f"execution/planning/{name}.py"
        for name in ("compound", "compound_execution", "compound_review")
    ] + [
        owner / f"actions/shopping/{name}.py"
        for name in ("cart", "cart_read", "cart_removal")
    ]
    paths.append(owner / "actions/catalog/workflow.py")
    paths.append(owner / "application/interpretation_diagnostics.py")
    paths.append(owner / "application/handler_dispatch.py")
    for path in paths:
        if not path.exists():
            continue
        for module in resolved_imports(path, owner):
            if path.name == "guidance.py" and (module == ENGINE + ".execution.language.handoffs" or module.startswith(ENGINE + ".execution.language.handoffs.")):
                continue
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (
                    ENGINE + ".execution.language",
                    ENGINE + ".application.interpretation",
                    "app.language_gate",
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    shopping = owner / "application/shopping.py"
    if shopping.exists():
        for module in resolved_imports(shopping, owner):
            if module == ENGINE + ".execution.language" or module.startswith(ENGINE + ".execution.language.gate"):
                violations.append(f"{shopping.relative_to(root)} imports {module}")
    return violations


def check_action_presentation(root: Path) -> list[str]:
    """Application presentation cannot return to domain implementations."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    prefix = ENGINE + ".application"
    violations = []
    for path in sorted((engine_root / "actions").rglob("*.py")):
        for module in resolved_imports(path, engine_root):
            if module == prefix or module.startswith(prefix + "."):
                violations.append(
                    f"{path.relative_to(root)} imports presentation {module}"
                )
    return violations


def check_wishlist_transfer_boundary(root: Path) -> list[str]:
    """Wishlist mutation domains own writes; their handlers own events."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for name in ("wishlist_transfer", "cart_to_wishlist", "wishlist_removal"):
        domain = owner / f"actions/customer/{name}.py"
        if not domain.exists():
            continue
        for module in resolved_imports(domain, owner):
            if module == ENGINE + ".contracts.AssistantEvent":
                violations.append(f"{domain.relative_to(root)} imports stream events")
        for node in ast.walk(ast.parse(domain.read_text())):
            if isinstance(node, (ast.Yield, ast.YieldFrom, ast.AsyncWith)):
                violations.append(
                    f"{domain.relative_to(root)}:{node.lineno} owns stream/resource lifetime"
                )
    for name, operations in (
        ("wishlist_transfer", {
            "wishlist", "search_cart_product", "change_cart",
            "remove_wishlist_item", "transfer_wishlist_to_cart",
        }),
        ("cart", {"add_wishlist_item", "change_cart"}),
        ("customer", {"remove_wishlist_item"}),
    ):
        handler = owner / f"application/handlers/{name}.py"
        if not handler.exists():
            continue
        for node in ast.walk(ast.parse(handler.read_text())):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in operations):
                violations.append(
                    f"{handler.relative_to(root)}:{node.lineno} owns transfer commerce operation"
                )
    return violations


def check_cart_admission_boundary(root: Path) -> list[str]:
    """Shared cart admission is synchronous policy over interpreted contracts."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    path = owner / "actions/shopping/cart_admission.py"
    if not path.exists():
        return []
    allowed = ENGINE + ".contracts.interpretation"
    violations = []
    for module in resolved_imports(path, owner):
        if (
            module.split(".", 1)[0]
            in FORBIDDEN_ROOTS | {"aiohttp", "requests", "socket", "sqlite3", "urllib"}
            or (module.startswith("app.") and module != allowed
                and not module.startswith(allowed + "."))
        ):
            violations.append(f"{path.relative_to(root)} imports {module}")
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, (ast.AsyncFunctionDef, ast.Await, ast.Yield, ast.YieldFrom)):
            violations.append(
                f"{path.relative_to(root)}:{node.lineno} owns async/stream execution"
            )
    return violations


def check_shopping_stage_boundaries(root: Path) -> list[str]:
    """Shopping stages use owned ports, never concrete IO or their caller."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    forbidden = (
        ENGINE + ".adapters",
        ENGINE + ".platform.Store",
        ENGINE + ".platform.store",
        ENGINE + ".platform.compound_plans",
        ENGINE + ".platform.request_revisions",
        ENGINE + ".platform.tracking",
        ENGINE + ".application.shopping",
        ENGINE + ".application.bootstrap",
        ENGINE + ".application.handle_turn",
        ENGINE + ".application.turn_dependencies",
        ENGINE + ".execution.language.gate",
        "app.commerce_resolution_engine.providers",
    )
    violations = []
    for path in sorted((owner / "application/shopping_flow").rglob("*.py")):
        for module in resolved_imports(path, owner):
            if (
                module.split(".", 1)[0] in FORBIDDEN_ROOTS
                or module == ENGINE + ".execution.language"
                or any(
                    module == prefix or module.startswith(prefix + ".")
                    for prefix in forbidden
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    return violations


def check_turn_persistence_boundaries(root: Path) -> list[str]:
    """Turn persistence contracts stay independent; binding belongs to composition."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    application = ENGINE + ".application"
    port = application + ".persistence"
    binding = application + ".persistence_binding"
    forbidden = (
        ENGINE + ".adapters",
        ENGINE + ".platform",
        ENGINE + ".execution",
        "app.commerce_resolution_engine",
    )
    violations = []
    for name in ("persistence.py", "persistence_binding.py"):
        path = owner / "application" / name
        if not path.exists():
            continue
        for module in resolved_imports(path, owner):
            if (
                module.split(".", 1)[0] in FORBIDDEN_ROOTS
                or any(
                    module == prefix or module.startswith(prefix + ".")
                    for prefix in forbidden
                )
                or (
                    module.startswith(application + ".")
                    and module != port
                    and not module.startswith(port + ".")
                )
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
    for path in sorted(owner.rglob("*.py")):
        if path.relative_to(owner).as_posix() in {
            "application/bootstrap.py",
            "application/turn_dependencies.py",
            "application/persistence_binding.py",
        }:
            continue
        for module in resolved_imports(path, owner):
            if module == binding or module.startswith(binding + "."):
                violations.append(
                    f"{path.relative_to(root)} imports composition binding {module}"
                )
    return violations


def check_shopping_continuation_boundary(root: Path) -> list[str]:
    """Continuation admission returns outcomes; turns own IO and stream lifetime."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    path = owner / "application/shopping_continuation.py"
    if not path.exists():
        return []
    application = ENGINE + ".application"
    persistence = application + ".persistence"
    execution = ENGINE + ".execution"
    reply = execution + ".language.shopping_reply"
    forbidden = (
        ENGINE + ".adapters",
        ENGINE + ".platform",
        ENGINE + ".contracts.AssistantEvent",
        "app.commerce_resolution_engine",
        "app.commerce_knowledge_rag",
    )
    violations = []
    for module in resolved_imports(path, owner):
        if (
            module.split(".", 1)[0]
            in FORBIDDEN_ROOTS | {"aiohttp", "requests", "socket", "sqlite3", "urllib"}
            or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            )
            or (
                module.startswith(application + ".")
                and module != persistence
                and not module.startswith(persistence + ".")
            )
            or (
                (module == execution or module.startswith(execution + "."))
                and module != reply
                and not module.startswith(reply + ".")
            )
        ):
            violations.append(f"{path.relative_to(root)} imports {module}")
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, (ast.Yield, ast.YieldFrom, ast.AsyncWith)):
            violations.append(
                f"{path.relative_to(root)}:{node.lineno} owns stream/resource lifetime"
            )
    return violations


def check_turn_finalization_boundary(root: Path) -> list[str]:
    """Keep persistence in finalization and public events in the turn driver."""
    application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
    violations = []
    for name in ("handle_turn", "turn_finalization"):
        path = application / f"{name}.py"
        if not path.exists():
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if name == "turn_finalization" and isinstance(node, (ast.Yield, ast.YieldFrom)):
                violations.append(f"{path.relative_to(root)}:{node.lineno} emits stream events")
            if not isinstance(node, ast.Call):
                continue
            member = node.func.attr if isinstance(node.func, ast.Attribute) else None
            function = node.func.id if isinstance(node.func, ast.Name) else None
            if name == "handle_turn" and (
                member in {"save", "save_tracking", "record_trace", "flush"}
                or function in {"finish_debug", "debug_record"}
            ):
                violations.append(f"{path.relative_to(root)}:{node.lineno} owns finalization persistence")
            if name == "turn_finalization" and member in {"event", "stream", "generate", "select"}:
                violations.append(f"{path.relative_to(root)}:{node.lineno} owns events or execution")
    return violations


def check_turn_metadata_ownership(root: Path) -> list[str]:
    """Keep the turn's metadata aliases attached to the one output-owned record."""
    application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
    violations = []
    for name in ("handle_turn", "turn_output", "turn_routing", "shopping_runtime_responses"):
        path = application / f"{name}.py"
        if not path.exists():
            continue
        for function in ast.walk(ast.parse(path.read_text())):
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(function):
                if not isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    continue
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if (isinstance(target, ast.Name) and target.id == "metadata" and name == "handle_turn"
                            and (node.value is None or ast.unparse(node.value) != "output.metadata")):
                        violations.append(f"{path.relative_to(root)}:{node.lineno} replaces turn metadata")
                    if (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
                            and target.value.id == "self" and target.attr in {"metadata", "_metadata"}):
                        allowed = (
                            target.attr == "_metadata" and function.name == "__init__"
                            and (name == "turn_output" or ast.unparse(node.value) == "metadata")
                        )
                        if not allowed:
                            violations.append(f"{path.relative_to(root)}:{node.lineno} replaces shared metadata")
    return violations


def check_shopping_runtime_response_boundary(root: Path) -> list[str]:
    """Runtime response translation must not own execution or stream lifetime."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    path = owner / "application/shopping_runtime_responses.py"
    violations = []
    if path.exists():
        forbidden = (
            ENGINE + ".adapters",
            ENGINE + ".platform",
            ENGINE + ".application.bootstrap",
            ENGINE + ".application.handle_turn",
            ENGINE + ".application.turn_dependencies",
            ENGINE + ".application.turn_output",
            ENGINE + ".contracts.AssistantEvent",
            "app.commerce_resolution_engine.runtime.AgentRuntime",
            "app.commerce_resolution_engine.providers",
            "app.commerce_resolution_engine.admission",
            "app.commerce_resolution_engine.chat",
        )
        for module in resolved_imports(path, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, (ast.Yield, ast.YieldFrom, ast.AsyncWith)):
                violations.append(
                    f"{path.relative_to(root)}:{node.lineno} owns stream/resource lifetime"
                )
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {
                        "save", "save_tracking", "record_trace", "aclose", "stream",
                        "generate", "change_cart", "create_order", "begin_request",
                    }):
                violations.append(
                    f"{path.relative_to(root)}:{node.lineno} owns turn/runtime execution"
                )
    turn = owner / "application/handle_turn.py"
    if turn.exists():
        for node in ast.walk(ast.parse(turn.read_text())):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"publish_shopping_question", "save_active_shopping"}):
                violations.append(
                    f"{turn.relative_to(root)}:{node.lineno} owns shopping response publication"
                )
    return violations


def check_language_admission_boundary(root: Path) -> list[str]:
    """Language coordination cannot acquire transport, commerce or turn lifetime."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    path = owner / "application/language_admission.py"
    violations = []
    if path.exists():
        forbidden = (
            ENGINE + ".adapters",
            ENGINE + ".platform.store",
            ENGINE + ".application.bootstrap",
            ENGINE + ".application.handle_turn",
            ENGINE + ".application.turn_dependencies",
            ENGINE + ".contracts.AssistantEvent",
            "app.commerce_resolution_engine.providers",
            "app.commerce_resolution_engine.chat",
        )
        for module in resolved_imports(path, owner):
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(f"{path.relative_to(root)} imports {module}")
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, (ast.Yield, ast.YieldFrom, ast.AsyncWith)):
                violations.append(
                    f"{path.relative_to(root)}:{node.lineno} owns stream/resource lifetime"
                )
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {
                        "save", "save_tracking", "record_trace", "aclose",
                        "change_cart", "add_wishlist_item", "create_order",
                    }):
                violations.append(
                    f"{path.relative_to(root)}:{node.lineno} owns persistence/commerce execution"
                )
    turn = owner / "application/handle_turn.py"
    if turn.exists():
        for module in resolved_imports(turn, owner):
            if module in {
                ENGINE + ".execution.language.gate",
                ENGINE + ".application.interpretation.interpret_resolution",
                "app.commerce_resolution_engine.language.propose_language",
                "app.commerce_resolution_engine.admission.install_permit",
                "app.commerce_resolution_engine.admission.issue_unknown_permit",
            }:
                violations.append(f"{turn.relative_to(root)} imports admission owner {module}")
    return violations


def check_compound_coordinator_boundary(root: Path) -> list[str]:
    """Compound admission delegates execution; turns own IO and stream lifetime."""
    owner = root / "commerce-assistant-platform/app/commerce_action_engine"
    path = owner / "application/compound_coordinator.py"
    if not path.exists():
        return []
    application = ENGINE + ".application"
    execution = ENGINE + ".execution"
    owned_dependencies = (
        application + ".persistence",
        application + ".handlers.compound",
        execution + ".planning.compound_review",
    )
    package_parents = {
        application,
        application + ".handlers",
        execution,
        execution + ".planning",
    }
    forbidden = (
        ENGINE + ".adapters",
        ENGINE + ".platform",
        ENGINE + ".contracts.AssistantEvent",
        "app.commerce_resolution_engine",
        "app.commerce_knowledge_rag",
        "app.commerce_orchestration_engine.journeys.compound.execution",
        "app.commerce_orchestration_engine.journeys.compound.execute",
    )
    violations = []
    for module in resolved_imports(path, owner):
        if (
            module.split(".", 1)[0]
            in FORBIDDEN_ROOTS | {"aiohttp", "requests", "socket", "sqlite3", "urllib"}
            or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            )
            or (
                module not in package_parents
                and any(
                    module.startswith(prefix + ".")
                    for prefix in (application, execution)
                )
                and not any(
                    module == prefix or module.startswith(prefix + ".")
                    for prefix in owned_dependencies
                )
            )
        ):
            violations.append(f"{path.relative_to(root)} imports {module}")
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, (ast.Yield, ast.YieldFrom, ast.AsyncWith)):
            violations.append(
                f"{path.relative_to(root)}:{node.lineno} owns stream/resource lifetime"
            )
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"apply", "transition_compound"}
        ):
            violations.append(
                f"{path.relative_to(root)}:{node.lineno} owns compound claim/write execution"
            )
    return violations


def check_resolution_boundary(root: Path) -> list[str]:
    """Keep model request construction and provider calls in the resolution engine."""
    engine_root = root / "commerce-assistant-platform/app/commerce_action_engine"
    violations = []
    for path in sorted(engine_root.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            call = node.func
            is_request = isinstance(call, ast.Name) and call.id == "ModelRequest"
            is_generate = isinstance(call, ast.Attribute) and call.attr == "generate"
            is_provider_stream = (
                isinstance(call, ast.Attribute)
                and call.attr == "stream"
                and isinstance(call.value, ast.Name)
                and call.value.id in {"provider", "test_provider"}
            )
            if is_request or is_generate or is_provider_stream:
                violations.append(
                    f"{path.relative_to(root)}:{node.lineno} contains a direct model operation"
                )
    return violations


def check_runtime_application_boundary(root: Path) -> list[str]:
    """The model runtime receives application handlers; it never imports them."""
    package = "app.commerce_resolution_engine"
    engine_root = root / "commerce-assistant-platform/app/commerce_resolution_engine"
    path = engine_root / "runtime.py"
    if not path.exists():
        return []
    prefixes = (ENGINE, "app.commerce_knowledge_rag")
    return [
        f"{path.relative_to(root)} imports application, presentation or infrastructure {module}"
        for module in resolved_imports(path, engine_root, package)
        if any(
            module == prefix or module.startswith(prefix + ".") for prefix in prefixes
        )
    ]


def check_provider_import_boundary(root: Path) -> list[str]:
    """Provider implementations may not depend on commerce/runtime infrastructure."""
    package = "app.commerce_resolution_engine"
    engine_root = root / "commerce-assistant-platform/app/commerce_resolution_engine"
    violations = []
    paths = [
        engine_root / "contracts.py",
        engine_root / "acceptance.py",
        engine_root / "shopping.py",
        engine_root / "basket.py",
        engine_root / "adapter.py",
        engine_root / "language.py",
        *sorted((engine_root / "providers").rglob("*.py")),
    ]
    for path in paths:
        relative = path.relative_to(engine_root).as_posix()
        if not path.exists():
            continue
        for module in resolved_imports(path, engine_root, package):
            # The stable smoke CLI defers environment loading to application composition.
            if relative == "providers/smoke.py" and module in {
                ENGINE + ".application.provider_smoke",
                ENGINE + ".application.provider_smoke.main",
            }:
                continue
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (
                    ENGINE,
                    "app.commerce_knowledge_rag",
                    package + ".runtime",
                )
            ):
                violations.append(
                    f"{path.relative_to(root)} imports commerce/runtime implementation {module}"
                )
    return violations


def check_orchestration_boundary(root: Path) -> list[str]:
    """Journeys coordinate domain ports, never transport, UI, storage or providers."""
    package = "app.commerce_orchestration_engine"
    engine_root = root / "commerce-assistant-platform/app/commerce_orchestration_engine"
    forbidden = (
        ENGINE + ".execution.agents",
        ENGINE + ".shared.errors",
        ENGINE + ".application",
        ENGINE + ".adapters",
        ENGINE + ".platform",
        ENGINE + ".providers",
        ENGINE + ".knowledge",
        "app.commerce_knowledge_rag",
        ENGINE + ".execution.language",
        "app.commerce_resolution_engine.providers",
    )
    violations = []
    for path in sorted(engine_root.rglob("*.py")):
        for module in resolved_imports(path, engine_root, package):
            if (
                path.relative_to(engine_root).as_posix() == "journeys/compound/execution.py"
                and module.startswith(ENGINE + ".execution.planning.compound_execution")
            ):
                violations.append(
                    f"{path.relative_to(root)} imports concrete execution session {module}"
                )
            if module.split(".", 1)[0] in FORBIDDEN_ROOTS or any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(
                    f"{path.relative_to(root)} imports infrastructure/presentation {module}"
                )
    # Application composition may call orchestration; lower layers may not.
    for name in ("commerce_action_engine", "commerce_resolution_engine"):
        owner = root / "commerce-assistant-platform/app" / name
        for path in sorted(owner.rglob("*.py")):
            if (
                name == "commerce_action_engine"
                and path.relative_to(owner).parts[0] == "application"
            ):
                continue
            for module in resolved_imports(path, owner, "app." + name):
                if module == package or module.startswith(package + "."):
                    violations.append(
                        f"{path.relative_to(root)} imports orchestration {module}"
                    )
    return violations


def check_knowledge_boundary(root: Path) -> list[str]:
    """RAG consumes neutral values and injected dependencies, never engines."""
    package = "app.commerce_knowledge_rag"
    owner = root / "commerce-assistant-platform/app/commerce_knowledge_rag"
    allowed = (package, "app.commerce_contracts")
    violations = []
    for path in sorted(owner.rglob("*.py")):
        for module in resolved_imports(path, owner, package):
            if module.startswith("app.") and not any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in allowed
            ):
                violations.append(
                    f"{path.relative_to(root)} imports non-knowledge implementation {module}"
                )
    return violations


def check_resolution_planning_boundary(root: Path) -> list[str]:
    """Resolution consumes a planning port, never an action-owned session."""
    package = "app.commerce_resolution_engine"
    owner = root / "commerce-assistant-platform/app/commerce_resolution_engine"
    violations = []
    for path in sorted(owner.rglob("*.py")):
        for module in resolved_imports(path, owner, package):
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in (
                    ENGINE + ".execution.agents",
                    ENGINE + ".shared.errors",
                )
            ):
                violations.append(
                    f"{path.relative_to(root)} imports legacy shared contracts {module}"
                )
    for name in ("planning.py", "shopping.py", "basket.py"):
        path = owner / name
        if not path.exists():
            continue
        forbidden = (
            (ENGINE,) if name == "planning.py" else (ENGINE + ".execution.planning",)
        )
        for module in resolved_imports(path, owner, package):
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in forbidden
            ):
                violations.append(
                    f"{path.relative_to(root)} imports concrete action planning {module}"
                )
    owner = root / "commerce-assistant-platform/app/commerce_contracts"
    for path in sorted(owner.rglob("*.py")):
        for module in resolved_imports(path, owner, "app.commerce_contracts"):
            if (
                module.startswith("app.")
                and not module.startswith("app.commerce_contracts.")
            ) or module.split(".", 1)[0] in FORBIDDEN_ROOTS:
                violations.append(
                    f"{path.relative_to(root)} imports engine/infrastructure {module}"
                )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[3]
    )
    args = parser.parse_args()
    root = args.root.resolve()
    violations = (
        check_workflows(root)
        + check_engine_imports(root)
        + check_read_domains(root)
        + check_catalog_contract_boundary(root)
        + check_catalog_transport_boundary(root)
        + check_memory_boundary(root)
        + check_planning_adapter_boundary(root)
        + check_commerce_transport_boundary(root)
        + check_commerce_facade_composition(root)
        + check_meaning_planning_telemetry_boundary(root)
        + check_action_adapters(root)
        + check_direct_reorder_boundary(root)
        + check_basket_boundary(root)
        + check_interpretation_adapter_boundary(root)
        + check_interpreted_handlers(root)
        + check_action_presentation(root)
        + check_wishlist_transfer_boundary(root)
        + check_cart_admission_boundary(root)
        + check_shopping_stage_boundaries(root)
        + check_turn_persistence_boundaries(root)
        + check_shopping_continuation_boundary(root)
        + check_language_admission_boundary(root)
        + check_shopping_runtime_response_boundary(root)
        + check_turn_metadata_ownership(root)
        + check_turn_finalization_boundary(root)
        + check_compound_coordinator_boundary(root)
        + check_legacy_packages(root)
        + check_retired_module_callers(root)
        + check_resolution_boundary(root)
        + check_runtime_application_boundary(root)
        + check_provider_import_boundary(root)
        + check_orchestration_boundary(root)
        + check_knowledge_boundary(root)
        + check_resolution_planning_boundary(root)
    )
    if violations:
        print("Architecture boundary violations:\n" + "\n".join(violations))
        return 1
    print(
        "Architecture boundaries passed: deterministic core, canonical engine imports, read domains, action adapter/presentation boundaries, resolution ownership, orchestration boundaries, and one canonical package tree."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
