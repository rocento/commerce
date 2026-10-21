"""Verify default attribute provisioning in disposable PostgreSQL (requires Docker)."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
import subprocess
import time
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[3]
name = 'commerce-default-attributes-' + uuid.uuid4().hex[:8]
migration = root / 'commerce-api/rocento-api/migrations/20260928130000_default_attribute_set.sql'


def sql(body):
    result = subprocess.run(
        ['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
        input=body, text=True, capture_output=True, check=True,
    )
    return result.stdout.strip()


def apply():
    sql('BEGIN;\n' + migration.read_text() + '\nCOMMIT;')


def snapshot():
    return sql("SELECT jsonb_build_object('definitions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM attributes.definitions d),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY definition_id) FROM attributes.set_members m),'sets',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM attributes.sets s),'configuration',(SELECT to_jsonb(c) FROM attributes.catalog_configuration c));")


try:
    subprocess.run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=disposable-test', 'postgres:16-bookworm'], check=True, capture_output=True)
    for _ in range(60):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'], capture_output=True).returncode == 0:
            break
        time.sleep(0.5)
    for path in sorted((root / 'commerce-api/rocento-api/migrations').glob('*.sql')):
        if path.name < migration.name:
            sql('BEGIN;\n' + path.read_text() + '\nCOMMIT;')
    # Upgrade with merchant definitions, a populated Default group and another chosen default.
    sql("""
INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type)
VALUES('00000000-0000-0000-0000-000000000991','product','manufacturer','Custom maker','text');
INSERT INTO attributes.sets(id,name) VALUES('00000000-0000-0000-0000-000000000992','Default'),('00000000-0000-0000-0000-000000000993','Merchant default');
INSERT INTO attributes.set_members VALUES('00000000-0000-0000-0000-000000000992','00000000-0000-0000-0000-000000000991','General',20);
UPDATE attributes.catalog_configuration SET default_attribute_set_id='00000000-0000-0000-0000-000000000993';
""")
    apply()
    assert sql("SELECT label FROM attributes.definitions WHERE attribute_code='manufacturer'") == 'Custom maker'
    assert sql("SELECT default_attribute_set_id FROM attributes.catalog_configuration") == '00000000-0000-0000-0000-000000000993'
    assert sql("SELECT count(*) FROM attributes.set_members m JOIN attributes.sets s ON s.id=m.set_id WHERE s.name='Default'") == '7'
    assert sql("SELECT position FROM attributes.set_members WHERE definition_id='00000000-0000-0000-0000-000000000991'") == '20'
    before = snapshot()
    apply()
    assert snapshot() == before, 'Repeated provisioning changed merchant configuration'
    # Fresh attribute setup using the actual migrated schema.
    sql("UPDATE attributes.catalog_configuration SET default_attribute_set_id=NULL; DELETE FROM attributes.set_members; DELETE FROM attributes.sets; DELETE FROM attributes.definitions;")
    apply()
    assert sql("SELECT s.name FROM attributes.catalog_configuration c JOIN attributes.sets s ON s.id=c.default_attribute_set_id") == 'Default'
    assert sql("SELECT count(*) FROM attributes.set_members") == '7'
    assert sql("SELECT count(*) FROM attributes.definitions WHERE is_required OR used_for_configurations") == '0'
    assert sql("SELECT metadata->>'unit' FROM attributes.definitions WHERE attribute_code='weight'") == 'kg'
    assert sql("SELECT count(*) FROM attributes.definitions WHERE attribute_code LIKE 'meta_%' AND is_visible_on_front") == '0'
    before = snapshot()
    apply()
    assert snapshot() == before
    print(json.dumps({'fresh_default': 'pass', 'seven_grouped_attributes': 'pass', 'merchant_settings_preserved': 'pass', 'repeat_safe': 'pass', 'full_migration_chain': 'pass'}))
finally:
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
