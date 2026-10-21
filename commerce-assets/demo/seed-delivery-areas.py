"""Preview or seed Egypt demo delivery zones, local sources and regional reserves."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import sys
from demo_seed import Client, ROOT

sys.path.insert(0, str(ROOT / 'commerce-ops/scripts'))
from demo_presets import assert_isolated, list_products, load_preset

PREFIX = 'Egypt demo — '
VERSION = 'egypt-network-v3'
PROFILES = {
    'pharmacy': {'primary': (12, 30), 'backup': (50, 100), 'threshold': 4, 'label': 'Pharmacy & skincare fulfillment'},
    'grocery': {'primary': (24, 60), 'backup': (100, 180), 'threshold': 8, 'label': 'Grocery fulfillment'},
    'jewelry': {'primary': (3, 8), 'backup': (15, 30), 'threshold': 2, 'label': 'Jewelry secure dispatch'},
    'electronics': {'primary': (8, 20), 'backup': (40, 80), 'threshold': 4, 'label': 'Electronics fulfillment'},
}
def load_sites(path):
    sites = json.loads(Path(path).read_text())
    if not isinstance(sites, list) or not sites:
        raise ValueError('Delivery areas must be a nonempty JSON list.')
    names = set()
    for site in sites:
        if not isinstance(site, dict) or not isinstance(site.get('name'), str) or not site['name'].strip():
            raise ValueError('Every delivery area needs a name.')
        name = site['name'].split(',')[0].removesuffix(' (Demo)').strip().lower().replace(' ', '-')
        if not name or name in names:
            raise ValueError('Delivery area names must be unique.')
        names.add(name)
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', name):
            raise ValueError('Delivery area names must produce a valid source code (up to 40 characters).')
        radius = site.get('delivery_radius_km', 2)
        if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or not 1 <= radius <= 50:
            raise ValueError('Demo delivery radius must be between 1 and 50 km.')
        for field, limit, padding in [('latitude', 90, .015), ('longitude', 180, .02)]:
            value = site.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > limit - padding:
                raise ValueError(f'Invalid {field} for delivery area {site["name"]}.')
    for site in sites:
        if site.get('regional_hub') and site['regional_hub'] not in names:
            raise ValueError(f'Unknown regional hub: {site["regional_hub"]}')
    return sites


SITES = load_sites(os.environ.get('DEMO_DELIVERY_AREAS_FILE') or ROOT / 'commerce-demo/egypt-delivery-areas.json')


def site_name(site):
    return site['name'].split(',')[0].removesuffix(' (Demo)').strip()


def code(site):
    return 'demo-eg-' + site_name(site).lower().replace(' ', '-')


def quantities(store, sku):
    """Stable across Python processes, site/API ordering and interrupted runs."""
    return [(source_quantity(store, sku, code(site) + '-source-1', 'primary'),
             source_quantity(store, sku, backup_code(site), 'backup')) for site in SITES]


def source_quantity(store, sku, source_code, role):
    digest = hashlib.sha256(f'{VERSION}:{store}:{sku}:{source_code}'.encode()).digest()
    return random.Random(int.from_bytes(digest, 'big')).randint(*PROFILES[store][role])


def backup_code(site):
    return 'demo-eg-regional-' + site['regional_hub'] if site.get('regional_hub') else code(site) + '-source-2'


def source_specs(site, store):
    hub = next((s for s in SITES if code(s) == 'demo-eg-' + site.get('regional_hub', '')), site)
    for key, place, role, priority in [(code(site) + '-source-1', site, 'primary', 0),
                                      (backup_code(site), hub, 'backup', 100)]:
        yield dict(code=key, name=f'{site_name(place)} — {PROFILES[store]["label"]} {role}',
                   is_enabled=True, address=f'{site_name(place)}, {place.get("governorate", "Egypt")} — illustrative demo facility',
                   latitude=place['latitude'], longitude=place['longitude'], contact_name='Demo fulfillment team',
                   contact_phone='', priority=priority)


def area_input(site, stock_id, priority):
    lat, lon = site['latitude'], site['longitude']
    if 'delivery_radius_km' in site:
        radius = site['delivery_radius_km']
        boundary = [dict(latitude=round(lat + radius / 111.32 * math.sin(i * math.tau / 16), 7),
                         longitude=round(lon + radius / (111.32 * math.cos(math.radians(lat))) * math.cos(i * math.tau / 16), 7))
                    for i in range(16)]
    else:
        boundary = [dict(latitude=lat + dy, longitude=lon + dx)
                    for dy, dx in [(-.015, -.02), (-.015, .02), (.015, .02), (.015, -.02)]]
    return dict(name=PREFIX + site_name(site), priority=priority, is_active=True,
                boundary=boundary, stocks=[dict(stock_id=stock_id, priority=0)])


def replenish_source(client, path, items, source_id, quantity, threshold=3):
    item = items.get(source_id)
    if item is None or 'is_assigned' not in item:
        raise RuntimeError('Inventory source assignment information is missing; deploy source is_assigned support before seeding.')
    reserved = int(item.get('reserved', 0))
    if item['is_assigned'] and item.get('status', 'in_stock') == 'in_stock' and item['quantity'] > reserved:
        return 0
    quantity = max(int(item['quantity']), reserved + quantity)
    client.call('PUT', path, dict(source_id=source_id, quantity=quantity,
        status='in_stock', notify_stock_qty=item.get('notify_stock_qty', threshold) if item['is_assigned'] else threshold,
        reason=VERSION + ': ensure all demo products available'))
    return 1


def seed_existing_coverage(client, store, preset, products, areas, sources, stocks):
    """Stock the isolated demo catalog without adding or changing coverage."""
    sources_by_id = {s['id']: s for s in sources.values()}
    active = [a for a in areas if a['is_active']]
    selected = linked_sources(areas, sources, stocks)
    families = {child: f['parent'] for f in preset['families'] for child in f['children']}
    changed = 0
    for product in (products if selected else []):
        path = f"/v1/admin/inventory/{product['id']}/sources"
        items = {item['source_id']: item for item in client.call('GET', path)}
        sku = families.get(product['sku'], product['sku'])
        for source_id in sorted(selected):
            source_code = sources_by_id[source_id]['code']
            role = 'backup' if source_code.startswith('demo-eg-regional-') or source_code.endswith('-source-2') else 'primary'
            quantity = source_quantity(store, sku, source_code, role)
            changed += replenish_source(client, path, items, source_id, quantity, PROFILES[store]['threshold'])
    print(f'[OK] {store}: preserved all {len(areas)} existing delivery areas and their stock links; '
          f'{len(active)} active areas, {len(selected)} enabled sources; '
          f'{changed} demo inventory assignments created or replenished. No delivery coverage was changed.', flush=True)


def linked_sources(areas, sources, stocks):
    """Validate existing coverage before making any writes."""
    by_source = {s['id']: s for s in sources.values()}
    by_stock = {s['id']: s for s in stocks.values()}
    selected = set()
    for area in areas:
        if not area['is_active']:
            continue
        available = set()
        for link in area['stocks']:
            stock = by_stock.get(link['stock_id'])
            if stock is None:
                raise RuntimeError(f'Delivery area {area["name"]!r} references a missing stock.')
            for member in stock['sources']:
                source = by_source.get(member['source_id'])
                if source is None:
                    raise RuntimeError(f'Delivery area {area["name"]!r} references a missing source.')
                if source['is_enabled']:
                    available.add(source['id'])
        if not available:
            raise RuntimeError(f'Delivery area {area["name"]!r} has no enabled source.')
        selected.update(available)
    return selected


def preview(store):
    sources = {s['code']: s for site in SITES for s in source_specs(site, store)}
    return dict(version=VERSION, store=store,
                coverage='Illustrative city zones across Egypt; not official governorate boundaries or universal address coverage.',
                governorates=len({s['governorate_code'] for s in SITES if s.get('governorate_code')}),
                area_count=len(SITES), source_count=len(sources), stock_count=len(SITES),
                inventory_profile=PROFILES[store], sources=list(sources.values()),
                stocks=[dict(code=code(site), name=site_name(site) + ' demo stock', is_default=False,
                             sources=[dict(source_code=spec['code'], priority=spec['priority']) for spec in source_specs(site, store)]) for site in SITES],
                areas=[area_input(site, code(site), 1000 + i * 10) for i, site in enumerate(SITES)])


def seed(client, store, expand_coverage=False):
    preset, _ = load_preset(store)
    products = list_products(client)
    assert_isolated(preset, products, client.call('GET', '/v1/catalog/categories'))
    excluded = {p['sku'] for p in preset.get('retired_products', [])} | {f['parent'] for f in preset['families']}
    products = [p for p in products if p['sku'] not in excluded and p.get('active', True)]
    if not products:
        raise RuntimeError('Seed active demo products first.')
    area_path = '/v1/admin/inventory/delivery-areas'
    areas = client.call('GET', area_path)
    expected = {PREFIX + site_name(site) for site in SITES}
    has_custom_coverage = any(area['name'] not in expected for area in areas)
    probe = client.call('GET', f"/v1/admin/inventory/{products[0]['id']}/sources")
    if not probe or any('is_assigned' not in item for item in probe):
        raise RuntimeError('Deploy the API with source is_assigned support before seeding.')
    sources = {x['code']: x for x in client.call('GET', '/v1/admin/inventory/sources')}
    stocks = {x['code']: x for x in client.call('GET', '/v1/admin/inventory/stocks')}
    selected = linked_sources(areas, sources, stocks)
    if has_custom_coverage and not expand_coverage:
        seed_existing_coverage(client, store, preset, products, areas, sources, stocks)
        return {'store': store, 'coverage_preserved': True, 'areas': len(areas)}
    by_name = {x['name']: x for x in areas}
    if len(by_name) != len(areas):
        raise RuntimeError('Duplicate delivery area names; resolve them before seeding.')
    default_ids = {x['id'] for x in stocks.values() if x.get('is_default')}
    pending = []
    # Preserve all existing geometry and all non-default source/stock assignments.
    # New zones are published only after their enabled sources are stocked.
    for i, site in enumerate(SITES):
        old = by_name.get(PREFIX + site_name(site))
        if old is not None and not (old['stocks'] and all(x['stock_id'] in default_ids for x in old['stocks'])):
            continue
        key = code(site)
        if key not in stocks:
            links = []
            for spec in source_specs(site, store):
                if spec['code'] not in sources:
                    sources[spec['code']] = {**spec, **client.call('POST', '/v1/admin/inventory/sources', spec)}
                links.append(dict(source_id=sources[spec['code']]['id'], priority=spec['priority']))
            body = dict(code=key, name=site_name(site) + ' demo stock', is_default=False, sources=links)
            stocks[key] = {**body, **client.call('POST', '/v1/admin/inventory/stocks', body)}
        if stocks[key]['is_default']:
            raise RuntimeError(f'Demo stock code {key} belongs to the default stock; resolve the conflict in admin.')
        area = area_input(site, stocks[key]['id'], 1000 + i * 10)
        if old is not None:
            area = {k: v for k, v in old.items() if k != 'id'} | {'stocks': area['stocks']}
        selected.update(linked_sources([area], sources, stocks))
        pending.append((old, area))
    families = {child: f['parent'] for f in preset['families'] for child in f['children']}
    by_source = {s['id']: s for s in sources.values()}
    assignments = 0
    for product in products:
        path = f"/v1/admin/inventory/{product['id']}/sources"
        items = {x['source_id']: x for x in client.call('GET', path)}
        for source_id in sorted(selected):
            source_code = by_source[source_id]['code']
            role = 'backup' if source_code.startswith('demo-eg-regional-') or source_code.endswith('-source-2') else 'primary'
            quantity = source_quantity(store, families.get(product['sku'], product['sku']), source_code, role)
            assignments += replenish_source(client, path, items, source_id, quantity, PROFILES[store]['threshold'])
    for old, body in pending:
        client.call('POST' if old is None else 'PUT', area_path + ('/' + old['id'] if old else ''), body)
    # Read back the actual relationships, including preserved or previously edited ones.
    actual = client.call('GET', area_path)
    if not expected.issubset({a['name'] for a in actual}):
        raise RuntimeError('Seed verification failed: some planned delivery areas are missing.')
    enabled = linked_sources(actual, sources, stocks)
    result = dict(store=store, areas=len(actual), planned_areas=len(SITES),
                  active_areas=sum(a['is_active'] for a in actual), enabled_linked_sources=len(enabled),
                  areas_created=sum(old is None for old, _ in pending),
                  legacy_links_migrated=sum(old is not None for old, _ in pending),
                  inventory_assignments=assignments, products=len(products))
    print('[OK] ' + json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', choices=['grocery', 'jewelry', 'electronics', 'pharmacy'], required=True)
    parser.add_argument('--api-base')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expand-coverage', action='store_true', help='Add missing demo zones alongside custom coverage; preserve existing areas and links')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps(preview(args.store), indent=2))
        return
    if not args.api_base:
        parser.error('--apply requires --api-base')
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not email or not password:
        parser.error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD using protected deployment configuration.')
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', dict(email=email, password=password))
    try:
        seed(client, args.store, expand_coverage=args.expand_coverage)
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    main()
