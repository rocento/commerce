import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "architecture", ROOT / "commerce-ops/scripts/check-ai-architecture.py"
)
architecture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(architecture)


class ArchitectureTests(unittest.TestCase):
    def test_finalization_boundary_keeps_events_and_persistence_separate(self):
        for name, source in (
            ("handle_turn", "async def run(store):\n    await store.save()\n"),
            ("handle_turn", "async def run():\n    finish_debug(token)\n"),
            ("turn_finalization", "async def finish():\n    yield event\n"),
            ("turn_finalization", "def finish(output):\n    output.event('done')\n"),
        ):
            with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / f"{name}.py").write_text(source)
                self.assertTrue(architecture.check_turn_finalization_boundary(root))

    def test_turn_metadata_cannot_be_copied_or_replaced_by_consumers(self):
        cases = (
            ("handle_turn", "async def run():\n    metadata = dict(output.metadata)\n"),
            ("shopping_runtime_responses", "def handle(self):\n    self.metadata = {}\n"),
            ("turn_routing", "def select(self):\n    self._metadata = {}\n"),
            ("turn_routing", "def __init__(self, metadata):\n    self._metadata = dict(metadata)\n"),
        )
        for name, source in cases:
            with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / f"{name}.py").write_text(source)
                self.assertTrue(architecture.check_turn_metadata_ownership(root))

    def test_runtime_response_coordinator_cannot_own_streams_or_execution(self):
        for source in (
            "import httpx\n",
            "from app.commerce_action_engine.application.turn_dependencies import PreparedTurn\n",
            "from app.commerce_resolution_engine.runtime import AgentRuntime\n",
            "async def run():\n    yield event\n",
            "async def run(store):\n    await store.save()\n",
            "async def run(runtime):\n    await runtime.aclose()\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / "shopping_runtime_responses.py").write_text(source)
                self.assertTrue(architecture.check_shopping_runtime_response_boundary(root))

    def test_turn_delegates_shopping_response_publication(self):
        for operation in ("publish_shopping_question", "save_active_shopping"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / "handle_turn.py").write_text(
                    f"async def run(store):\n    await store.{operation}()\n"
                )
                self.assertTrue(architecture.check_shopping_runtime_response_boundary(root))

    def test_language_admission_cannot_take_over_transport_or_turn_execution(self):
        for source in (
            "import httpx\n",
            "from app.commerce_action_engine.application.turn_dependencies import PreparedTurn\n",
            "from app.commerce_action_engine.adapters.commerce import CommerceTools\n",
            "from app.commerce_resolution_engine.providers import UsageProvider\n",
            "async def run():\n    yield event\n",
            "async def run(store):\n    await store.save()\n",
            "async def run(tools):\n    await tools.change_cart({})\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / "language_admission.py").write_text(source)
                self.assertTrue(architecture.check_language_admission_boundary(root))

    def test_turn_delegates_language_admission(self):
        for source in (
            "from app.commerce_action_engine.execution.language import gate\n",
            "from app.commerce_action_engine.application.interpretation import interpret_resolution\n",
            "from app.commerce_resolution_engine.language import propose_language\n",
            "from app.commerce_resolution_engine.admission import issue_unknown_permit\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
                application.mkdir(parents=True)
                (application / "handle_turn.py").write_text(source)
                self.assertTrue(architecture.check_language_admission_boundary(root))

    def test_current_core_obeys_dependency_boundaries(self):
        self.assertEqual(architecture.check_workflows(ROOT), [])

    def test_core_importing_infrastructure_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflows = root / "commerce-assistant-platform/app/commerce_action_engine/execution/core"
            workflows.mkdir(parents=True)
            (workflows / "bad.py").write_text(
                "import httpx\nfrom app.commerce_action_engine.platform.store import Store\n"
            )
            self.assertEqual(
                architecture.check_workflows(root),
                [
                    "commerce-assistant-platform/app/commerce_action_engine/execution/core/bad.py imports httpx",
                    "commerce-assistant-platform/app/commerce_action_engine/execution/core/bad.py imports app.commerce_action_engine.platform.store",
                    "commerce-assistant-platform/app/commerce_action_engine/execution/core/bad.py imports app.commerce_action_engine.platform.store.Store",
                ],
            )

    def test_core_rejects_relative_and_from_import_infrastructure(self):
        for source in (
            "from ...platform import store\n",
            "from ... import platform\n",
            "from app.commerce_action_engine import adapters\n",
            "from ....commerce_resolution_engine import providers\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                core = root / "commerce-assistant-platform/app/commerce_action_engine/execution/core"
                core.mkdir(parents=True)
                (core / "bad.py").write_text(source)
                self.assertTrue(architecture.check_workflows(root))

    def test_engine_and_read_domains_use_their_own_boundaries(self):
        self.assertEqual(architecture.check_engine_imports(ROOT), [])
        self.assertEqual(architecture.check_read_domains(ROOT), [])
        self.assertEqual(architecture.check_catalog_contract_boundary(ROOT), [])
        self.assertEqual(architecture.check_catalog_transport_boundary(ROOT), [])
        self.assertEqual(architecture.check_memory_boundary(ROOT), [])
        self.assertEqual(architecture.check_planning_adapter_boundary(ROOT), [])
        self.assertEqual(architecture.check_commerce_transport_boundary(ROOT), [])
        self.assertEqual(architecture.check_commerce_facade_composition(ROOT), [])
        self.assertEqual(architecture.check_meaning_planning_telemetry_boundary(ROOT), [])
        self.assertEqual(architecture.check_action_adapters(ROOT), [])
        self.assertEqual(architecture.check_basket_boundary(ROOT), [])
        self.assertEqual(architecture.check_direct_reorder_boundary(ROOT), [])
        self.assertEqual(architecture.check_interpretation_adapter_boundary(ROOT), [])
        self.assertEqual(architecture.check_interpreted_handlers(ROOT), [])
        self.assertEqual(architecture.check_action_presentation(ROOT), [])
        self.assertEqual(architecture.check_wishlist_transfer_boundary(ROOT), [])
        self.assertEqual(architecture.check_cart_admission_boundary(ROOT), [])
        self.assertEqual(architecture.check_shopping_stage_boundaries(ROOT), [])
        self.assertEqual(architecture.check_turn_persistence_boundaries(ROOT), [])
        self.assertEqual(architecture.check_shopping_continuation_boundary(ROOT), [])
        self.assertEqual(architecture.check_language_admission_boundary(ROOT), [])
        self.assertEqual(architecture.check_shopping_runtime_response_boundary(ROOT), [])
        self.assertEqual(architecture.check_turn_metadata_ownership(ROOT), [])
        self.assertEqual(architecture.check_turn_finalization_boundary(ROOT), [])
        self.assertEqual(architecture.check_compound_coordinator_boundary(ROOT), [])
        self.assertEqual(architecture.check_legacy_packages(ROOT), [])
        self.assertEqual(architecture.check_retired_module_callers(ROOT), [])
        self.assertEqual(architecture.check_resolution_boundary(ROOT), [])
        self.assertEqual(architecture.check_runtime_application_boundary(ROOT), [])
        self.assertEqual(architecture.check_provider_import_boundary(ROOT), [])
        self.assertEqual(architecture.check_orchestration_boundary(ROOT), [])
        self.assertEqual(architecture.check_knowledge_boundary(ROOT), [])
        self.assertEqual(architecture.check_resolution_planning_boundary(ROOT), [])

    def test_knowledge_rejects_action_execution_and_model_runtime(self):
        for name, source in (
            ("service.py", "from app.commerce_action_engine.platform import Store\n"),
            ("store.py", "from app.commerce_action_engine.platform import Store\n"),
            ("intent_examples.py", "from app.commerce_action_engine.execution.language import gate\n"),
            ("cli.py", "from app.commerce_resolution_engine.providers import build_embedder\n"),
            ("service.py", "from ..commerce_action_engine.execution import agents\n"),
            ("intent_examples.py", "from app.commerce_action_engine.actions.shopping import cart\n"),
            ("store.py", "from app.commerce_action_engine.adapters import commerce\n"),
            ("cli.py", "from app.commerce_resolution_engine.runtime import AgentRuntime\n"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                package = root / "commerce-assistant-platform/app/commerce_knowledge_rag"
                package.mkdir(parents=True)
                (package / name).write_text(source)
                self.assertTrue(architecture.check_knowledge_boundary(root))

    def test_resolution_cannot_import_concrete_planning_sessions(self):
        for name, source in (
            (
                "planning.py",
                "from app.commerce_action_engine.shared.errors import RuntimeErrorCode\n",
            ),
            (
                "shopping.py",
                "from app.commerce_action_engine.execution.planning.runtime import PlanningSession\n",
            ),
            ("basket.py", "from ..commerce_action_engine.execution import planning\n"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                package = root / "commerce-assistant-platform/app/commerce_resolution_engine"
                package.mkdir(parents=True)
                (package / name).write_text(source)
                self.assertTrue(architecture.check_resolution_planning_boundary(root))

    def test_neutral_contracts_cannot_import_engines_or_database(self):
        for source in (
            "from app.commerce_action_engine.contracts import AssistantBlock\n",
            "from ..commerce_resolution_engine import contracts\n",
            "import psycopg\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                package = root / "commerce-assistant-platform/app/commerce_contracts"
                package.mkdir(parents=True)
                (package / "bad.py").write_text(source)
                self.assertTrue(architecture.check_resolution_planning_boundary(root))

    def test_orchestration_rejects_transport_storage_and_presentation(self):
        for source in (
            "from app.commerce_action_engine.execution.agents import Principal\n",
            "from app.commerce_action_engine.shared.errors import ToolUnavailable\n",
            "from app.commerce_knowledge_rag import Retriever\n",
            "from app.commerce_action_engine.execution.language.gate import Resolution\n",
            "import httpx\n",
            "from app.commerce_action_engine.application import responses\n",
            "from app.commerce_action_engine.platform.store import Store\n",
            "from app.commerce_action_engine.adapters import commerce\n",
            "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
            "from ....commerce_action_engine import platform\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                package = (
                    root
                    / "commerce-assistant-platform/app/commerce_orchestration_engine/journeys/compound"
                )
                package.mkdir(parents=True)
                (package / "bad.py").write_text(source)
                self.assertTrue(architecture.check_orchestration_boundary(root))

    def test_compound_dispatch_rejects_concrete_session_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "commerce-assistant-platform/app/commerce_orchestration_engine/journeys/compound"
            package.mkdir(parents=True)
            path = package / "execution.py"
            path.write_text(
                "from app.commerce_action_engine.execution.planning.compound_execution import CompoundExecutionSession\n"
            )
            self.assertTrue(architecture.check_orchestration_boundary(root))
            path.write_text("from .ports import ExecutionSession\n")
            self.assertEqual(architecture.check_orchestration_boundary(root), [])

    def test_lower_engines_cannot_depend_on_orchestration(self):
        for filename in (
            "commerce_resolution_engine/runtime.py",
            "commerce_action_engine/actions/shopping/cart.py",
            "commerce_action_engine/execution/planning/runtime.py",
        ):
            with (
                self.subTest(filename=filename),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app" / filename
                path.parent.mkdir(parents=True)
                path.write_text(
                    "from app.commerce_orchestration_engine.journeys import compound\n"
                )
                self.assertTrue(architecture.check_orchestration_boundary(root))

    def test_application_can_wire_orchestration_to_domain_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = (
                root
                / "commerce-assistant-platform/app/commerce_action_engine/application/handlers/compound.py"
            )
            path.parent.mkdir(parents=True)
            path.write_text(
                "from app.commerce_orchestration_engine.journeys.compound import prepare_journey\n"
            )
            self.assertEqual(architecture.check_orchestration_boundary(root), [])

    def test_domain_presentation_imports_are_rejected(self):
        for filename, source in (
            ("selection.py", "from ...application import responses\n"),
            (
                "selection.py",
                "from app.commerce_action_engine.application.shopping import render\n",
            ),
            ("__init__.py", "from ...application.shopping import shopping_answer\n"),
            ("cart_read.py", "from ...application.responses import cart_summary_text\n"),
        ):
            with (
                self.subTest(filename=filename, source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                domain = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping"
                domain.mkdir(parents=True)
                (domain / filename).write_text(source)
                self.assertTrue(architecture.check_action_presentation(root))

    def test_actions_reject_absolute_and_relative_adapter_imports(self):
        for source in (
            "from app.commerce_action_engine.adapters.commerce import CommerceTools\n",
            "from ...adapters import commerce\n",
            "from ... import adapters\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                domain = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping"
                domain.mkdir(parents=True)
                (domain / "bad.py").write_text(source)
                self.assertTrue(architecture.check_action_adapters(root))

    def test_direct_reorder_transport_stays_out_of_domain_and_chat(self):
        for filename, source in (
            ("actions/shopping/reorder.py", "import httpx\n"),
            ("application/bootstrap.py", "from ..adapters import reorder\n"),
            ("application/handlers/reorder.py", "from ...adapters.reorder import execute\n"),
            ("application/bootstrap.py", "from ..actions.shopping import reorder\n"),
        ):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine" / filename
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_direct_reorder_boundary(root))

    def test_migrated_handlers_reject_legacy_language_dependencies(self):
        for name in ("orders", "support", "customer", "product_facts", "wishlist_transfer", "compound", "cart", "cart_read", "reorder", "comparison", "delivery", "bestsellers", "clarification", "guidance", "product_guidance"):
            for source in (
                "from ...execution.language.gate import Resolution\n",
                "from app.commerce_action_engine.execution import language\n",
                "from ..interpretation import InterpretationDecision\n",
                "from app import language_gate\n",
            ):
                with (
                    self.subTest(name=name, source=source),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    root = Path(temporary)
                    domain = root / "commerce-assistant-platform/app/commerce_action_engine/application/handlers"
                    domain.mkdir(parents=True)
                    (domain / f"{name}.py").write_text(source)
                    self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_compound_planning_rejects_legacy_language_inputs(self):
        for name in ("compound", "compound_execution", "compound_review"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                domain = root / "commerce-assistant-platform/app/commerce_action_engine/execution/planning"
                domain.mkdir(parents=True)
                (domain / f"{name}.py").write_text("from ..language.gate import Resolution\n")
                self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_migrated_action_domains_reject_legacy_language_and_application_envelopes(self):
        for name in ("shopping/cart", "shopping/cart_read", "shopping/cart_removal", "catalog/workflow"):
            for source in (
                "from ...execution.language import Resolution\n",
                "from ...application.interpretation import InterpretationDecision\n",
            ):
                with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / f"commerce-assistant-platform/app/commerce_action_engine/actions/{name}.py"
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_handler_dispatch_rejects_language_and_interpretation_dependencies(self):
        for source in (
            "from ..execution.language.gate import Resolution\n",
            "from app.commerce_action_engine.execution import language\n",
            "from .interpretation import InterpretationDecision\n",
            "from app import language_gate\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/handler_dispatch.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_cart_read_domain_rejects_transport_storage_and_presentation(self):
        for source in (
            "import httpx\n",
            "from ...adapters import commerce\n",
            "from ...platform.store import Store\n",
            "from ...application.responses import cart_summary_text\n",
            "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping/cart_read.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_read_domains(root))

    def test_cart_read_and_dispatch_accept_standard_contracts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owner = root / "commerce-assistant-platform/app/commerce_action_engine"
            for name in (
                "application/handler_dispatch.py",
                "application/handlers/cart_read.py",
                "actions/shopping/cart_read.py",
            ):
                path = owner / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    "from app.commerce_action_engine.contracts import AssistantCart\n"
                )
            self.assertEqual(architecture.check_interpreted_handlers(root), [])
            self.assertEqual(architecture.check_read_domains(root), [])
            self.assertEqual(architecture.check_action_presentation(root), [])

    def test_wishlist_transfer_domain_rejects_presentation_and_infrastructure(self):
        for source in (
            "import httpx\n",
            "from ...application.responses import cart_block\n",
            "from ...adapters.commerce import CommerceTools\n",
            "from ...platform.store import Store\n",
            "from ...contracts import AssistantEvent\n",
            "async def transfer():\n    yield event\n",
            "async def transfer():\n    async with resources:\n        pass\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/actions/customer/wishlist_transfer.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(
                    architecture.check_read_domains(root)
                    + architecture.check_wishlist_transfer_boundary(root)
                )

    def test_wishlist_transfer_handler_cannot_dispatch_commerce_directly(self):
        for operation in (
            "wishlist()", "search_cart_product(name)", "change_cart(change)",
            "remove_wishlist_item(id)", "transfer_wishlist_to_cart(ids)",
        ):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/handlers/wishlist_transfer.py"
                path.parent.mkdir(parents=True)
                path.write_text(f"async def handle():\n    return await tools.{operation}\n")
                self.assertTrue(architecture.check_wishlist_transfer_boundary(root))

    def test_wishlist_transfer_boundary_allows_domain_delegation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owner = root / "commerce-assistant-platform/app/commerce_action_engine"
            domain = owner / "actions/customer/wishlist_transfer.py"
            handler = owner / "application/handlers/wishlist_transfer.py"
            domain.parent.mkdir(parents=True)
            handler.parent.mkdir(parents=True)
            domain.write_text(
                "from .transfers import WishlistJourneyPort\n"
                "from ...contracts import AssistantCart\n"
                "async def transfer(tools: WishlistJourneyPort):\n"
                "    return await tools.change_cart(change)\n"
            )
            handler.write_text(
                "from ...actions.customer import wishlist_transfer\n"
                "async def events():\n"
                "    result = await wishlist_transfer.transfer_named(request, tools)\n"
                "    yield make_event('message.delta', text=str(result))\n"
            )
            self.assertEqual(architecture.check_read_domains(root), [])
            self.assertEqual(architecture.check_wishlist_transfer_boundary(root), [])

    def test_cart_to_wishlist_preserves_domain_and_presenter_ownership(self):
        for name, source in (
            ("actions/customer/cart_to_wishlist", "from ...contracts import AssistantEvent\n"),
            ("actions/customer/cart_to_wishlist", "async def move():\n    yield event\n"),
            ("actions/customer/cart_to_wishlist", "from ...application import responses\n"),
            ("application/handlers/cart", "async def move():\n    await tools.add_wishlist_item(id)\n"),
            ("application/handlers/cart", "async def move():\n    await tools.change_cart(command)\n"),
        ):
            with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / f"commerce-assistant-platform/app/commerce_action_engine/{name}.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(
                    architecture.check_read_domains(root)
                    + architecture.check_wishlist_transfer_boundary(root)
                )

    def test_wishlist_removal_preserves_domain_and_presenter_ownership(self):
        for name, source in (
            ("actions/customer/wishlist_removal", "from ...contracts import AssistantEvent\n"),
            ("actions/customer/wishlist_removal", "async def remove():\n    yield event\n"),
            ("actions/customer/wishlist_removal", "from ...application import responses\n"),
            ("actions/customer/wishlist_removal", "from ...platform import phase\n"),
            ("application/handlers/customer", "async def remove():\n    await tools.remove_wishlist_item(id)\n"),
        ):
            with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / f"commerce-assistant-platform/app/commerce_action_engine/{name}.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(
                    architecture.check_read_domains(root)
                    + architecture.check_wishlist_transfer_boundary(root)
                )

    def test_wishlist_removal_allows_narrow_ports_and_injected_measurement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owner = root / "commerce-assistant-platform/app/commerce_action_engine"
            domain = owner / "actions/customer/wishlist_removal.py"
            handler = owner / "application/handlers/customer.py"
            domain.parent.mkdir(parents=True)
            handler.parent.mkdir(parents=True)
            domain.write_text(
                "from typing import Protocol\n"
                "from contextlib import nullcontext\n"
                "class Remover(Protocol):\n"
                "    async def remove_wishlist_item(self, id): ...\n"
                "async def remove_selected(tools: Remover, measure_write=nullcontext):\n"
                "    with measure_write():\n"
                "        await tools.remove_wishlist_item(id)\n"
            )
            handler.write_text(
                "from ...actions.customer import wishlist_removal\n"
                "async def events():\n"
                "    result = await wishlist_removal.remove_selected(tools)\n"
                "    yield make_event('message.delta', text=str(result))\n"
            )
            self.assertEqual(architecture.check_read_domains(root), [])
            self.assertEqual(architecture.check_wishlist_transfer_boundary(root), [])

    def test_cart_admission_rejects_io_domain_execution_and_async_work(self):
        for source in (
            "import httpx\n", "from urllib.request import urlopen\n",
            "from ...application.handlers import cart\n",
            "from ..customer.cart_to_wishlist import execute\n",
            "from ...adapters.commerce import CommerceTools\n",
            "from ...platform import Store\n",
            "async def admit(request):\n    return None\n",
            "def admit(request):\n    yield request\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping/cart_admission.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_cart_admission_boundary(root))

    def test_cart_admission_accepts_pure_interpretation_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping/cart_admission.py"
            path.parent.mkdir(parents=True)
            path.write_text(
                "import re\n"
                "from ...contracts.interpretation import InterpretedRequest\n"
                "def admit(request: InterpretedRequest):\n"
                "    return request.status == 'RESOLVED'\n"
            )
            self.assertEqual(architecture.check_cart_admission_boundary(root), [])

    def test_shopping_rejects_ambient_wire_imports(self):
        for source in (
            "from ..execution.language.gate import current\n",
            "from ..execution.language import gate\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_shopping_stages_reject_concrete_io_and_coordinator_dependencies(self):
        for name in ("catalog.py", "preparation.py", "retrieval.py", "future_stage.py"):
            for source in (
                "import httpx\n",
                "import psycopg\n",
                "from ...adapters import commerce\n",
                "from ...platform import Store\n",
                "from ...platform.request_revisions import begin\n",
                "from ..shopping import shopping_answer\n",
                "from .. import bootstrap\n",
                "from ..handle_turn import HandleTurn\n",
                "from ..turn_dependencies import PreparedTurn\n",
                "from ...execution.language import gate\n",
                "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
            ):
                with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping_flow" / name
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_shopping_stage_boundaries(root))

    def test_shopping_stages_can_use_domain_values_and_injected_execution_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping_flow/catalog.py"
            path.parent.mkdir(parents=True)
            path.write_text(
                "from ...actions.catalog import CatalogSchema\n"
                "from ...execution.planning.runtime import PlanningSession\n"
                "from ...execution.language.shopping import english_query\n"
                "from ...platform import phase\n"
                "from ..shopping_presentation import render\n"
                "from .contracts import CatalogContext\n"
                "from app.commerce_resolution_engine.runtime import RuntimeTool\n"
                "from app.commerce_resolution_engine.shopping import resolve_shopping\n"
            )
            self.assertEqual(architecture.check_shopping_stage_boundaries(root), [])

    def test_persistence_ports_and_binding_reject_infrastructure_and_turn_imports(self):
        for name in ("persistence.py", "persistence_binding.py"):
            for source in (
                "import psycopg\n",
                "import httpx\n",
                "from ..platform import Store\n",
                "from ..adapters import commerce\n",
                "from ..execution.planning.runtime import PlanningSession\n",
                "from app.commerce_resolution_engine.runtime import AgentRuntime\n",
                "from . import bootstrap\n",
                "from .handle_turn import HandleTurn\n",
                "from .turn_dependencies import PreparedTurn\n",
            ):
                with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / "commerce-assistant-platform/app/commerce_action_engine/application" / name
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_turn_persistence_boundaries(root))

    def test_only_turn_composition_can_bind_persistence(self):
        for name, source in (
            ("handle_turn.py", "from .persistence_binding import bind_persistence\n"),
            ("persistence.py", "from . import persistence_binding\n"),
            ("handlers/cart.py", "from ..persistence_binding import bind_persistence\n"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application" / name
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_turn_persistence_boundaries(root))

    def test_persistence_binding_uses_domain_contracts_at_composition(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            application = root / "commerce-assistant-platform/app/commerce_action_engine/application"
            application.mkdir(parents=True)
            (application / "persistence.py").write_text(
                "from ..actions.shopping.contracts import ShoppingClarification\n"
                "from app.commerce_contracts.compound_plan import CompoundPlan\n"
                "from app.commerce_orchestration_engine.journeys.compound import ExecutionStore\n"
            )
            (application / "persistence_binding.py").write_text(
                "from . import persistence\n"
                "from .persistence import TurnPersistence\n"
            )
            for name in ("bootstrap.py", "turn_dependencies.py"):
                (application / name).write_text(
                    "from .persistence_binding import bind_persistence\n"
                )
            self.assertEqual(architecture.check_turn_persistence_boundaries(root), [])

    def test_shopping_continuation_rejects_io_and_turn_ownership(self):
        for source in (
            "import httpx\n",
            "import psycopg\n",
            "from urllib.request import urlopen\n",
            "from ..adapters import commerce\n",
            "from ..platform import Store\n",
            "from .turn_dependencies import PreparedTurn\n",
            "from . import bootstrap\n",
            "from .handle_turn import HandleTurn\n",
            "from .persistence_binding import bind_persistence\n",
            "from .resources import RequestResources\n",
            "from .turn_output import TurnOutput\n",
            "from .api.events import event\n",
            "from ..contracts import AssistantEvent\n",
            "from .handlers.shopping_clarification import shopping_question_view\n",
            "from ..execution.language import gate\n",
            "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
            "from app.commerce_resolution_engine.runtime import AgentRuntime\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping_continuation.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_shopping_continuation_boundary(root))

    def test_shopping_continuation_cannot_own_stream_or_resource_lifetime(self):
        for source in (
            "async def resolve():\n    yield result\n",
            "def resolve():\n    yield from events\n",
            "async def resolve():\n    async with resources:\n        return result\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping_continuation.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                violations = architecture.check_shopping_continuation_boundary(root)
                self.assertEqual(len(violations), 1)
                self.assertIn("owns stream/resource lifetime", violations[0])

    def test_shopping_continuation_can_await_typed_ports_and_return_domain_outcomes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/application/shopping_continuation.py"
            path.parent.mkdir(parents=True)
            path.write_text(
                "from dataclasses import dataclass\n"
                "from uuid import UUID\n"
                "from . import persistence\n"
                "from .persistence import ShoppingPersistence\n"
                "from ..contracts import AssistantChatInput\n"
                "from ..actions.shopping.contracts import ShoppingIntent\n"
                "from ..actions.shopping.continuation import resolve_active_reply\n"
                "from ..execution.language.shopping_reply import resolve_shopping_reply\n"
                "async def resolve(storage: ShoppingPersistence):\n"
                "    return await storage.active.shopping_active()\n"
            )
            self.assertEqual(architecture.check_shopping_continuation_boundary(root), [])

    def test_compound_coordinator_rejects_io_composition_and_other_handlers(self):
        for source in (
            "import httpx\n",
            "from psycopg import AsyncConnection\n",
            "from urllib.request import urlopen\n",
            "from ..adapters import commerce\n",
            "from ..platform import Store\n",
            "from .turn_dependencies import PreparedTurn\n",
            "from . import bootstrap\n",
            "from .handle_turn import HandleTurn\n",
            "from .persistence_binding import bind_persistence\n",
            "from .resources import RequestResources\n",
            "from .turn_output import TurnOutput\n",
            "from .api.events import event\n",
            "from ..contracts import AssistantEvent\n",
            "from .handlers import cart\n",
            "from ..execution.language import gate\n",
            "from ..execution.planning.compound_execution import CompoundExecutionSession\n",
            "from app.commerce_orchestration_engine.journeys.compound import execute\n",
            "from app.commerce_orchestration_engine.journeys.compound.execution import execute\n",
            "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
            "from app.commerce_resolution_engine.runtime import AgentRuntime\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/compound_coordinator.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_compound_coordinator_boundary(root))

    def test_compound_coordinator_cannot_own_stream_or_resource_lifetime(self):
        for source in (
            "async def recover():\n    yield result\n",
            "def recover():\n    yield from events\n",
            "async def prepare():\n    async with resources:\n        return result\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/compound_coordinator.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                violations = architecture.check_compound_coordinator_boundary(root)
                self.assertEqual(len(violations), 1)
                self.assertIn("owns stream/resource lifetime", violations[0])

    def test_compound_coordinator_cannot_implement_claim_or_write_execution(self):
        for operation in ("writer.apply(command, action_id)", "store.transition_compound(scope, request, action_id, transition='dispatch')"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/application/compound_coordinator.py"
                path.parent.mkdir(parents=True)
                path.write_text(f"async def prepare():\n    return await {operation}\n")
                violations = architecture.check_compound_coordinator_boundary(root)
                self.assertEqual(len(violations), 1)
                self.assertIn("owns compound claim/write execution", violations[0])

    def test_compound_coordinator_can_delegate_through_owned_ports_and_journeys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/application/compound_coordinator.py"
            path.parent.mkdir(parents=True)
            path.write_text(
                "from typing import Protocol\n"
                "from .persistence import CompoundPersistence, QuestionPublisher\n"
                "from .handlers import compound\n"
                "from .handlers.compound import prepare_response\n"
                "from ..execution.planning import compound_review\n"
                "from ..execution.planning.compound_review import Review\n"
                "from ..actions.catalog.bindings import ProductReader\n"
                "from ..actions.shopping.compound import CompoundWriter\n"
                "from ..contracts import AssistantChatInput, AssistantBlock\n"
                "from app.commerce_contracts.agents import Principal\n"
                "from app.commerce_contracts.compound_plan import CompoundScope\n"
                "from app.commerce_orchestration_engine.journeys.compound import reconcile\n"
                "async def recover(storage: CompoundPersistence):\n"
                "    return await storage.reader.get_compound_plan()\n"
                "async def publish(port: QuestionPublisher):\n"
                "    return await port.publish_question()\n"
            )
            self.assertEqual(architecture.check_compound_coordinator_boundary(root), [])

    def test_diagnostics_reject_wire_envelopes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/application/interpretation_diagnostics.py"
            path.parent.mkdir(parents=True)
            path.write_text("from ..execution.language.gate import Resolution\n")
            self.assertTrue(architecture.check_interpreted_handlers(root))

    def test_search_replay_rejects_wire_and_infrastructure_dependencies(self):
        for name in ("search_context", "clarification", "recommendations", "followup_ports", "compound_clarification", "routing", "example_policy", "proposals"):
            self._assert_followup_boundary(name)

    def _assert_followup_boundary(self, name):
        for source in (
            "from .gate import Resolution\n",
            "from . import gate\n",
            "from ...application.interpretation import InterpretationDecision\n",
            "from ...platform import Store\n",
            "import httpx\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / f"commerce-assistant-platform/app/commerce_action_engine/execution/language/{name}.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_interpretation_adapter_boundary(root))

    def test_interpretation_adapter_rejects_application_and_transport(self):
        for source in (
            "import httpx\n",
            "from ...application.context import TurnContext\n",
            "from app.commerce_action_engine.platform import Settings\n",
            "from app.commerce_resolution_engine.providers import OpenAIProvider\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                domain = (
                    root / "commerce-assistant-platform/app/commerce_action_engine/execution/language"
                )
                domain.mkdir(parents=True)
                (domain / "compatibility.py").write_text(source)
                self.assertTrue(
                    architecture.check_interpretation_adapter_boundary(root)
                )

    def test_basket_workflow_rejects_transport_and_telemetry_dependencies(self):
        for name in ("basket_workflow.py", "basket_ports.py", "baskets.py"):
            for source in (
                "import httpx\n",
                "from ...platform import policy_summary\n",
                "from app.commerce_action_engine.platform.telemetry import execution_summary\n",
                "from .baskets import BasketTools\n",
                "from ...application.baskets import plan_basket\n",
            ):
                with (
                    self.subTest(name=name, source=source),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    root = Path(temporary)
                    domain = (
                        root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping"
                    )
                    domain.mkdir(parents=True)
                    (domain / name).write_text(source)
                    self.assertTrue(architecture.check_basket_boundary(root))

    def test_action_ports_can_import_contracts_and_shared_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            domain = root / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping"
            domain.mkdir(parents=True)
            (domain / "ports.py").write_text(
                "from ...contracts import AssistantCart\n"
                "from ...shared.errors import ToolUnavailable\n"
            )
            self.assertEqual(architecture.check_action_adapters(root), [])

    def test_provider_transport_rejects_commerce_and_runtime_imports(self):
        for name in (
            "openai",
            "config",
            "factory",
            "settings",
            "usage",
            "embeddings",
            "smoke",
            "future_adapter",
        ):
            for source in (
                "from app.commerce_action_engine.execution.agents import Principal\n",
                "from ...commerce_action_engine import knowledge\n",
                "from ...commerce_knowledge_rag import Retriever\n",
                "from ..runtime import AgentRuntime\n",
            ):
                with (
                    self.subTest(name=name, source=source),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    root = Path(temporary)
                    providers = (
                        root / "commerce-assistant-platform/app/commerce_resolution_engine/providers"
                    )
                    providers.mkdir(parents=True)
                    (providers / f"{name}.py").write_text(source)
                    self.assertTrue(architecture.check_provider_import_boundary(root))

    def test_model_runtime_rejects_application_imports(self):
        for source in (
            "from app.commerce_action_engine.execution.agents import AgentCatalog\n",
            "from app.commerce_action_engine.shared.errors import ToolDenied\n",
            "from app.commerce_action_engine.knowledge import Retriever\n",
            "from app.commerce_knowledge_rag import Retriever\n",
            "from app.commerce_action_engine.platform import phase\n",
            "from app.commerce_action_engine.contracts import AssistantBlock\n",
            "from app.commerce_action_engine.execution.planning.runtime import planned_read\n",
            "from ..commerce_action_engine import adapters\n",
            "from app.commerce_action_engine.application.shopping import shopping_answer\n",
            "from ..commerce_action_engine.application import shopping\n",
            "from app.commerce_action_engine.execution.language.gate import current\n",
            "from ..commerce_action_engine.execution import language\n",
        ):
            with (
                self.subTest(source=source),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                engine = root / "commerce-assistant-platform/app/commerce_resolution_engine"
                engine.mkdir(parents=True)
                (engine / "runtime.py").write_text(source)
                self.assertTrue(architecture.check_runtime_application_boundary(root))

    def test_action_engine_cannot_call_model_directly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = root / "commerce-assistant-platform/app/commerce_action_engine"
            engine.mkdir(parents=True)
            (engine / "bad.py").write_text(
                "async def run(provider):\n"
                "    request = ModelRequest(())\n"
                "    await provider.generate(request)\n"
                "    provider.stream(request)\n"
            )
            self.assertEqual(len(architecture.check_resolution_boundary(root)), 3)

    def test_parallel_compatibility_package_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            duplicate = root / "commerce-assistant-platform/app/shopping"
            duplicate.mkdir(parents=True)
            self.assertEqual(
                architecture.check_legacy_packages(root),
                ["commerce-assistant-platform/app/shopping duplicates the canonical engine"],
            )

    def test_retired_root_module_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "commerce-assistant-platform/app"
            app.mkdir(parents=True)
            retired = tuple(sorted(architecture.RETIRED_ROOT_MODULES))
            for name in retired:
                (app / f"{name}.py").write_text("# duplicate\n")
            self.assertEqual(
                architecture.check_legacy_packages(root),
                [
                    f"commerce-assistant-platform/app/{name}.py duplicates the canonical engine"
                    for name in retired
                ],
            )

    def test_root_accepts_entrypoints_but_rejects_new_loose_modules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "commerce-assistant-platform/app"
            app.mkdir(parents=True)
            for name in architecture.ROOT_ENTRYPOINT_MODULES:
                (app / f"{name}.py").write_text("# supported entry point\n")
            self.assertEqual(architecture.check_legacy_packages(root), [])
            (app / "helpers.py").write_text("# put this in its owning engine\n")
            self.assertEqual(
                architecture.check_legacy_packages(root),
                ["commerce-assistant-platform/app/helpers.py has no root entry-point role; use an owning engine package"],
            )

    def test_retired_engine_modules_and_packages_are_rejected(self):
        for name in architecture.RETIRED_ENGINE_MODULES:
            for package in (False, True):
                with self.subTest(name=name, package=package), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    target = root / "commerce-assistant-platform/app/commerce_action_engine" / name.replace(".", "/")
                    path = target / "__init__.py" if package else target.with_suffix(".py")
                    path.parent.mkdir(parents=True)
                    path.write_text("# retired compatibility entry point\n")
                    self.assertTrue(architecture.check_legacy_packages(root))

    def test_retired_engine_imports_exports_and_patch_targets_are_rejected(self):
        for name in architecture.RETIRED_ENGINE_MODULES | architecture.RETIRED_ENGINE_EXPORTS:
            module = f"{architecture.ENGINE}.{name}"
            parent, member = module.rsplit(".", 1)
            for source in (
                f"import {module}\n",
                f"from {parent} import {member}\n",
                f"importlib.import_module('{module}')\n",
                f"monkeypatch.setattr('{module}.value', object())\n",
            ):
                with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    target = root / "commerce-assistant-platform/tests/caller.py"
                    target.parent.mkdir(parents=True)
                    target.write_text(source)
                    self.assertTrue(architecture.check_retired_module_callers(root))

    def test_retired_engine_relative_imports_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "commerce-assistant-platform/app/commerce_action_engine/application/caller.py"
            target.parent.mkdir(parents=True)
            target.write_text("from ..providers.openai import OpenAIProvider\n")
            self.assertTrue(architecture.check_retired_module_callers(root))
            target.write_text("from app.commerce_resolution_engine.providers import OpenAIProvider\n")
            self.assertEqual(architecture.check_retired_module_callers(root), [])

    def test_retired_imports_and_literal_patch_targets_are_rejected(self):
        sources = (
            "import app.usage\n",
            "from app.core_library import build_registry\n",
            "from app import commerce_meaning\n",
            "importlib.import_module('app.rich_responses')\n",
            "__import__('app.failures')\n",
            "monkeypatch.setattr('app.core_facade.CompatibilityFacade', object())\n",
            "mock.patch(target='app.usage.UsageProvider')\n",
            "from app import language_gate\n",
            "importlib.import_module('app.bootstrap')\n",
            "from app.agents import Principal\n",
            "from app.contracts import AssistantEvent\n",
            "from app.tools import CommerceTools\n",
        )
        for directory in ("commerce-assistant-platform/tests", "scripts", "commerce-assistant-platform/evals", "commerce-assistant-platform/local"):
            for source in sources:
                with self.subTest(directory=directory, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    target = root / directory / "caller.py"
                    target.parent.mkdir(parents=True)
                    target.write_text(source)
                    self.assertTrue(architecture.check_retired_module_callers(root))

    def test_retired_relative_import_is_rejected_but_canonical_import_is_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "commerce-assistant-platform/app/consumer.py"
            target.parent.mkdir(parents=True)
            target.write_text("from .usage import UsageProvider\n")
            self.assertTrue(architecture.check_retired_module_callers(root))
            target.write_text("from app.commerce_resolution_engine.providers.usage import UsageProvider\n")
            self.assertEqual(architecture.check_retired_module_callers(root), [])

    def test_read_domains_reject_transport_and_relative_presentation_imports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            domain = root / "commerce-assistant-platform/app/commerce_action_engine/actions/customer"
            domain.mkdir(parents=True)
            (domain / "bad.py").write_text(
                "import httpx\nfrom ...application import responses\n"
            )
            violations = architecture.check_read_domains(root)
            self.assertTrue(any("imports httpx" in item for item in violations))
            self.assertTrue(any("application.responses" in item for item in violations))

    def test_catalog_read_domains_reject_transport_language_and_presentation(self):
        for name in ("comparison", "bestsellers"):
            for source in (
                "import httpx\n",
                "from ...application import responses\n",
                "from ...execution.language import Resolution\n",
            ):
                with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / f"commerce-assistant-platform/app/commerce_action_engine/actions/catalog/{name}.py"
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_read_domains(root))

    def test_catalog_contracts_reject_transport_runtime_and_package_backdoors(self):
        for name in ("contracts", "discovery"):
            for source in (
                "import httpx\n",
                "from .tools import Product\n",
                "from . import Product\n",
                "from ...platform import telemetry\n",
                "from app.commerce_resolution_engine.runtime import RuntimeTool\n",
            ):
                with self.subTest(name=name, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / f"commerce-assistant-platform/app/commerce_action_engine/actions/catalog/{name}.py"
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_catalog_contract_boundary(root))

    def test_catalog_transport_cannot_return_to_domain_or_import_runtime(self):
        for filename, source in (
            ("actions/catalog/tools.py", "import httpx\n"),
            ("actions/catalog/tools.py", "from ...platform import catalog_counter\n"),
            ("actions/catalog/ports.py", "from app.commerce_resolution_engine.runtime import RuntimeTool\n"),
            ("adapters/catalog.py", "from ..application import responses\n"),
            ("adapters/catalog.py", "from ..platform import telemetry\n"),
            ("adapters/catalog.py", "from app.commerce_resolution_engine.providers import OpenAIProvider\n"),
        ):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine" / filename
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_catalog_transport_boundary(root))

    def test_meaning_planning_reject_platform_and_application_imports(self):
        for relative in ("actions/shopping/meaning.py", "execution/planning/runtime.py"):
            for source in ("from ...platform import planning_summary\n", "from ...application import shopping\n", "import httpx\n"):
                with self.subTest(relative=relative, source=source), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    path = root / "commerce-assistant-platform/app/commerce_action_engine" / relative
                    path.parent.mkdir(parents=True)
                    path.write_text(source)
                    self.assertTrue(architecture.check_meaning_planning_telemetry_boundary(root))

    def test_cart_transport_rejects_facade_and_runtime_dependencies(self):
        for source in (
            "from .commerce import CommerceTools\n",
            "from ..application import bootstrap\n",
            "from ..platform import telemetry\n",
            "from ..execution.planning import PlanningSession\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/adapters/cart.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_commerce_transport_boundary(root))

    def test_order_and_wishlist_transports_reject_facade_dependency(self):
        for name in ("orders", "wishlist", "support", "delivery", "shopper_catalog"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / f"commerce-assistant-platform/app/commerce_action_engine/adapters/{name}.py"
                path.parent.mkdir(parents=True)
                path.write_text("from .commerce import CommerceTools\n")
                self.assertTrue(architecture.check_commerce_transport_boundary(root))

    def test_commerce_facade_cannot_regain_http_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "commerce-assistant-platform/app/commerce_action_engine/adapters/commerce.py"
            path.parent.mkdir(parents=True)
            path.write_text("async def read(self):\n    return await self.client.get('/catalog')\n")
            self.assertTrue(architecture.check_commerce_facade_composition(root))

    def test_planning_rejects_concrete_transport_and_composition(self):
        for source in (
            "from ...adapters.planned_commerce import PlannedCommerceTools\n",
            "from ... import adapters\n",
            "from ...platform import planning_summary\n",
            "from ...application import bootstrap\n",
            "import httpx\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/execution/planning/bad.py"
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_planning_adapter_boundary(root))

    def test_memory_domain_and_adapter_reject_boundary_regressions(self):
        for filename, source in (
            ("actions/shopping/personalization.py", "import httpx\n"),
            ("actions/shopping/personalization.py", "from ...adapters.memory import MemoryTransport\n"),
            ("actions/shopping/personalization.py", "from ...platform import telemetry\n"),
            ("actions/shopping/personalization.py", "from app.commerce_resolution_engine.runtime import RuntimeTool\n"),
            ("adapters/memory.py", "from ..application import responses\n"),
            ("adapters/memory.py", "from ..platform import telemetry\n"),
            ("adapters/memory.py", "from app.commerce_resolution_engine.providers import OpenAIProvider\n"),
        ):
            with self.subTest(filename=filename, source=source), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine" / filename
                path.parent.mkdir(parents=True)
                path.write_text(source)
                self.assertTrue(architecture.check_memory_boundary(root))

    def test_catalog_modules_reject_application_composition(self):
        for filename in ("tools.py", "__init__.py"):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "commerce-assistant-platform/app/commerce_action_engine/actions/catalog" / filename
                path.parent.mkdir(parents=True)
                path.write_text("from app.commerce_action_engine.application.catalog import registry\n")
                self.assertTrue(architecture.check_action_presentation(root))

    def test_engine_rejects_compatibility_alias_imports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = root / "commerce-assistant-platform/app/commerce_action_engine"
            engine.mkdir(parents=True)
            (engine / "bad.py").write_text("from app import language_gate\n")
            violations = architecture.check_engine_imports(root)
            self.assertTrue(any("app.language_gate" in item for item in violations))


if __name__ == "__main__":
    unittest.main()
