#!/usr/bin/env python3
"""Add inactive Grocery enrichment examples using the normal admin APIs."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'commerce-assets/demo'))
from demo_seed import Client

NAMESPACE = uuid.UUID('17b9b207-6795-4659-a4a7-fd5ac8a452ea')
SET_ID = str(uuid.uuid5(NAMESPACE, 'attribute-set'))
PREFIX = 'ENRICH-DEMO-'


def definition(code, label, kind, options=()):
    return dict(id=str(uuid.uuid5(NAMESPACE, code)), entity_type='product',
                attribute_code=code, label=label, input_type=kind, scope='global',
                is_required=False, is_unique=False, is_searchable=False,
                is_filterable=False, is_comparable=False, is_visible_on_front=False,
                used_for_promo_rules=False, used_for_configurations=False,
                swatch_type='none', options=[dict(value=v, label=l) for v, l in options],
                version=0, metadata=dict(status='active', ai_enrichable=True,
                                        source_policy='semantic', admin_visible=True))


DEFINITIONS = [
    definition('demo_enrichment_occasion', 'Demo occasion', 'single_select',
               [('everyday', 'Everyday'), ('hosting', 'Hosting'), ('gifting', 'Gifting')]),
    definition('demo_enrichment_character', 'Demo character', 'text'),
    definition('demo_enrichment_pairings', 'Demo pairings', 'multi_select',
               [('tea', 'Tea'), ('coffee', 'Coffee'), ('salads', 'Salads'), ('toast', 'Toast')]),
]
PRODUCTS = [
    dict(sku=PREFIX+'DATES', slug='enrichment-demo-medjool-dates', name='Enrichment Demo · Medjool Dates',
         description='Inactive sample for testing catalog enrichment.\nDemo occasion: Gifting\nDemo character: Rich and caramel-like\nDemo pairings: Tea, Coffee', attributes={}),
    dict(sku=PREFIX+'OLIVE-OIL', slug='enrichment-demo-olive-oil', name='Enrichment Demo · Olive Oil',
         description='Inactive sample for testing catalog enrichment.\nDemo occasion: Everyday\nDemo character: Bright and peppery\nDemo pairings: Salads, Toast', attributes={}),
    dict(sku=PREFIX+'TEA', slug='enrichment-demo-mint-tea', name='Enrichment Demo · Mint Tea',
         description='Inactive sample: the existing occasion must be preserved.\nDemo occasion: Hosting\nDemo character: Fresh and cooling\nDemo pairings: Tea',
         attributes={'demo_enrichment_occasion': 'everyday'}),
    dict(sku=PREFIX+'HISTORY', slug='enrichment-demo-coffee-gift-box', name='Enrichment Demo · Coffee Gift Box',
         description='Inactive sample with approved, rejected and pending review examples.\nDemo occasion: Gifting\nDemo character: Warm and aromatic\nDemo pairings: Coffee, Tea', attributes={}),
]


def all_products(client):
    products, offset = [], 0
    while True:
        page = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
        products.extend(page)
        if len(page) < 50:
            return products
        offset += 50


def seed(client):
    existing = {p['sku']: p for p in all_products(client)}
    definitions = {d['attribute_code']: d for d in client.call('GET', '/v1/admin/attribute-definitions?entity_type=product')}
    sets = client.call('GET', '/v1/admin/attribute-sets')
    categories = client.call('GET', '/v1/admin/catalog/categories')
    if not categories:
        raise RuntimeError('Seed the Grocery catalog first; an existing category is required.')
    # Preflight all collisions before the first write. Re-runs preserve user reviews and edits.
    for d in DEFINITIONS:
        old = definitions.get(d['attribute_code'])
        if old and (old['id'] != d['id'] or old['input_type'] != d['input_type']
                    or old.get('options', []) != d['options']
                    or not old.get('metadata', {}).get('ai_enrichable')
                    or old.get('metadata', {}).get('source_policy') != 'semantic'):
            raise RuntimeError(f"Demo definition conflict: {d['attribute_code']}")
    expected_ids = {d['id'] for d in DEFINITIONS}
    old_set = next((s for s in sets if s['id'] == SET_ID), None)
    if old_set and {m['definition_id'] for m in old_set['members']} != expected_ids:
        raise RuntimeError('Demo attribute set has been modified; restore it before reseeding.')
    by_slug = {p['slug']: p for p in existing.values()}
    for p in PRODUCTS:
        old = existing.get(p['sku'])
        if old and (old['slug'] != p['slug'] or old.get('attribute_set_id') != SET_ID or old['active']):
            raise RuntimeError(f"Demo product conflict: {p['sku']}")
        if not old and p['slug'] in by_slug:
            raise RuntimeError(f"Demo slug already in use: {p['slug']}")
    for d in DEFINITIONS:
        if d['attribute_code'] not in definitions:
            client.call('POST', '/v1/admin/attribute-definitions', d)
    if not old_set:
        client.call('POST', '/v1/admin/attribute-sets', dict(
            id=SET_ID, name='Catalog enrichment demo', version=0,
            description='Optional semantic fields for inactive enrichment examples.',
            members=[dict(definition_id=d['id'], group_name='Enrichment demo', position=i) for i, d in enumerate(DEFINITIONS)]))
    created = 0
    seeded = []
    for sample in PRODUCTS:
        product = existing.get(sample['sku'])
        if not product:
            product = client.call('POST', '/v1/admin/catalog/products', dict(
                **sample, price='10.00', currency='EGP', unit='pack',
                category_id=categories[0]['id'], attribute_set_id=SET_ID,
                media_ids=[], active=False, in_stock=False))
            created += 1
        suggestions = client.call('POST', f"/v1/admin/catalog/products/{product['id']}/enrichment")
        if sample['sku'] == PREFIX+'HISTORY':
            for suggestion in suggestions:
                # Only the dedicated history sample receives initial terminal decisions.
                # Existing terminal decisions are never changed on a repeat run.
                if suggestion['status'] == 'pending' and suggestion['definition_id'] in [DEFINITIONS[0]['id'], DEFINITIONS[1]['id']]:
                    client.call('PUT', f"/v1/admin/catalog/enrichment/{suggestion['id']}",
                                {'approve': suggestion['definition_id'] == DEFINITIONS[0]['id']})
        current = client.call('GET', f"/v1/admin/catalog/enrichment?product_id={product['id']}&limit=100")
        seeded.append(dict(id=product['id'], sku=product['sku'], name=product['name'],
                           active=product['active'], suggestions=dict(Counter(s['status'] for s in current))))
    return dict(created_products=created, kept_products=len(PRODUCTS)-created,
                products=seeded, search=PREFIX,
                note='Inactive products only. Existing catalog data and review decisions are preserved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--api-base', help='Explicit target, e.g. https://admin.rocento.com/api')
    parser.add_argument('--credentials', type=Path, help='Private file with Email: and Password: lines')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps(dict(definitions=DEFINITIONS, products=PRODUCTS, expected_initial_suggestions={'pending': 9, 'approved': 1, 'rejected': 1}), indent=2))
        return
    if not args.api_base:
        parser.error('--apply requires an explicit --api-base')
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not (email and password) and args.credentials:
        values = dict(line.split(': ', 1) for line in args.credentials.read_text().splitlines() if ': ' in line)
        email, password = values['Email'], values['Password']
    if not (email and password):
        parser.error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD or pass --credentials')
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', dict(email=email, password=password))
    try:
        print(json.dumps(seed(client), indent=2))
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    main()
