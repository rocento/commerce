"""Contract generators keep their CLI, import, and output behavior after relocation."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
GENERATORS = {
    "catalog_tool_contract": ("commerce-api/rocento-api/crates/api-gateway/openapi/shopper_tools.json",),
    "openapi": ("commerce-api/rocento-api/openapi.json",),
    "assistant_models": ("commerce-assistant-platform/app/commerce_action_engine/contracts/__init__.py",),
    "assistant_validator": ("commerce-web/packages/api-client/src/assistant-schemas.ts",),
    "core_contracts": ("commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/schema.json", "commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/fixtures.json"),
    "meaning_contracts": ("commerce-assistant-platform/contracts/commerce-meaning/v1/schema.json", "commerce-assistant-platform/contracts/commerce-meaning/v1/fixtures.json"),
    "planning_contracts": ("commerce-assistant-platform/contracts/commerce-planning/v1/schema.json", "commerce-assistant-platform/contracts/commerce-planning/v1/fixtures.json"),
    "language_resolution_contract": (
        "commerce-assistant-platform/contracts/language-resolution/v2/schema.json",
        "commerce-assistant-platform/app/commerce_language_engine/src/generated/language-resolution.schema.json",
        "commerce-assistant-platform/app/commerce_language_engine/src/generated/language-resolution-types.ts",
    ),
    "comparison_operators": ("commerce-assistant-platform/app/commerce_language_engine/seeds/recognition-rules.en.json",),
    "public_openapi": ("commerce-corporate-site/public/docs/api/openapi.json",),
    "merchant_openapi": ("commerce-api/rocento-api/merchant-openapi.json",),
}
CHECKABLE = set(GENERATORS) - {
    "catalog_tool_contract", "openapi", "assistant_models", "assistant_validator",
}


def fixture(root):
    for relative in (
        "commerce-ops/scripts/contracts", "commerce-api/rocento-api/crates/api-gateway/openapi",
        "commerce-api/rocento-api/crates/domain-mobile/contract", "commerce-api/rocento-api/crates/commerce-core-contracts/contract", "commerce-assistant-platform/contracts",
    ):
        shutil.copytree(ROOT / relative, root / relative, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(
        ROOT / "commerce-assistant-platform/app", root / "commerce-assistant-platform/app",
        ignore=shutil.ignore_patterns("__pycache__", "commerce_language_engine"),
    )
    for name in GENERATORS:
        relative = Path("commerce-ops/scripts") / f"generate_{name}.py"
        shutil.copyfile(ROOT / relative, root / relative)
    for relative in (
        "commerce-api/theme-contract.json",
        "commerce-assistant-platform/app/commerce_language_engine/seeds/recognition-rules.en.json",
    ):
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    (root / "commerce-web/packages/api-client/src").mkdir(parents=True)


class ContractGeneratorEntrypointTests(unittest.TestCase):
    def test_all_entrypoints_generate_identical_outputs_and_preserve_check_failures(self):
        with tempfile.TemporaryDirectory(prefix="contract-entrypoints-") as directory:
            outside = Path(directory)
            root = outside / "checkout"
            fixture(root)

            def run(name, canonical, *arguments):
                parent = root / "commerce-ops/scripts"
                if canonical:
                    parent /= "contracts"
                return subprocess.run(
                    [sys.executable, "-B", str(parent / f"generate_{name}.py"), *arguments],
                    cwd=outside, capture_output=True, text=True, timeout=60,
                )

            for name, outputs in GENERATORS.items():
                with self.subTest(generator=name):
                    generated = run(name, True)
                    self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)
                    expected = {relative: (root / relative).read_bytes() for relative in outputs}
                    legacy = run(name, False)
                    self.assertEqual(legacy.returncode, 0, legacy.stdout + legacy.stderr)
                    self.assertEqual({relative: (root / relative).read_bytes() for relative in outputs}, expected)
                    if name not in CHECKABLE:
                        continue
                    for canonical in (False, True):
                        checked = run(name, canonical, "--check")
                        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
                    changed = root / outputs[0]
                    if name == "comparison_operators":
                        seed = json.loads(changed.read_text())
                        seed["entries"]["comparison-operators.comparisonOperators.value.1"]["value"] = {}
                        changed.write_text(json.dumps(seed))
                    else:
                        changed.write_text("{}\n")
                    corrupt = changed.read_bytes()
                    results = [run(name, canonical, "--check") for canonical in (False, True)]
                    self.assertNotEqual(results[0].returncode, 0)
                    self.assertEqual(results[0].returncode, results[1].returncode)
                    self.assertEqual(results[0].stdout, results[1].stdout)
                    # Assertion-based generators add the forwarding frame to a traceback.
                    self.assertEqual(results[0].stderr.splitlines()[-1:], results[1].stderr.splitlines()[-1:])
                    self.assertEqual(changed.read_bytes(), corrupt, "--check must not repair drift")
                    changed.write_bytes(expected[outputs[0]])

    def test_imported_legacy_projection_keeps_mutable_policy_and_sibling_imports(self):
        source = json.loads((ROOT / "commerce-api/rocento-api/openapi.json").read_text())
        old_path = sys.path.copy()
        try:
            for canonical in (False, True):
                directory = ROOT / "commerce-ops/scripts"
                if canonical:
                    directory /= "contracts"
                modules = {}
                for audience in ("public", "merchant"):
                    path = directory / f"generate_{audience}_openapi.py"
                    spec = importlib.util.spec_from_file_location(f"entrypoint_{audience}_{canonical}", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    self.assertEqual(module.ROOT, ROOT)
                    modules[audience] = module
                public = modules["public"]
                with patch.object(public, "OPERATIONS", ()):
                    self.assertEqual(public.build_public_contract(source)["paths"], {})
                merchant = modules["merchant"]
                self.assertEqual(merchant.public.ROOT, ROOT)
                self.assertEqual(
                    merchant.public.build_public_contract(source),
                    public.build_public_contract(source),
                )
        finally:
            sys.path[:] = old_path


if __name__ == "__main__":
    unittest.main()
