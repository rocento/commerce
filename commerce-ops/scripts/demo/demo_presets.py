"""Data-only demo presets, resolved and seeded through the existing commerce APIs."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from copy import deepcopy
import json
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / 'commerce-assets/demo'
PRESETS = ROOT / 'commerce-demo'


def load_preset(name):
    if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
        raise ValueError('Invalid preset name')
    folder = PRESETS / name
    data = json.loads((folder / 'preset.json').read_text())
    theme = json.loads((folder / 'theme.json').read_text())
    if data['id'] != name:
        raise ValueError('Preset identity mismatch')
    categories = {c['slug'] for c in data['categories']}
    skus = {p['sku'] for p in data['products']}
    if len(categories) != len(data['categories']) or len(skus) != len(data['products']):
        raise ValueError('Duplicate category or SKU')
    if len({p['slug'] for p in data['products']}) != len(data['products']):
        raise ValueError('Duplicate product slug')
    for p in data['products']:
        if p['category'] not in categories:
            raise ValueError('Unknown product category')
        for path in p['images']:
            asset_path(path)
        if p.get('thumbnail'):
            asset_path(p['thumbnail'])
    for c in data['categories']:
        if c.get('thumbnail'):
            asset_path(c['thumbnail'])
    for family in data['families']:
        if family['parent'] not in skus or any(s not in skus for s in family['children']):
            raise ValueError('Unknown family SKU')
    def check(ref):
        if ref.startswith('asset:'):
            asset_path(ref[6:])
        elif ref.startswith(('category:', 'category-link:')) and ref.split(':', 1)[1] not in categories:
            raise ValueError('Unknown theme category')
        return ref
    transform(theme, check)
    return data, theme


def asset_path(value):
    path = (ASSETS / value).resolve()
    if not path.is_relative_to(ASSETS.resolve()) or not path.is_file():
        raise ValueError('Missing or unsafe demo asset: ' + value)
    return path


def transform(value, convert):
    if isinstance(value, dict):
        return {k: transform(v, convert) for k, v in value.items()}
    if isinstance(value, list):
        return [transform(v, convert) for v in value]
    return convert(value) if isinstance(value, str) else value


def resolve_theme(theme, media, categories):
    def resolve(value):
        if value.startswith('asset:'):
            return media[value[6:]]
        if value.startswith('category:'):
            return categories[value[9:]]['id']
        if value.startswith('category-link:'):
            return '/categories/' + categories[value[14:]]['id']
        return value
    return transform(deepcopy(theme), resolve)


def list_products(client):
    rows, offset = [], 0
    while True:
        page = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
        rows.extend(page)
        if len(page) < 50:
            return rows
        offset += 50


def assert_isolated(preset, products, categories):
    """Reject mixed installations before any write (including media/attributes)."""
    skus = {p['sku'] for p in preset['products']}
    slugs = {c['slug'] for c in preset['categories']}
    retired = {p['sku']: p['slug'] for p in preset.get('retired_products', [])}
    slugs.update(preset.get('retired_categories', []))
    if any(p['sku'] not in skus and retired.get(p['sku']) != p.get('slug', '') for p in products) or any(c['slug'] not in slugs for c in categories):
        raise ValueError('Target contains another catalog. Use a separate demo installation; sales channels do not isolate catalog/search data.')


def has_theme_assignment(assignment):
    return bool(assignment and (assignment.get('theme_id') or assignment.get('rules')))


def verify_seed(client, preset, preserve_theme=False):
    products = list_products(client)
    assert_isolated(preset, products, client.call('GET', '/v1/catalog/categories'))
    required = {p['sku'] for p in preset['products']}
    present = required & {p['sku'] for p in products}
    assignments = client.call('GET', '/v1/admin/themes/assignments')
    assignment = next((a for a in assignments if a['channel'] == preset['channel']), None)
    themes = client.call('GET', '/v1/admin/themes')
    preserved = preserve_theme and has_theme_assignment(assignment)
    if preserved:
        # Verify the existing published themes without requiring the preset name.
        ids = {r['theme_id'] for r in assignment.get('rules', [])}
        if assignment.get('theme_id'):
            ids.add(assignment['theme_id'])
        published = {t['id'] for t in themes if t['owner_channel'] == preset['channel'] and t.get('published_version')}
        theme_ready = ids.issubset(published)
        theme_id = assignment.get('theme_id')
    else:
        theme = next((t for t in themes if t['name'] == preset['name'] and t['owner_channel'] == preset['channel']), None)
        theme_id = theme['id'] if theme else None
        theme_ready = bool(theme and theme.get('published_version') and assignment and assignment.get('theme_id') == theme_id)
    retired_active = [p['sku'] for p in products if p['sku'] not in required and p.get('active', True)]
    needs_thumbnail = {p['sku'] for p in preset['products'] if p.get('thumbnail')}
    images_ready = all(
        p.get('media_ids') and (p['sku'] not in needs_thumbnail or p.get('attributes', {}).get('demo-thumbnail'))
        for p in products if p['sku'] in required
    )
    stock_check = verify_global_stock(client, [p for p in products if p['sku'] in required])
    definitions = {d['attribute_code'] for d in client.call('GET', '/v1/admin/attribute-definitions?entity_type=product')}
    attributes_ready = all(d['attribute_code'] in definitions for d in preset['attributes']) and all(
        set(expected['attributes']).issubset(actual.get('attributes', {}))
        for expected in preset['products'] for actual in products if actual['sku'] == expected['sku'])
    return {'preset': preset['id'], 'seeded': present == required and theme_ready and not retired_active and images_ready and stock_check['ready'] and attributes_ready,
            'global_stock': stock_check, 'attributes_ready': attributes_ready,
            'retired_active': retired_active,
            'products_present': len(present), 'theme_id': theme_id, 'theme_preserved': preserved}


GLOBAL_DEMO_QUANTITY = 1000


def verify_global_stock(client, products):
    sources = client.call('GET', '/v1/admin/inventory/sources')
    stocks = client.call('GET', '/v1/admin/inventory/stocks')
    source = next((s for s in sources if s.get('code') == 'demo-global' and s['is_enabled']), None)
    pool = next((s for s in stocks if s.get('code') == 'demo-global' and s.get('is_global') and not s.get('is_default')), None)
    ready = bool(source and pool and any(s['source_id'] == source['id'] for s in pool['sources']))
    missing = []
    for product in products:
        items = client.call('GET', '/v1/admin/inventory/' + product['id'] + '/sources') if ready else []
        item = next((i for i in items if i['source_id'] == source['id']), None) if source else None
        if not product.get('active', True) or not item or not item.get('is_assigned') or item['status'] != 'in_stock' or item['quantity'] - item.get('reserved', 0) <= 0:
            missing.append(product['sku'])
    return {'ready': ready and not missing, 'unavailable_skus': missing, 'products_checked': len(products)}


def seed_global_stock(client, products):
    """Give the isolated demo catalog a dedicated worldwide availability pool."""
    sources = client.call('GET', '/v1/admin/inventory/sources')
    stocks = client.call('GET', '/v1/admin/inventory/stocks')
    source = next((s for s in sources if s.get('code') == 'demo-global'), None)
    if source is None:
        body = dict(code='demo-global', name='Demo global warehouse', is_enabled=True,
                    address='', latitude=None, longitude=None, contact_name='', contact_phone='', priority=0)
        source = {**body, **client.call('POST', '/v1/admin/inventory/sources', body)}
    elif not source['is_enabled']:
        raise ValueError('Enable the demo-global source before seeding global stock')
    stock = next((s for s in stocks if s.get('code') == 'demo-global'), None)
    body = dict(code='demo-global', name='Global demo stock', is_default=False, is_global=True,
                sources=[dict(source_id=source['id'], priority=0)])
    if stock is None:
        client.call('POST', '/v1/admin/inventory/stocks', body)
    elif not stock.get('is_global') or stock['sources'] != body['sources']:
        if stock.get('is_default'):
            raise ValueError('The demo-global pool must be separate from the default pool')
        client.call('PUT', '/v1/admin/inventory/stocks/' + stock['id'], body)
    for product in products:
        if not product.get('active', True):
            continue
        path = '/v1/admin/inventory/' + product['id'] + '/sources'
        item = next((i for i in client.call('GET', path) if i['source_id'] == source['id']), None)
        if item is None or 'is_assigned' not in item:
            raise ValueError('Inventory source assignment information is missing')
        if int(item.get('reserved', 0)) > GLOBAL_DEMO_QUANTITY:
            raise ValueError('Global demo reservations exceed 1000; release them before resetting stock')
        if item['is_assigned'] and item['quantity'] == GLOBAL_DEMO_QUANTITY and item['status'] == 'in_stock':
            continue
        client.call('PUT', path, dict(source_id=source['id'], quantity=GLOBAL_DEMO_QUANTITY,
                    status='in_stock', notify_stock_qty=0, reason='Demo global stock: 1000 units per product'))
    return {'global_stock_quantity': GLOBAL_DEMO_QUANTITY}


def seed_languages(client, preset, products, categories):
    """Install preset translations once; preserve subsequent administrator edits."""
    if not preset.get('languages'):
        return
    settings = client.call('GET', '/v1/admin/languages')
    existing = settings['languages']
    for language in preset['languages']:
        if language['locale'] != settings['source_locale'] and not any(row['locale'] == language['locale'] for row in existing):
            client.call('POST', '/v1/admin/languages', {**language, 'expected_revision': 0})
    for locale, translations in preset.get('translations', {}).items():
        definitions = {d['attribute_code']: d for d in client.call('GET', '/v1/admin/attribute-definitions?entity_type=product')} if translations.get('attributes') else {}
        for kind, rows, entities in [('product', translations.get('products', {}), products),
                                     ('category', translations.get('categories', {}), categories),
                                     ('attribute', translations.get('attributes', {}), definitions)]:
            for key, fields in rows.items():
                path = f"/v1/admin/languages/{locale}/translations/{kind}/{entities[key]['id']}"
                current = client.call('GET', path)
                if current['revision']:
                    continue
                # Preserve any additional source fields such as brand labels.
                values = {k: v for k, v in current['source'].items() if not k.startswith('__label.')}
                values.update(fields)
                client.call('PUT', path, {'expected_revision': 0, 'source': current['source'],
                                          'fields': values, 'reviewed': True})


def seed(client, preset, template, publish=False, refresh_theme=False, preserve_theme=False):
    if preserve_theme and refresh_theme:
        raise ValueError('Cannot refresh a theme while preserving existing themes')
    products = list_products(client)
    category_rows = client.call('GET', '/v1/catalog/categories')
    assert_isolated(preset, products, category_rows)
    assignments = client.call('GET', '/v1/admin/themes/assignments')
    assignment = next((a for a in assignments if a['channel'] == preset['channel']), None)
    if assignment is None:
        raise ValueError('Preset sales channel must exist before seeding')
    themes = client.call('GET', '/v1/admin/themes')
    matching = [t for t in themes if t['name'] == preset['name'] and t['owner_channel'] == preset['channel']]
    preserved = preserve_theme and has_theme_assignment(assignment)
    if len(matching) > 1 and not preserved:
        raise ValueError('Ambiguous preset theme name; resolve duplicate themes in admin')
    theme = matching[0] if matching else None
    if publish and not preserved and (assignment.get('rules') or assignment.get('theme_id') not in (None, theme['id'] if theme else None)):
        raise ValueError('Channel has another assignment or targeting rules; preserve these and assign the demo manually in admin')
    by_sku = {p['sku']: p for p in products}
    by_slug = {p['slug']: p['sku'] for p in products}
    if any(p['slug'] in by_slug and by_slug[p['slug']] != p['sku'] for p in preset['products']):
        raise ValueError('Preset slug belongs to another SKU; resolve the conflict before seeding')
    # The aggregate stock endpoint rejects default pools with multiple sources.
    # Resolve enabled members once and initialize each source independently.
    stocks = client.call('GET', '/v1/admin/inventory/stocks')
    sources = client.call('GET', '/v1/admin/inventory/sources')
    enabled = {s['id'] for s in sources if s['is_enabled']}
    initial_sources = sorted({link['source_id'] for stock in stocks if stock['is_default']
                              for link in stock['sources'] if link['source_id'] in enabled})
    if not initial_sources:
        raise ValueError('Default inventory stock needs at least one enabled source before seeding')
    # Create definitions only; reruns preserve administrator changes.
    definitions = client.call('GET', '/v1/admin/attribute-definitions?entity_type=product')
    codes = {d['attribute_code'] for d in definitions}
    for d in preset['attributes']:
        if d['attribute_code'] not in codes:
            client.call('POST', '/v1/admin/attribute-definitions', {**d, 'id': str(uuid.uuid4()), 'metadata': {'ai_queryable': d.get('is_visible_on_front', False), 'semantic_role': 'classification' if d['attribute_code'] == 'product-kind' else None, **d.get('metadata', {})}})
        elif preset['id'] in ('pharmacy', 'electronics'):
            # Expanded demo collections need new options without resetting edited labels/settings.
            existing = next(row for row in definitions if row['attribute_code'] == d['attribute_code'])
            values = {option['value'] for option in existing['options']}
            additions = [option for option in d['options'] if option['value'] not in values]
            if additions:
                client.call('POST', '/v1/admin/attribute-definitions', {**existing, 'options': [*existing['options'], *additions]})
    categories = {c['slug']: c for c in category_rows}
    media = {}
    for p in preset['products']:
        old = by_sku.get(p['sku'])
        if old:
            for path, id in zip(p['images'], old.get('media_ids', [])):
                media.setdefault(path, id)
            if p.get('thumbnail') and old.get('attributes', {}).get('demo-thumbnail'):
                media.setdefault(p['thumbnail'], old['attributes']['demo-thumbnail'])
    def upload(path, alt):
        if path not in media:
            media[path] = client.upload(asset_path(path), alt)['id']
        return media[path]
    for c in preset['categories']:
        if c['slug'] not in categories:
            body = {'name': c['name'], 'slug': c['slug'], 'parent_id': None}
            categories[c['slug']] = client.call('POST', '/v1/admin/catalog/categories', body)
        if c.get('thumbnail') and not categories[c['slug']].get('thumbnail'):
            thumbnail = upload(c['thumbnail'], c['name'] + ' — illustrative demo image')
            path = '/v1/admin/catalog/categories/' + categories[c['slug']]['id'] + '/attributes'
            values = client.call('GET', path)
            client.call('PUT', path, {**values, 'thumbnail': thumbnail})
            categories[c['slug']]['thumbnail'] = thumbnail
    created = 0
    for p in preset['products']:
        if p['sku'] in by_sku:
            old = by_sku[p['sku']]
            # Move recognized demo assignments only; preserve merchant recategorization.
            previous_category = categories.get(p.get('previous_category'))
            if previous_category and old.get('category_id') == previous_category['id']:
                body = {k: old[k] for k in ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description', 'category_id', 'media_ids', 'active', 'in_stock', 'attributes')}
                body['category_id'] = categories[p['category']]['id']
                if old.get('attribute_set_id'):
                    body['attribute_set_id'] = old['attribute_set_id']
                client.call('PUT', '/v1/admin/catalog/products/' + old['id'], body)
                old['category_id'] = body['category_id']
            if preset['id'] in ('electronics', 'pharmacy'):
                attributes = {**p['attributes'], **old.get('attributes', {})}
                if attributes != old.get('attributes', {}):
                    body = {k: old[k] for k in ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description', 'category_id', 'media_ids', 'active', 'in_stock')}
                    body['attributes'] = attributes
                    if old.get('attribute_set_id'):
                        body['attribute_set_id'] = old['attribute_set_id']
                    client.call('PUT', '/v1/admin/catalog/products/' + old['id'], body)
            if p.get('thumbnail') and not old.get('attributes', {}).get('demo-thumbnail'):
                body = {k: old[k] for k in ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description', 'category_id', 'media_ids', 'active', 'in_stock')}
                body['attributes'] = {**old.get('attributes', {}), 'demo-thumbnail': upload(p['thumbnail'], p['name'] + ' thumbnail')}
                if old.get('attribute_set_id'):
                    body['attribute_set_id'] = old['attribute_set_id']
                client.call('PUT', '/v1/admin/catalog/products/' + old['id'], body)
            continue
        body = {k: p[k] for k in ('sku', 'slug', 'name', 'price', 'unit', 'description', 'attributes')}
        body.update(currency='USD', category_id=categories[p['category']]['id'], media_ids=[upload(path, p['name'] + ' — illustrative demo image') for path in p['images']], active=True, in_stock=True)
        if p.get('thumbnail'):
            body['attributes'] = {**body['attributes'], 'demo-thumbnail': upload(p['thumbnail'], p['name'] + ' thumbnail')}
        by_sku[p['sku']] = client.call('POST', '/v1/admin/catalog/products', body)
        created += 1
    for f in preset['families']:
        parent = by_sku[f['parent']]
        family = client.call('GET', '/v1/admin/catalog/products/' + parent['id'] + '/family')
        if family['structure']['product_type'] == 'simple' and not family['structure']['children']:
            client.call('PUT', '/v1/admin/catalog/products/' + parent['id'] + '/family', {'product_type': 'configurable', 'configurable_attributes': f['attributes'], 'children': [{'child_id': by_sku[s]['id'], 'option_label': '', 'quantity': 1} for s in f['children']]})
    parents = {f['parent'] for f in preset['families']}
    for p in preset['products']:
        if p['sku'] in parents:
            continue
        id = by_sku[p['sku']]['id']
        path = '/v1/admin/inventory/' + id + '/sources'
        items = {item['source_id']: item for item in client.call('GET', path)}
        if any(source_id not in items or 'is_assigned' not in items[source_id] for source_id in initial_sources):
            raise ValueError('Inventory source assignment information is missing; deploy source is_assigned support before seeding')
        for source_id in initial_sources:
            item = items[source_id]
            # Keep existing quantities/status/thresholds, including sold-out stock.
            # Per-source checks also recover a run interrupted between sources.
            if item['is_assigned']:
                continue
            client.call('PUT', path, {
                'source_id': source_id,
                'quantity': max(p['stock'], int(item.get('quantity', 0)), int(item.get('reserved', 0))),
                'status': 'in_stock', 'notify_stock_qty': 0,
                'reason': 'Initial demo preset stock',
            })
    # Retire only explicitly recognized prior demo SKUs, after replacements exist.
    # Keep records and IDs intact for order and inventory references.
    retired_count = 0
    current_skus = {p['sku'] for p in preset['products']}
    for old in products:
        if old['sku'] in current_skus or not old.get('active', True):
            continue
        body = {k: old[k] for k in ('sku', 'slug', 'name', 'price', 'currency', 'unit', 'description', 'category_id', 'media_ids', 'active', 'in_stock', 'attributes')}
        body['active'] = False
        if old.get('attribute_set_id'):
            body['attribute_set_id'] = old['attribute_set_id']
        client.call('PUT', '/v1/admin/catalog/products/' + old['id'], body)
        retired_count += 1
    seed_global_stock(client, list_products(client))
    seed_languages(client, preset, by_sku, categories)
    if preserved:
        return {'global_stock_quantity': GLOBAL_DEMO_QUANTITY, 'preset': preset['id'], 'created_products': created,
                'retired_products': retired_count,
                'theme_id': assignment.get('theme_id'), 'preview': None,
                'published_and_assigned': False, 'theme_refreshed': False, 'theme_preserved': True}
    if theme is None or refresh_theme:
        def prepare(value):
            if value.startswith('asset:'):
                upload(value[6:], asset_path(value[6:]).stem.replace('-', ' ') + ' — illustrative demo image')
            return value
        transform(template, prepare)
        config = resolve_theme(template, media, categories)
        if theme is None:
            theme = client.call('POST', '/v1/admin/themes', {'name': preset['name'], 'owner_channel': preset['channel']})
        theme = client.call('PUT', '/v1/admin/themes/' + theme['id'], {'expected_revision': theme['revision'], 'configuration': config})
    # Recover an interrupted create-before-save without replacing edited drafts.
    elif not theme.get('published_version') and theme['revision'] == 1:
        def prepare(value):
            if value.startswith('asset:'):
                upload(value[6:], asset_path(value[6:]).stem.replace('-', ' ') + ' — illustrative demo image')
            return value
        transform(template, prepare)
        theme = client.call('PUT', '/v1/admin/themes/' + theme['id'], {'expected_revision': theme['revision'], 'configuration': resolve_theme(template, media, categories)})
    if publish:
        if refresh_theme or not theme.get('published_version'):
            client.call('POST', '/v1/admin/themes/' + theme['id'] + '/publish', {'expected_revision': theme['revision']})
        if assignment.get('theme_id') != theme['id']:
            client.call('PUT', '/v1/admin/themes/assignments/' + preset['channel'], {'expected_revision': assignment['revision'], 'theme_id': theme['id'], 'rules': []})
    return {'global_stock_quantity': GLOBAL_DEMO_QUANTITY, 'preset': preset['id'], 'created_products': created, 'retired_products': retired_count, 'theme_id': theme['id'], 'preview': '/?theme_preview=' + theme['id'], 'published_and_assigned': publish, 'theme_refreshed': refresh_theme}
