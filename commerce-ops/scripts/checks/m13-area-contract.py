"""Exercise the M13 migration against a minimal, disposable PostgreSQL fixture."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[3]
database = "m13_contract_" + uuid.uuid4().hex
base = ["docker", "compose", "-f", str(ROOT / "commerce-ops/compose/compose.yaml"), "exec", "-T", "postgres", "sh", "-c"]


def run(command: str, sql: str = "") -> None:
    subprocess.run(base + [command], input=sql, text=True, cwd=ROOT, check=True)


run(f'createdb -U "$POSTGRES_USER" {database}')
try:
    fixture = """
CREATE SCHEMA inventory;
CREATE SCHEMA customers;
CREATE TABLE inventory.stocks(id uuid PRIMARY KEY);
INSERT INTO inventory.stocks VALUES('00000000-0000-0000-0000-000000000001');
CREATE TABLE customers.customer_locations(
 id uuid PRIMARY KEY, latitude double precision, longitude double precision, area_id uuid
);
"""
    migration = ROOT / "commerce-api/rocento-api/migrations/20260914130000_delivery_areas.sql"
    checks = ROOT / "commerce-ops/scripts/checks/m13-area-contract.sql"
    run(
        f'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d {database}',
        fixture + migration.read_text() + checks.read_text(),
    )
    print("M13 delivery-area database contract passed")
finally:
    run(f'dropdb -U "$POSTGRES_USER" {database}')
