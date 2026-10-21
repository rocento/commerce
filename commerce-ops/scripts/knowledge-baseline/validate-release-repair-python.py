"""Validate the frozen release using disposable local databases and Node HTTP.

No developer or production database is contacted. Credentials remain in process
environment/memory and are redacted from subprocess output before it is saved.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from uuid import uuid4

import psycopg
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parents[3]
WORKSPACE = ROOT
PYTHON = ROOT / "commerce-assistant-platform/.venv/bin/python"
DEPLOYMENT_TESTS = [
    "test_ai_architecture.py",
    "test_ai_deployment.py",
    "test_ai_database_migration.py",
    "test_ec2_deployment.py",
    "test_ec2_deploy_job.py",
    "test_deploy_cleanup.py",
    "test_deploy_transport.py",
    "test_publication_deployment.py",
    "test_backend_image_cleanup.py",
    "test_capacity_migration_history.py",
    "test_migration_preflight.py",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_manifest():
    files = set()
    for area in ["commerce-assistant-platform/app", "commerce-assistant-platform/tests", "scripts/tests"]:
        files.update((ROOT / area).rglob("*.py"))
    files.update((ROOT / "commerce-assistant-platform/tests/fixtures").rglob("*.json"))
    files.update((ROOT / "commerce-assistant-platform/tests/fixtures").rglob("*.jsonl"))
    files.update((ROOT / "commerce-assistant-platform/migrations").glob("*.sql"))
    files.update((ROOT / "commerce-ops/deploy/assistant").glob("*.sql"))
    files.update((ROOT / "commerce-ops/scripts").glob("*.sh"))
    for name in [
        "commerce-api/rocento-api/openapi.json", "commerce-assistant-platform/pyproject.toml",
        "scripts/check-ai-architecture.py", "scripts/generate_ai_capabilities.py",
        "commerce-assistant-platform/docs/capabilities.json", "commerce-ops/compose/compose.ai-shared.yaml",
        "scripts/knowledge-baseline/validate-release-repair-python.py",
    ]:
        path = ROOT / name
        if path.exists():
            files.add(path)
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(files)}


def runtime_hash(engine):
    script = "import {runtimeSha256} from './src/runtime-identity.ts'; console.log(await runtimeSha256());"
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script], cwd=engine, text=True
    ).strip()


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--candidate-boundaries-only", action="store_true")
    args = parser.parse_args()
    engine, out = args.engine.resolve(), args.out.resolve()
    if args.source_root:
        ROOT = args.source_root.resolve()
        if not ROOT.is_relative_to(WORKSPACE / "output"):
            raise SystemExit("Isolated source fixture must be inside workspace output")
    if not engine.is_relative_to(WORKSPACE / "output") or not out.is_relative_to(WORKSPACE / "output"):
        raise SystemExit("Frozen engine and evidence must be under this workspace output directory")
    out.mkdir(parents=True, exist_ok=False)
    started = datetime.now(timezone.utc).isoformat()
    before = source_manifest()
    (out / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
    engine_before = runtime_hash(engine)
    artifact_hash = digest(engine / "data/compiled.json")
    artifact = json.loads((engine / "data/compiled.json").read_text())
    # Python boundary tests import the workspace Node source directly. Bind
    # those imports to the same runtime as the frozen HTTP server and artifact.
    live_engine = ROOT / "commerce-assistant-platform/app/commerce_language_engine"
    if runtime_hash(live_engine) != engine_before:
        raise SystemExit("Direct Node boundary source differs from frozen runtime")
    if args.candidate_boundaries_only:
        # Earlier full-suite evidence used ordinary packaged fixtures for these
        # direct Node calls. Repeat the affected boundary files with the exact
        # candidate dictionary, without changing those fixtures or assertions.
        paths = sorted(path for path in (ROOT / "commerce-assistant-platform/tests").glob("test_*.py") if "loadRuntime" in path.read_text())
        environment = {**os.environ, "CLE_DEPLOY_DATA_DIR": str(engine / "data")}
        with (out / "candidate-node-boundaries.log").open("x") as log:
            process = subprocess.run([str(PYTHON), "-m", "pytest", "-q", "-rs", *[str(path.relative_to(ROOT / "commerce-assistant-platform")) for path in paths]], cwd=ROOT / "commerce-assistant-platform", env=environment, stdout=log, stderr=subprocess.STDOUT, check=False)
        after = source_manifest()
        changed = [path for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]
        result = {"startedAt": started, "completedAt": datetime.now(timezone.utc).isoformat(), "productionChanged": False, "frozenRuntimeSha256": engine_before, "workingRuntimeMatchesFrozen": runtime_hash(live_engine) == engine_before, "dictionarySha256": artifact_hash, "generationFingerprint": artifact["generationFingerprint"], "sourceUnchanged": not changed, "changedSourceFiles": changed, "files": [str(path.relative_to(ROOT)) for path in paths], "exitCode": process.returncode, "logSha256": digest(out / "candidate-node-boundaries.log")}
        content = (out / "candidate-node-boundaries.log").read_text()
        for label in ["passed", "failed", "errors", "skipped", "warnings"]:
            values = re.findall(r"\b(\d+) " + label + r"\b", content)
            if values:
                result[label + "Count"] = int(values[-1])
        result["passed"] = process.returncode == 0 and not changed and result["workingRuntimeMatchesFrozen"]
        (out / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
        (out / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)
        return 0 if result["passed"] else 1
    node_modules = engine / "node_modules"
    if not node_modules.exists():
        node_modules.symlink_to(ROOT / "commerce-assistant-platform/app/commerce_language_engine/node_modules", target_is_directory=True)
    container = "rocento-ai-merge-test-release-repair-" + uuid4().hex[:12]
    # Existing real-DB tests share this documented disposable role password;
    # several create the role only when absent and others explicitly reset it.
    # Keep completion and M04/M09 fixtures consistent inside this owned container.
    password, runtime_password = secrets.token_urlsafe(36), "runtime-test-only"
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "commerce-assistant-platform"), "POSTGRES_PASSWORD": password, "POSTGRES_USER": "ai_owner", "POSTGRES_DB": "assistant"}
    results, server, cleanup_code = [], None, None

    def sanitize(value):
        return value.replace(password, "<disposable-secret>").replace(runtime_password, "<disposable-secret>")

    def run_logged(name, arguments, *, cwd=None, env=environment):
        began = time.monotonic()
        with (out / f"{name}.log").open("x") as log:
            process = subprocess.Popen(arguments, cwd=cwd or ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            assert process.stdout is not None
            for line in process.stdout:
                log.write(sanitize(line))
                log.flush()
            code = process.wait()
        content = (out / f"{name}.log").read_text()
        result = {"name": name, "exitCode": code, "durationSeconds": round(time.monotonic() - began, 3), "logSha256": digest(out / f"{name}.log")}
        for label in ["passed", "failed", "errors", "skipped", "warnings"]:
            matches = re.findall(r"\b(\d+) " + label + r"\b", content)
            if matches:
                result[label] = int(matches[-1])
        subtests = re.findall(r"\b(\d+) subtests passed\b", content)
        if subtests:
            result["subtestsPassed"] = int(subtests[-1])
        result["skipReasons"] = re.findall(r"^SKIPPED .*", content, re.MULTILINE)
        results.append(result)
        print(f"{name}: exit {code}", flush=True)
        return code

    error = None
    readiness = None
    try:
        run_logged("architecture", [str(PYTHON), "scripts/check-ai-architecture.py"])
        run_logged("capabilities", [str(PYTHON), "scripts/generate_ai_capabilities.py", "--check"])
        run_logged("deployment-guards", [str(PYTHON), "-m", "pytest", "-q", "-rs", *["scripts/tests/" + name for name in DEPLOYMENT_TESTS]])
        subprocess.run(["docker", "run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_USER", "-e", "POSTGRES_DB", "-p", "127.0.0.1::5432", "pgvector/pgvector:pg16"], env=environment, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(60):
            if subprocess.run(["docker", "exec", container, "pg_isready", "-U", "ai_owner"], capture_output=True, check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Disposable PostgreSQL did not become ready")
        port = subprocess.check_output(["docker", "port", container, "5432"], text=True).strip()
        if not re.fullmatch(r"127\.0\.0\.1:\d+", port):
            raise RuntimeError("Disposable PostgreSQL must bind only loopback")
        base = {"host": "127.0.0.1", "port": port.rsplit(":", 1)[1], "user": "ai_owner", "password": password}
        admin_dsn = make_conninfo(**base, dbname="postgres")
        shared_env = {**environment, "SHARED_AI_TEST_CONTAINER": container}
        if run_logged("shared-database-isolation", [str(PYTHON), "-m", "pytest", "-q", "-rs", "scripts/tests/test_shared_ai_database.py"], env=shared_env):
            raise RuntimeError("Disposable database isolation suite failed")
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute("CREATE DATABASE release_completion")
            connection.execute("ALTER ROLE ai_runtime LOGIN PASSWORD '" + runtime_password + "'")
        completion_admin = make_conninfo(**base, dbname="release_completion")
        with psycopg.connect(completion_admin, autocommit=True) as connection:
            for migration in sorted((ROOT / "commerce-assistant-platform/migrations").glob("*.sql")):
                connection.execute(migration.read_text().replace(":'tenant_id'", "'00000000-0000-0000-0000-000000000001'"))
        server_log_path = out / "cle-http-server.log"
        with server_log_path.open("x") as server_log:
            server = subprocess.Popen(["node", "src/server.ts"], cwd=engine, env={**os.environ, "PORT": "0", "HOST": "127.0.0.1", "CLE_DEPLOY_DATA_DIR": str(engine / "data"), "DATABASE_URL": admin_dsn, "ENABLE_DURABLE_SESSIONS": "false"}, stdout=server_log, stderr=subprocess.STDOUT)
            for _ in range(150):
                match = re.search(r"Commerce inspector: (http://127\.0\.0\.1:\d+)", server_log_path.read_text())
                if match:
                    language_url = match.group(1)
                    break
                if server.poll() is not None:
                    raise RuntimeError("Frozen Node resolver failed; inspect redacted server log")
                time.sleep(0.1)
            else:
                raise RuntimeError("Frozen Node resolver did not become ready")
            with urlopen(language_url + "/api/ready", timeout=10) as response:
                readiness = json.load(response)
            if readiness.get("generationFingerprint") != artifact["generationFingerprint"] or readiness.get("provenance", {}).get("runtimeVersion") != engine_before:
                raise RuntimeError("HTTP server identity differs from frozen candidate")
            (out / "node-readiness.json").write_text(json.dumps(readiness, indent=2) + "\n")
            tests_env = {**os.environ, "PYTHONPATH": str(ROOT / "commerce-assistant-platform"), "CLE_DEPLOY_DATA_DIR": str(engine / "data"), "M04_TEST_DATABASE_URL": admin_dsn, "M09_TEST_DATABASE_URL": admin_dsn, "PHASE3_TEST_DATABASE_URL": admin_dsn, "M05_TEST_LANGUAGE_URL": language_url, "COMPLETION_TEST_ADMIN_DSN": completion_admin, "COMPLETION_TEST_DSN": make_conninfo(**{**base, "user": "ai_runtime", "password": runtime_password}, dbname="release_completion")}
            run_logged("python-full-postgres-http", [str(PYTHON), "-m", "pytest", "-q", "-ra", "tests"], cwd=ROOT / "commerce-assistant-platform", env=tests_env)
    except (OSError, RuntimeError, subprocess.SubprocessError, psycopg.Error, ValueError) as exc:
        error = {"type": type(exc).__name__, "message": sanitize(str(exc))}
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        cleanup_code = subprocess.run(["docker", "rm", "-f", container], capture_output=True, check=False).returncode
        server_log_path = out / "cle-http-server.log"
        if server_log_path.exists():
            server_log_path.write_text(sanitize(server_log_path.read_text()))
        after = source_manifest()
        (out / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
        changed = [path for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]
        engine_after = runtime_hash(engine)
        working_runtime_matches = runtime_hash(live_engine) == engine_before
        artifact_unchanged = digest(engine / "data/compiled.json") == artifact_hash
        summary = {"startedAt": started, "completedAt": datetime.now(timezone.utc).isoformat(), "productionChanged": False, "frozenRuntimeSha256": engine_before, "frozenRuntimeUnchanged": engine_after == engine_before, "workingRuntimeMatchesFrozen": working_runtime_matches, "dictionarySha256": artifact_hash, "dictionaryUnchanged": artifact_unchanged, "generationFingerprint": artifact["generationFingerprint"], "sourceFiles": len(before), "sourceUnchanged": not changed, "changedSourceFiles": changed, "checks": results, "databaseFixturesEnabled": True, "localNodeHttpEnabled": readiness is not None, "disposableContainerRemoved": cleanup_code == 0, "error": error}
        summary["passed"] = not error and not changed and engine_before == engine_after and working_runtime_matches and artifact_unchanged and cleanup_code == 0 and len(results) == 5 and all(row["exitCode"] == 0 for row in results)
        (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary), flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
