import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "preflight", ROOT / "commerce-ops/scripts/release/agentic-preflight.py"
)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def test_preserved_image_requires_matching_gateway_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'release'
            installed = Path(directory) / 'image'
            relative = Path('commerce_action_engine/contracts/__init__.py')
            source = root / 'commerce-assistant-platform/app' / relative
            target = installed / relative
            source.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            source.write_text('CONTRACT = 1\n')
            target.write_text('# Built image\nCONTRACT = 1\n')
            preflight.installed_contract_checks(root, installed)
            target.write_text('CONTRACT = 2\n')
            with self.assertRaisesRegex(ValueError, 'incompatible gateway contracts'):
                preflight.installed_contract_checks(root, installed)

    def test_preserved_contract_allows_only_additive_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'release'
            installed = Path(directory) / 'image'
            relative = Path('commerce_action_engine/contracts/__init__.py')
            source = root / 'commerce-assistant-platform/app' / relative
            target = installed / relative
            source.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            old = 'class AssistantOld:\n    value: str\nAssistantOld.model_rebuild()\n'
            added = 'class AssistantNew:\n    sequence: int\nAssistantNew.model_rebuild()\n'
            target.write_text(old)
            source.write_text(old + added)
            preflight.installed_contract_checks(root, installed, allow_additions=True)
            for incompatible in (old.replace('str', 'int') + added, added):
                source.write_text(incompatible)
                with self.assertRaisesRegex(ValueError, 'incompatible gateway contracts'):
                    preflight.installed_contract_checks(root, installed, allow_additions=True)

    def test_generated_contracts_match_release_sources(self):
        preflight.generated_checks(ROOT)

    def test_generator_failure_identifies_failed_script(self):
        with (
            patch.object(
                preflight.subprocess,
                "run",
                side_effect=subprocess.CalledProcessError(1, "generator"),
            ),
            self.assertRaisesRegex(
                ValueError, "Contract generator generate_openapi.py failed"
            ),
        ):
            preflight.generated_checks(ROOT)

    def test_current_routes(self):
        preflight.proxy_checks(ROOT)

    def test_old_basket_mount_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "commerce-ops/deploy/assistant"
            target.mkdir(parents=True)
            for name in ("tools.conf", "ingress.conf"):
                value = (ROOT / "commerce-ops/deploy/assistant" / name).read_text()
                (target / name).write_text(value.replace("baskets/", "removed/"))
            with self.assertRaisesRegex(ValueError, "Missing tool route"):
                preflight.proxy_checks(root)

    def test_missing_tracking_proxy_blocks_release_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "commerce-ops/deploy/assistant"
            target.mkdir(parents=True)
            for name in ("tools.conf", "ingress.conf"):
                value = (ROOT / "commerce-ops/deploy/assistant" / name).read_text()
                (target / name).write_text(
                    value.replace("/v1/tracking", "/v1/removed-tracking")
                )
            with self.assertRaisesRegex(
                ValueError, "Missing ingress route: GET /v1/tracking"
            ):
                preflight.proxy_checks(root)

    def test_installed_release_checks_code_and_reviewed_knowledge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "release"
            installed = Path(directory) / "image/app"
            source = root / "commerce-assistant-platform"
            (source / "app/commerce_resolution_engine").mkdir(parents=True)
            (source / "knowledge").mkdir()
            classifier = source / "app/commerce_resolution_engine/language.py"
            classifier.write_text("INSTRUCTIONS = 'current classifier'\n")
            # The separately built Node engine is deliberately absent in the image.
            separate = source / "app/commerce_language_engine/research.py"
            separate.parent.mkdir()
            separate.write_text("raise RuntimeError('not the Python service')\n")
            corpus = source / "knowledge/intent-examples.discovery-v2.en.json"
            corpus.write_text('[{"utterance":"I want dinner"}]\n')
            installed.mkdir(parents=True)
            shutil.copytree(
                source / "app/commerce_resolution_engine",
                installed / "commerce_resolution_engine",
            )
            shutil.copytree(source / "knowledge", installed.parent / "knowledge")
            preflight.installed_checks(root, installed)
            target = installed.parent / "knowledge" / corpus.name
            target.write_text("[]\n")
            with self.assertRaisesRegex(ValueError, "image knowledge"):
                preflight.installed_checks(root, installed)
            target.unlink()
            with self.assertRaisesRegex(ValueError, "image knowledge"):
                preflight.installed_checks(root, installed)
            shutil.copyfile(corpus, target)
            (installed / "commerce_resolution_engine/language.py").write_text(
                "old prompt\n"
            )
            with self.assertRaisesRegex(ValueError, "image does not match"):
                preflight.installed_checks(root, installed)

    def test_wrong_method_or_upstream_is_rejected(self):
        config = (ROOT / "commerce-ops/deploy/assistant/ingress.conf").read_text()
        self.assertFalse(
            preflight.route_allowed(
                config, "/v1/chat", "DELETE", "http://ai-service:8000"
            )
        )
        self.assertFalse(
            preflight.route_allowed(config, "/v1/chat", "POST", "http://untrusted:8000")
        )

    def test_tracking_routes_preserve_get_only_and_id_boundary(self):
        config = (ROOT / "commerce-ops/deploy/assistant/ingress.conf").read_text()
        uid = "00000000-0000-0000-0000-000000000001"
        for route in ("/v1/tracking", "/v1/tracking/" + uid):
            self.assertTrue(
                preflight.route_allowed(config, route, "GET", "http://ai-service:8000")
            )
            self.assertFalse(
                preflight.route_allowed(config, route, "POST", "http://ai-service:8000")
            )
        for route in ("/v1/tracking/short", "/v1/tracking/" + uid + "/extra"):
            self.assertFalse(
                preflight.route_allowed(config, route, "GET", "http://ai-service:8000")
            )


if __name__ == "__main__":
    unittest.main()
