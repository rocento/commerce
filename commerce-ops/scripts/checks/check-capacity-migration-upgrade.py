"""Rehearse the deployed capacity schema upgrade in disposable local PostgreSQL.

Run: python3 commerce-ops/scripts/check-capacity-migration-upgrade.py
Requires local Docker and the postgres:16-bookworm image. Creates and removes
only its randomly named test container; never reads store configuration/data.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import subprocess,time,uuid,json
from pathlib import Path
root=Path(__file__).resolve().parents[3]
name='rocento-capacity-upgrade-'+uuid.uuid4().hex[:8]
def sql(body,db='postgres'):
    p=subprocess.run(['docker','exec','-i',name,'psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],input=body,text=True,capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr)
    return p.stdout.strip()
try:
    subprocess.run(['docker','run','-d','--name',name,'-e','POSTGRES_PASSWORD=disposable-migration-test','postgres:16-bookworm'],check=True,capture_output=True)
    for _ in range(40):
        if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],capture_output=True).returncode==0:break
        time.sleep(.5)
    migrations=sorted((root/'commerce-api/rocento-api/migrations').glob('*.sql'))
    original='20260922120000_fulfillment_capacity.sql'
    extension='20260922121000_fulfillment_capacity_extensions.sql'
    for p in migrations:
        if p.name<=original:sql(p.read_text())
    sql('''
INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES('00000000-0000-0000-0000-000000000011','upgrade@example.test','email','unused');
INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address) VALUES('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000011','home',30,31,'Test');
INSERT INTO cart_checkout.carts(id,customer_id) VALUES('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000011');
INSERT INTO fulfillment.schedules(id,source_id,method,timezone,config) VALUES('00000000-0000-0000-0000-000000000014','00000000-0000-0000-0000-000000000001','scheduled_delivery','Africa/Cairo','{}');
INSERT INTO fulfillment.capacity_reservations(id,customer_id,cart_id,location_id,schedule_id,source_id,method,starts_at,ends_at,fingerprint,requirement,status,expires_at,idempotency_key,release_before)
VALUES('00000000-0000-0000-0000-000000000015','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000014','00000000-0000-0000-0000-000000000001','scheduled_delivery',now(),now()+interval '1 hour','{}','{}','HELD',now()+interval '1 hour',gen_random_uuid(),'never');
''')
    before=sql('SELECT to_jsonb(r)::text FROM fulfillment.capacity_reservations r;')
    sql('BEGIN;'+(root/'commerce-api/rocento-api/migrations'/extension).read_text()+'COMMIT;')
    after=sql("SELECT (to_jsonb(r)-'timezone')::text FROM fulfillment.capacity_reservations r;")
    assert before==after,'Existing reservation facts changed'
    assert sql('SELECT timezone FROM fulfillment.capacity_reservations;')=='Africa/Cairo'
    assert sql('SELECT enabled FROM fulfillment.capacity_settings;')=='f'
    assert sql("SELECT count(*) FROM pg_indexes WHERE schemaname='fulfillment' AND indexname IN ('capacity_override_lookup','capacity_active_time','capacity_active_range');")=='3'
    sql("DELETE FROM customers.customer_locations WHERE id='00000000-0000-0000-0000-000000000012';")
    assert sql('SELECT count(*) FROM fulfillment.capacity_reservations;')=='1'
    for p in migrations:
        if p.name>extension:sql('BEGIN;'+p.read_text()+'COMMIT;')
    assert sql('SELECT count(*) FROM fulfillment.capacity_reservations;')=='1'
    sql('CREATE DATABASE fresh;')
    for p in migrations:sql('BEGIN;'+p.read_text()+'COMMIT;',db='fresh')
    columns="SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='fulfillment' ORDER BY 1,2;"
    assert sql(columns)==sql(columns,db='fresh')
    print(json.dumps({'upgrade_from_deployed_schema':'pass','existing_reservation_preserved':'pass','timezone_backfill':'Africa/Cairo','capacity_default_off':'pass','historical_location_retained':'pass','new_indexes':3,'remaining_migrations':'pass','fresh_install':'pass','fresh_upgrade_columns_match':'pass','migration_count':len(migrations)}))
finally:
    subprocess.run(['docker','rm','-f',name],capture_output=True)
