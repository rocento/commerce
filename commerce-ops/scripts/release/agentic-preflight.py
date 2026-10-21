"""Check M01 release inputs without credentials, network calls or source edits.

Run with the AI service environment. Optionally compare copies of the actual
mounted nginx configurations before publishing a newly built deployment.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def route_allowed(config, path, method, upstream):
    for mode, pattern, body in re.findall(
        r"location\s+(=|~)\s+([^\n]+?)\s+\{\n(.*?)\n  \}", config, re.DOTALL
    ):
        pattern = pattern.strip().strip('"')
        matches = (
            pattern == path if mode == "=" else re.fullmatch(pattern, path) is not None
        )
        methods = re.search(r"limit_except\s+([A-Z ]+)\s*\{", body)
        if (
            matches
            and methods
            and method in methods.group(1).split()
            and upstream in body
            and "proxy_pass $upstream;" in body
        ):
            return True
    return False


def proxy_checks(root):
    ingress = (root / "commerce-ops/deploy/assistant/ingress.conf").read_text()
    tools = (root / "commerce-ops/deploy/assistant/tools.conf").read_text()
    uid = "00000000-0000-0000-0000-000000000001"
    for method, route in [
        ("POST", "chat"),
        ("GET", "history"),
        ("GET", "tracking"),
        ("GET", "tracking/live"),
        ("GET", "tracking/" + uid),
        ("GET", "provider-settings"),
        ("POST", "provider-settings"),
        ("POST", "provider-settings/test"),
        ("GET", "provider-settings/tracking"),
        ("POST", "provider-settings/tracking"),
        ("GET", "provider-settings/readiness"),
        ("POST", "provider-settings/acceptance"),
    ]:
        if not route_allowed(ingress, "/v1/" + route, method, "http://ai-service:8000"):
            raise ValueError(f"Missing ingress route: {method} /v1/{route}")
    for method, route in [
        ("POST", "shopper"),
        ("GET", "cart"),
        ("GET", "delivery"),
        ("GET", "orders/" + uid),
        ("POST", "support/tickets"),
        ("GET", "baskets/" + uid),
        ("POST", "baskets/" + uid),
    ]:
        if not route_allowed(
            tools, "/v1/assistant-tools/" + route, method, "http://api-gateway:8080"
        ):
            raise ValueError(f"Missing tool route: {method} {route}")


def generated_checks(root, preserved_app=None):
    # Run existing generators in a disposable minimal tree, never over the checkout.
    with tempfile.TemporaryDirectory(prefix="rocento-contracts-") as temporary:
        scratch = Path(temporary)
        shutil.copytree(
            root / "commerce-api/rocento-api/crates/api-gateway/openapi",
            scratch / "commerce-api/rocento-api/crates/api-gateway/openapi",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        # The gateway generator also reads the versioned mobile contract.
        for relative in ("contracts", "commerce-api/rocento-api/crates/domain-mobile/contract"):
            if (root / relative).is_dir():
                shutil.copytree(root / relative, scratch / relative)
        shutil.copyfile(
            root / "commerce-api/theme-contract.json",
            scratch / "commerce-api/theme-contract.json",
        )
        for directory in (
            "commerce-ops/scripts",
            "commerce-assistant-platform/app",
            "commerce-web/packages/api-client/src",
        ):
            (scratch / directory).mkdir(parents=True, exist_ok=True)
        for name in (
            "generate_openapi.py",
            "generate_assistant_models.py",
            "generate_assistant_validator.py",
        ):
            shutil.copyfile(root / "commerce-ops/scripts" / name, scratch / "commerce-ops/scripts" / name)
            # Compatibility entry points load their canonical implementations.
            owner = Path("commerce-ops/scripts/contracts") / name
            (scratch / owner).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / owner, scratch / owner)
            try:
                subprocess.run(
                    [sys.executable, str(scratch / "commerce-ops/scripts" / name)],
                    check=True,
                    capture_output=True,
                )
            except subprocess.CalledProcessError as error:
                raise ValueError(
                    f"Contract generator {name} failed (exit {error.returncode}); run commerce-ops/scripts/{name} locally for diagnostics"
                ) from None
        if json.loads((root / "commerce-api/rocento-api/openapi.json").read_text()) != json.loads(
            (scratch / "commerce-api/rocento-api/openapi.json").read_text()
        ):
            raise ValueError("OpenAPI is stale; regenerate before release")
        path = Path("commerce-assistant-platform/app/commerce_action_engine/contracts/__init__.py")
        if preserved_app:
            installed_contract_checks(scratch, preserved_app, allow_additions=True)
        elif ast.dump(ast.parse((root / path).read_text())) != ast.dump(
            ast.parse((scratch / path).read_text())
        ):
            raise ValueError("Python assistant contract is stale")
        path = Path("commerce-web/packages/api-client/src/assistant-schemas.ts")
        if (root / path).read_bytes() != (scratch / path).read_bytes():
            raise ValueError("Frontend assistant validator is stale")


def installed_checks(root, installed_app):
    # The Node engine is built separately; it is excluded from the Python image.
    separately_built = Path("commerce_language_engine")
    for source in (root / "commerce-assistant-platform/app").rglob("*.py"):
        relative = source.relative_to(root / "commerce-assistant-platform/app")
        if relative.parts[: len(separately_built.parts)] == separately_built.parts:
            continue
        installed = installed_app / relative
        if not installed.is_file() or installed.read_bytes() != source.read_bytes():
            raise ValueError("Assistant image does not match the release source")
    # Docker COPY knowledge must also deliver the reviewed files. This verifies
    # packaging only; indexing still requires an explicit reviewed operator import.
    for source in (root / "commerce-assistant-platform/knowledge").rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(root / "commerce-assistant-platform/knowledge")
        installed = installed_app.parent / "knowledge" / relative
        if not installed.is_file() or installed.read_bytes() != source.read_bytes():
            raise ValueError(
                "Assistant image knowledge does not match the release source"
            )


def installed_contract_checks(root, installed_app, allow_additions=False):
    relative = Path('commerce_action_engine/contracts/__init__.py')
    source = root / 'commerce-assistant-platform/app' / relative
    installed = installed_app / relative
    if not installed.is_file():
        raise ValueError('The preserved AI image has incompatible gateway contracts; deploy a reviewed matching AI release')
    expected = ast.parse(source.read_text())
    actual = ast.parse(installed.read_text())
    if allow_additions:
        # New response types do not change the existing AI wire contract. Every
        # installed definition, import and rebuild call must still match exactly.
        existing = {node.name for node in actual.body if isinstance(node, ast.ClassDef)}
        added = {node.name for node in expected.body if isinstance(node, ast.ClassDef)} - existing
        def added_model(node):
            if isinstance(node, ast.ClassDef):
                return node.name in added
            return (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and isinstance(node.value.func.value, ast.Name)
                    and node.value.func.value.id in added
                    and node.value.func.attr == 'model_rebuild')
        expected.body = [node for node in expected.body if not added_model(node)]
    if ast.dump(actual) != ast.dump(expected):
        raise ValueError('The preserved AI image has incompatible gateway contracts; deploy a reviewed matching AI release')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-app", type=Path)
    parser.add_argument("--installed-contracts-only", type=Path)
    parser.add_argument("--mounted-tools", type=Path)
    parser.add_argument("--mounted-ingress", type=Path)
    args = parser.parse_args()
    if args.installed_app:
        installed_checks(ROOT, args.installed_app)
    proxy_checks(ROOT)
    generated_checks(ROOT, args.installed_contracts_only)
    import_root = args.installed_contracts_only.parent if args.installed_contracts_only else ROOT / "commerce-assistant-platform"
    sys.path.insert(0, str(import_root))
    from app.commerce_action_engine.application.baseline import tool_revision

    revision = tool_revision()
    if not (ROOT / "commerce-api/rocento-api/migrations/20260921200000_customer_journey.sql").is_file():
        raise ValueError("Customer journey migration is missing")
    if bool(args.mounted_tools) != bool(args.mounted_ingress):
        raise ValueError("Supply both mounted configuration copies")
    for mounted, expected in [
        (args.mounted_tools, "tools.conf"),
        (args.mounted_ingress, "ingress.conf"),
    ]:
        if (
            mounted
            and mounted.read_bytes()
            != (ROOT / "commerce-ops/deploy/assistant" / expected).read_bytes()
        ):
            raise ValueError(f"Stale mounted proxy configuration: {expected}")
    print(
        json.dumps(
            {
                "status": "pass",
                "tool_schema_revision": revision,
                "generated_contracts": "pass",
                "proxy_routes": "pass",
                "mounted_proxies": "pass" if args.mounted_tools else "not_checked",
                "migration_source_sha256": hashlib.sha256(
                    (
                        ROOT / "commerce-api/rocento-api/migrations/20260921200000_customer_journey.sql"
                    ).read_bytes()
                ).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(
            f"M01 preflight failed: {error}"
            if isinstance(error, ValueError)
            else "M01 preflight could not inspect required release files"
        ) from None
