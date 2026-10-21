"""Evaluate production M07 adapters using only disposable loopback DB/search services."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import json
import os
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
out = ROOT / "artifacts/evaluation-lab/m07-discovery"
out.mkdir(parents=True, exist_ok=True)
names = []


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw)


try:
    ports = []
    for image, port, env in [
        ("pgvector/pgvector:pg16", 5432, ["POSTGRES_PASSWORD=eval-test-only"]),
        (
            "getmeili/meilisearch:v1.15",
            7700,
            [
                "MEILI_MASTER_KEY=m07-disposable-key-only",
                "MEILI_ENV=development",
                "MEILI_NO_ANALYTICS=true",
            ],
        ),
    ]:
        name = "m07-discovery-" + uuid.uuid4().hex[:10]
        names.append(name)
        args = ["docker", "run", "-d", "--name", name, "-p", f"127.0.0.1::{port}"]
        for e in env:
            args += ["-e", e]
        run(args + [image])
        ports.append(
            run(["docker", "port", name, str(port)]).stdout.strip().rsplit(":", 1)[1]
        )
    import urllib.request

    for _ in range(60):
        try:
            if (
                run(
                    ["docker", "exec", names[0], "pg_isready", "-U", "postgres"]
                ).returncode
                == 0
                and urllib.request.urlopen(
                    f"http://127.0.0.1:{ports[1]}/health", timeout=2
                ).status
                == 200
            ):
                break
        except (subprocess.CalledProcessError, OSError):
            time.sleep(0.5)
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"postgres://postgres:eval-test-only@127.0.0.1:{ports[0]}/postgres",
        M07_MEILI_URL=f"http://127.0.0.1:{ports[1]}",
        M07_EVAL_REPORT=str(out / "report.json"),
    )
    result = subprocess.run(
        [
            "cargo",
            "test",
            "-p",
            "api-gateway",
            "--test",
            "discovery_relevance",
            "--offline",
            "--locked",
            "--",
            "--nocapture",
        ],
        cwd=ROOT / "commerce-api",
        env=env,
        text=True,
        capture_output=True,
        timeout=600,
        check=False,
    )
    (out / "runner.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        print((result.stdout + result.stderr)[-6000:])
        raise SystemExit(result.returncode)
    report = json.loads((out / "report.json").read_text())
    print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2))
finally:
    for name in names:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
