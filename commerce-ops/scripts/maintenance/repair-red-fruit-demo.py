"""Backfill explicit demo apple facts; preserve the current navigation category and other fields."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from datetime import datetime, timezone
from catalog_support import Client, ROOT

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
client = Client()
try:
    found = []
    offset = 0
    while True:
        rows = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
        found.extend(p for p in rows if p['sku'] == 'DEMO-APL-001')
        if len(rows) < 50:
            break
        offset += 50
    if len(found) != 1:
        raise SystemExit('Expected exactly one demo apple SKU; no changes made.')
    p = client.call('GET', f'/v1/admin/catalog/products/{found[0]["id"]}')
    if p['name'] != 'Red Apples' or 'red apples for fruit bowls' not in p['description'].lower():
        raise SystemExit('Demo facts have changed; review the product before adding classification.')
    facts = {'color': 'red', 'product-kind': 'fruit'}
    if any(k in p['attributes'] and p['attributes'][k] != v for k, v in facts.items()):
        raise SystemExit('Conflicting explicit product facts; no changes made.')
    print('Backfill demo Red Apples with color=red and product-kind=fruit from its authored description.')
    if args.apply:
        backup = ROOT / '.local' / ('red-fruit-before-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json')
        backup.write_text(json.dumps(p, indent=2))
        definitions = {d['code']: d for d in client.call('GET', '/v1/admin/catalog/attributes')}
        for code, name in [('color', 'Color'), ('product-kind', 'Product kind')]:
            if code not in definitions:
                client.call('POST', '/v1/admin/catalog/attributes', {'code': code, 'name': name, 'kind': 'text', 'required': False})
        keys = ('sku', 'slug', 'name', 'description', 'price', 'currency', 'unit', 'category_id', 'attribute_set_id', 'attributes', 'media_ids', 'active', 'in_stock')
        body = {key: p[key] for key in keys}
        body['attributes'] = {**p['attributes'], **facts}
        client.call('PUT', f'/v1/admin/catalog/products/{p["id"]}', body)
        print('Updated', p['id'], '; backup:', backup)
    else:
        print('Dry run; use --apply to save these facts.')
finally:
    client.call('POST', '/v1/admin/auth/logout')
