"""Exercise the M13 migration against a minimal, disposable PostgreSQL fixture."""

from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[3]
database = "m13_contract_" + uuid.uuid4().hex
base = ["docker", "compose", "--project-directory", str(ROOT / "commerce-ops/compose"), "-f", str(ROOT / "commerce-ops/compose/base/compose.yaml"), "exec", "-T", "postgres", "sh", "-c"]


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
    checks = ROOT / "commerce-ops/tools/checks/delivery-area-schema-check.sql"
    run(
        f'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d {database}',
        fixture + migration.read_text() + checks.read_text(),
    )
    print("M13 delivery-area database contract passed")
finally:
    run(f'dropdb -U "$POSTGRES_USER" {database}')
