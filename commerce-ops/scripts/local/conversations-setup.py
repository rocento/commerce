"""Operator-only additive AI history migration; never invoked by a chat request."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument(
    "--container", required=True, help="Explicit AI PostgreSQL container to migrate"
)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3] / "commerce-assistant-platform/migrations"
sql = "\n".join(
    (root / name).read_text()
    for name in (
        "004_conversations.sql",
        "005_performance_indexes.sql",
        "006_request_revisions.sql",
        "007_compound_plans.sql",
        "008_assistant_tracking.sql",
        "009_shopping_clarifications.sql",
        "010_retire_reserved_documents.sql",
        "011_domain_evidence.sql",
        "012_account_deletion.sql",
    )
)
shared = (
    subprocess.check_output(
        [
            "docker",
            "exec",
            args.container,
            "psql",
            "-X",
            "-U",
            "ai_owner",
            "-d",
            "assistant",
            "-Atqc",
            "SELECT to_regclass('assistant.tenant_logins') IS NOT NULL",
        ],
        text=True,
    ).strip()
    == "t"
)
if shared:
    sql += "\n" + (root.parents[1] / "commerce-ops/deploy/assistant/shared-tenants.sql").read_text()
subprocess.run(
    [
        "docker",
        "exec",
        "-i",
        args.container,
        "psql",
        "-X",
        "--single-transaction",
        "-U",
        "ai_owner",
        "-d",
        "assistant",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "-",
    ],
    input=sql,
    text=True,
    check=True,
)
