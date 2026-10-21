"""Version M01 source/build evidence without reading secrets or customer records.

The manifest never treats an untested store as accepted. --evidence contains
explicit per-store deployment and test observations, not provider credentials.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STORES = ("grocery", "jewelry", "electronics")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_manifest():
    roots = ["commerce-api/crates", "commerce-api/rocento-api/migrations", "commerce-assistant-platform/app", "commerce-assistant-platform/knowledge", "commerce-web/apps/admin/src", "commerce-web/apps/storefront/src", "commerce-web/apps/storefront/server", "commerce-web/packages", "deploy/assistant"]
    suffixes = {".rs", ".py", ".tsx", ".ts", ".css", ".json", ".toml", ".sql", ".conf", ".mjs"}
    files = {}
    for directory in roots:
        for path in sorted((ROOT / directory).rglob("*")):
            if path.is_file() and path.suffix in suffixes and not {"node_modules", "__pycache__", "dist", "target"}.intersection(path.parts):
                files[str(path.relative_to(ROOT))] = sha(path)
    for name in ["commerce-api/rocento-api/Cargo.lock", "commerce-api/rocento-api/Cargo.toml", "commerce-api/rocento-api/openapi.json", "commerce-api/rocento-api/Dockerfile", "commerce-assistant-platform/requirements.lock", "commerce-assistant-platform/Dockerfile", "commerce-web/pnpm-lock.yaml", "commerce-web/package.json", "commerce-ops/compose/compose.assistant.yaml", "commerce-ops/compose/compose.assistant-admin.yaml", "commerce-ops/deploy/ec2/assistant.yaml"]:
        files[name] = sha(ROOT / name)
    return {"sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(), "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    evidence = json.loads(args.evidence.read_text()) if args.evidence else {}
    if set(evidence) - set(STORES):
        raise SystemExit("Unknown store in evidence")
    stores = {}
    tenants = {}
    for name in STORES:
        record = evidence.get(name, {"status": "fail", "reason": "No deployment or acceptance evidence supplied", "accepted_at": None})
        if record.get("status") not in {"pass", "fail", "not_configured"}:
            raise SystemExit("Every store requires an explicit pass/fail/not_configured status")
        # Acceptance cannot be copied to another store/tenant.
        tenant = record.get("tenant_id")
        if tenant:
            if tenant in tenants:
                previous = tenants[tenant]
                if record["status"] == "pass" or stores[previous]["status"] == "pass":
                    raise SystemExit("Accepted stores must have distinct tenants")
                record["tenant_identity_conflict_with"] = previous
                stores[previous]["tenant_identity_conflict_with"] = name
            else:
                tenants[tenant] = name
        if record["status"] == "pass" and not all(record.get(k) for k in ("tenant_id", "accepted_at", "artifact_revisions", "migrations", "acceptance")):
            raise SystemExit("A pass requires identified artifacts, migrations, tenant and acceptance evidence")
        stores[name] = record
    result = {
        "schema_version": "1", "milestone": "M01", "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source": source_manifest(), "stores": stores,
        "performance_flags_default": {"catalog_cache": False, "catalog_singleflight": False, "small_model": False},
        "acceptance_note": "Status is limited to each recorded environment. A source hash or provider connection alone is not complete milestone acceptance.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print("Wrote M01 manifest with independent records for Grocery, Jewelry and Electronics.")


if __name__ == "__main__":
    main()
