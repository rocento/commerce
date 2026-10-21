"""Verify the best-seller demo seed in disposable PostgreSQL (requires Docker)."""

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
name = 'commerce-bestseller-seed-' + uuid.uuid4().hex[:8]


def sql(body):
    result = subprocess.run(
        ['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
        input=body, text=True, capture_output=True, check=True,
    )
    return result.stdout.strip()


try:
    subprocess.run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=disposable-test', 'postgres:16-bookworm'], check=True, capture_output=True)
    for _ in range(60):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'], capture_output=True).returncode == 0:
            break
        time.sleep(0.5)
    for path in sorted((root / 'commerce-api/rocento-api/migrations').glob('*.sql')):
        sql('BEGIN;\n' + path.read_text() + '\nCOMMIT;')
    sql("INSERT INTO catalog.categories(id,name,slug) VALUES(md5('test-category')::uuid,'Demo','demo'); INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,in_stock) SELECT md5('test-product-'||g)::uuid,'TEST-'||g,'test-'||g,'Demo '||g,'Test',10,'USD','each',md5('test-category')::uuid,true,true FROM generate_series(1,8) g;")
    fixture = (root / 'commerce-assets/demo/seed-bestsellers.sql').read_text()
    sql(fixture)
    assert sql("SELECT count(*) FROM orders.orders") == '8'
    assert sql("SELECT sum(quantity) FROM orders.order_items") == '180'
    assert sql("SELECT count(*) FROM orders.orders WHERE status='delivered' AND created_at >= (date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 month') AT TIME ZONE 'UTC' AND created_at < date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'") == '8'
    sql(fixture)
    assert sql("SELECT count(*) FROM orders.orders") == '8'
    assert sql("SELECT sum(quantity) FROM orders.order_items") == '180'
    print('PASS: 8 completed orders, 180 units, previous UTC month; repeat creates no duplicates')
finally:
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
