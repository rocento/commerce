#!/usr/bin/env python3
"""Group the 15 extra sizes into families and add 20 distinct grocery items.

Run on EC2 via deploy/aws-deploy/update-grocery-catalog.sh. Preview is the default.
Uses existing API authentication, categories and inventory sources. Existing
SKU identities, prices and stock are preserved. No secret values are logged.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import fcntl
import json
import os
from pathlib import Path
import shlex
import socket
import sys
import uuid

FIELDS = ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description',
          'category_id', 'media_ids', 'active', 'in_stock', 'attributes', 'attribute_set_id')


def body(product):
    return {key: product[key] for key in FIELDS if key in product}


def list_products(client):
    result, offset = [], 0
    while True:
        page = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
        result.extend(page)
        if len(page) < 50:
            return result
        offset += 50


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--phase', choices=('all', 'families', 'products'), default='all')
    parser.add_argument('--root', type=Path, default=Path('/opt/rocento'))
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    assets = args.assets or args.root / 'commerce-assets/demo/grocery-expansion-20260929'
    manifest = json.loads((assets / 'manifest.json').read_text())
    code = manifest['attribute_code']
    require(len(manifest['families']) == 15 and len(manifest['products']) == 20, 'Unexpected manifest counts')
    require(len({p['sku'] for p in manifest['products']}) == 20, 'Duplicate new SKU')
    require(len({p['slug'] for p in manifest['products']}) == 20, 'Duplicate new slug')
    # Coordinate with full deployments without removing or bypassing their lock.
    lock = None
    if args.apply:
        lock = (args.root / 'deploy/ec2/setup.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    values = {}
    for line in (args.root / 'deploy/ec2/bootstrap.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            tokens = shlex.split(value, comments=True)
            values[key.strip()] = tokens[0] if tokens else ''
    host = 'admin.' + values['DOMAIN']
    original_resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda hostname, port, *a, **kw: original_resolve(
        '127.0.0.1' if hostname == host else hostname, port, *a, **kw)
    os.environ['DEMO_SSL_CA_FILE'] = '/etc/nginx/ssl/rocento-origin.pem'
    sys.path.insert(0, str(args.root / 'commerce-assets/demo'))
    from demo_seed import Client
    client = Client('https://' + host + '/api')
    client.call('POST', '/v1/admin/auth/login', {
        'email': values['GROCERY_ADMIN_EMAIL'], 'password': values['GROCERY_ADMIN_PASSWORD']})
    try:
        products = list_products(client)
        by_sku = {p['sku']: p for p in products}
        by_slug = {p['slug']: p for p in products}
        categories = {c['slug']: c for c in client.call('GET', '/v1/catalog/categories')}
        definitions = client.call('GET', '/v1/admin/attribute-definitions?entity_type=product')
        definition = next((d for d in definitions if d['attribute_code'] == code), None)
        options = sorted({f[k] for f in manifest['families'] for k in ('original_size', 'extra_size')})
        if definition:
            require(definition['used_for_configurations'] and definition['input_type'] in ('select', 'single_select'), 'Pack-size attribute is incompatible')
            require(set(options) <= {o['value'] for o in definition['options']}, 'Pack-size attribute is missing required options')
        planned_families = []
        if args.phase != 'products':
            for family in manifest['families']:
                original = by_slug.get(family['source_slug'])
                extra = by_sku.get(family['extra_sku'])
                require(original and extra, 'Missing source sizes for ' + family['name'])
                parent = by_sku.get(family['parent_sku'])
                require(family['parent_slug'] not in by_slug or by_slug[family['parent_slug']]['sku'] == family['parent_sku'], 'Parent slug conflict')
                for child in (original, extra):
                    require(child['product_type'] == 'simple', 'Source is not a simple SKU')
                    require(child.get('parent_id') in (None, parent['id'] if parent else None), 'Source belongs to another family')
                    require(child['media_ids'], 'Missing existing product image')
                if parent:
                    existing = client.call('GET', f"/v1/admin/catalog/products/{parent['id']}/family")
                    structure = existing['structure']
                    require(structure['product_type'] in ('simple', 'configurable'), 'Unexpected parent type')
                    require(not structure['children'] or {x['child_id'] for x in structure['children']} == {original['id'], extra['id']}, 'Existing family has different children')
                planned_families.append((family, original, extra, parent))
        if args.phase != 'families':
            for product in manifest['products']:
                require(product['category'] in categories, 'Missing current category: ' + product['category'])
                require(product['slug'] not in by_slug or by_slug[product['slug']]['sku'] == product['sku'], 'New product slug conflict')
                require(not any(p['name'].casefold() == product['name'].casefold() and p['sku'] != product['sku'] for p in products), 'Duplicate product name: ' + product['name'])
                require((assets / product['image']).is_file(), 'Missing generated photo: ' + product['image'])
        print(f"Plan: {len(planned_families)} size families; {0 if args.phase == 'families' else 20} distinct new items", flush=True)
        if not args.apply:
            print('Preview only; pass --apply to save.')
            return
        backup_dir = Path('/var/log/rocento/catalog')
        backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = backup_dir / (stamp + '-grocery-before.json')
        backup.write_text(json.dumps({'products': products, 'definitions': definitions, 'categories': list(categories.values())}, indent=2))
        backup.chmod(0o600)
        print('Metadata backup:', backup, flush=True)
        if planned_families and not definition:
            definition = client.call('POST', '/v1/admin/attribute-definitions', {
                'id': str(uuid.uuid4()), 'entity_type': 'product', 'attribute_code': code,
                'label': 'Pack size', 'input_type': 'select', 'scope': 'global',
                'is_required': False, 'is_unique': False, 'is_searchable': True,
                'is_filterable': True, 'is_comparable': True, 'is_visible_on_front': True,
                'used_for_promo_rules': False, 'used_for_configurations': True,
                'swatch_type': 'none', 'options': [{'value': value, 'label': value} for value in options],
                'version': 0, 'metadata': {'ai_queryable': True}})
        family_ids = []
        for family, original, extra, parent in planned_families:
            for child, size in ((original, family['original_size']), (extra, family['extra_size'])):
                if child['attributes'].get(code) != size:
                    payload = body(child)
                    payload['attributes'] = {**child['attributes'], code: size}
                    client.call('PUT', '/v1/admin/catalog/products/' + child['id'], payload)
            if not parent:
                payload = body(original)
                payload.update(sku=family['parent_sku'], slug=family['parent_slug'], name=family['name'],
                    price=str(min(Decimal(original['price']), Decimal(extra['price']))),
                    description=f"{family['name']}. Choose your pack size. Price and availability depend on the selected size.",
                    attributes={k: v for k, v in original['attributes'].items() if k != code})
                parent = client.call('POST', '/v1/admin/catalog/products', payload)
            endpoint = '/v1/admin/catalog/products/' + parent['id'] + '/family'
            expected = {'product_type': 'configurable', 'configurable_attributes': [code],
                'children': [{'child_id': child['id'], 'option_label': size, 'quantity': 1}
                    for child, size in ((original, family['original_size']), (extra, family['extra_size']))]}
            actual = client.call('GET', endpoint)['structure']
            if actual != expected:
                client.call('PUT', endpoint, expected)
            family_ids.append((parent['id'], original['id'], extra['id']))
            print('Configurable:', family['name'], '—', family['original_size'], '/', family['extra_size'], flush=True)
        new_ids = []
        if args.phase != 'families':
            sources = client.call('GET', '/v1/admin/inventory/sources')
            enabled = {s['id'] for s in sources if s['is_enabled']}
            stocks = client.call('GET', '/v1/admin/inventory/stocks')
            source_ids = {min((s for s in stock['sources'] if s['source_id'] in enabled), key=lambda s: s['priority'])['source_id']
                for stock in stocks if any(s['source_id'] in enabled for s in stock['sources'])}
            require(source_ids, 'No enabled fulfillment source')
            for product in manifest['products']:
                saved = by_sku.get(product['sku'])
                if not saved:
                    media = client.upload(assets / product['image'], product['name'] + ' — AI-generated illustrative product photo')
                    payload = {k: product[k] for k in ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description')}
                    payload.update(category_id=categories[product['category']]['id'], media_ids=[media['id']],
                        attributes={}, active=True, in_stock=True)
                    saved = client.call('POST', '/v1/admin/catalog/products', payload)
                    print('Created:', product['name'], flush=True)
                else:
                    print('Kept:', product['name'], flush=True)
                endpoint = '/v1/admin/inventory/' + saved['id'] + '/sources'
                inventory = {item['source_id']: item for item in client.call('GET', endpoint)}
                require(all(s in inventory and 'is_assigned' in inventory[s] for s in source_ids), 'API must report inventory assignment state')
                for source_id in sorted(source_ids):
                    # Resume interrupted creation, but never restock a sold-out assignment.
                    if inventory[source_id]['is_assigned']:
                        continue
                    client.call('PUT', endpoint, {'source_id': source_id, 'quantity': product['initial_quantity'],
                        'status': 'in_stock', 'notify_stock_qty': 5, 'reason': 'Initial stock for 20 new grocery demo products'})
                new_ids.append(saved['id'])
        for parent_id, original_id, extra_id in family_ids:
            family = client.call('GET', '/v1/admin/catalog/products/' + parent_id + '/family')
            require(family['structure']['product_type'] == 'configurable', 'Family type verification failed')
            require({c['id'] for c in family['children']} == {original_id, extra_id}, 'Family children verification failed')
            require(all(c['variant_attributes'].get(code) for c in family['children']), 'Size labels missing')
        for product_id in new_ids:
            product = client.call('GET', '/v1/catalog/products/' + product_id)
            require(product['active'] and product['media_ids'], 'Public product verification failed')
        print(json.dumps({'verified_configurable_families': len(family_ids), 'verified_new_items': len(new_ids)}))
    finally:
        client.call('POST', '/v1/admin/auth/logout')
        socket.getaddrinfo = original_resolve
        if lock:
            lock.close()


if __name__ == '__main__':
    main()
