import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
import uuid
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from demo_presets import ROOT, load_preset, resolve_theme, assert_isolated, seed, asset_path, verify_seed, seed_global_stock


class MemoryAPI:
    """Exercise loader decisions and payloads without creating a second runtime engine."""
    def __init__(self):
        self.products=[];self.categories=[];self.definitions=[];self.themes=[];self.families={};self.inventory={};self.writes=[]
        self.assignment={'channel':'storefront','theme_id':None,'revision':0,'rules':[]}
        self.sources = [{'id': 'default-source', 'is_enabled': True}]
        self.stocks = [{'is_default': True, 'sources': [{'source_id': 'default-source'}]}]
        self.source_items = {}
        self.languages = []
        self.translations = {}
    def upload(self,path,alt):
        self.writes.append(('upload',str(path)))
        return {'id':str(uuid.uuid4())}
    def call(self,method,path,body=None):
        if method!='GET': self.writes.append((method,path))
        if path == '/v1/admin/languages':
            if method == 'POST': self.languages.append({**body, 'revision': 1})
            return {'source_locale': 'en', 'languages': self.languages}
        if '/translations/' in path:
            kind, entity_id = path.split('/')[-2:]
            row = next(r for r in (self.products if kind == 'product' else self.definitions if kind == 'attribute' else self.categories) if r['id'] == entity_id)
            source = ({'label': row['label'], 'description': '', **{'option.' + o['value']: o['label'] for o in row['options']}} if kind == 'attribute' else {k: row[k] for k in ('name', 'description') if k in row})
            if method == 'PUT': self.translations[path] = {**body, 'revision': 1}
            return copy.deepcopy(self.translations.get(path, {'source': source, 'revision': 0}))
        if path=='/v1/admin/themes/assignments': return [copy.deepcopy(self.assignment)]
        if path.startswith('/v1/admin/catalog/products?'):
            offset=int(path.split('offset=')[1]);return copy.deepcopy(self.products[offset:offset+50])
        if path=='/v1/catalog/categories': return copy.deepcopy(self.categories)
        if path.startswith('/v1/admin/attribute-definitions'):
            if method=='GET': return self.definitions
            existing = next((d for d in self.definitions if d['id'] == body['id']), None)
            if existing is not None:
                existing.update(body);return existing
            self.definitions.append(body);return body
        if path=='/v1/admin/catalog/categories':
            row={**body,'id':str(uuid.uuid4())};self.categories.append(row);return row
        if path.startswith('/v1/admin/catalog/categories/') and path.endswith('/attributes'):
            row=next(c for c in self.categories if c['id']==path.split('/')[5])
            if method=='PUT':row.update(body)
            return {'thumbnail':row['thumbnail']} if row.get('thumbnail') else {}
        if path=='/v1/admin/catalog/products':
            row={**body,'id':str(uuid.uuid4())};self.products.append(row);return row
        if path.startswith('/v1/admin/catalog/products/') and not path.endswith('/family'):
            row=next(p for p in self.products if p['id']==path.split('/')[5])
            if method=='PUT': row.update(body)
            return copy.deepcopy(row)
        if path.endswith('/family'):
            if method=='PUT':self.families[path]=body
            return {'structure':self.families.get(path,{'product_type':'simple','children':[]})}
        if path == '/v1/admin/inventory/stocks':
            if method == 'POST':
                row = {**body, 'id': str(uuid.uuid4())}; self.stocks.append(row); return copy.deepcopy(row)
            return copy.deepcopy(self.stocks)
        if path == '/v1/admin/inventory/sources':
            if method == 'POST':
                row = {**body, 'id': str(uuid.uuid4())}; self.sources.append(row); return copy.deepcopy(row)
            return copy.deepcopy(self.sources)
        if path.startswith('/v1/admin/inventory/') and path.endswith('/sources'):
            product_id = path.split('/')[4]
            if method == 'PUT':
                self.source_items[(product_id, body['source_id'])] = {**body, 'is_assigned': True, 'reserved': 0}
                self.inventory.setdefault(path[:-8], []).append(body)
                return {}
            return [copy.deepcopy(self.source_items.get((product_id, source['id']), dict(source_id=source['id'], is_assigned=False, quantity=0, reserved=0, status='in_stock', notify_stock_qty=0))) for source in self.sources]
        if path.startswith('/v1/admin/inventory/'):
            if method=='PUT': raise RuntimeError('Use per-source quantities for multi-source stock')
            return {'adjustments':self.inventory.get(path,[])}
        if path=='/v1/admin/themes':
            if method=='GET':return copy.deepcopy(self.themes)
            row={**body,'id':str(uuid.uuid4()),'revision':1,'published_version':None};self.themes.append(row);return copy.deepcopy(row)
        if path.startswith('/v1/admin/themes/assignments/'):
            self.assignment.update(body,revision=self.assignment['revision']+1);return self.assignment
        if path.startswith('/v1/admin/themes/'):
            row=next(t for t in self.themes if t['id']==path.split('/')[4])
            if path.endswith('/publish'):row['published_version']=str(uuid.uuid4())
            elif method=='PUT':row['configuration']=body['configuration']
            row['revision']+=1;return copy.deepcopy(row)
        raise AssertionError((method,path))


class PresetTests(unittest.TestCase):
    def test_pharmacy_adds_twenty_products_without_replacing_existing_catalog(self):
        preset, theme = load_preset('pharmacy')
        original = copy.deepcopy(preset)
        original['products'] = original['products'][:20]
        original['translations']['ar']['products'] = {p['sku']: original['translations']['ar']['products'][p['sku']] for p in original['products']}
        for definition in original['attributes']:
            used = {p['attributes'][definition['attribute_code']] for p in original['products']}
            definition['options'] = [o for o in definition['options'] if o['value'] in used]
        api = MemoryAPI()
        seed(api, original, theme, publish=True)
        before = copy.deepcopy(api.products)
        collection = next(d for d in api.definitions if d['attribute_code'] == 'collection')
        collection['label'] = 'Merchant collection label'
        collection['options'][0]['label'] = 'Merchant option label'
        result = seed(api, preset, theme, preserve_theme=True)
        self.assertEqual(result['created_products'], 20)
        self.assertEqual(api.products[:20], before)
        self.assertEqual(len(api.products), 40)
        self.assertEqual(collection['label'], 'Merchant collection label')
        self.assertEqual(collection['options'][0]['label'], 'Merchant option label')
        self.assertTrue({p['attributes']['collection'] for p in preset['products']} <= {o['value'] for o in collection['options']})
        additions = preset['products'][20:]
        self.assertEqual({p['category'] for p in additions}, {c['slug'] for c in preset['categories']})
        self.assertTrue(all(p['sku'] in preset['translations']['ar']['products'] for p in additions))
        self.assertTrue(verify_seed(api, preset)['global_stock']['ready'])
        writes = len(api.writes)
        seed(api, preset, theme, preserve_theme=True)
        self.assertEqual(len(api.writes), writes)

    def test_pharmacy_category_expansion_migrates_only_original_assignments(self):
        preset, theme = load_preset('pharmacy')
        self.assertEqual(len(preset['categories']), 8)
        self.assertEqual({c['slug'] for c in preset['categories']}, {p['category'] for p in preset['products']})
        self.assertTrue(all(c['slug'] in preset['translations']['ar']['categories'] for c in preset['categories']))
        api = MemoryAPI()
        seed(api, preset, theme, publish=True)
        categories = {c['slug']: c['id'] for c in api.categories}
        moved = [p for p in preset['products'] if p.get('previous_category')]
        product = next(p for p in api.products if p['sku'] == moved[0]['sku'])
        product['category_id'] = categories[moved[0]['previous_category']]
        product['name'] = 'Merchant name'
        product['attribute_set_id'] = 'merchant-set'
        edited = next(p for p in api.products if p['sku'] == moved[1]['sku'])
        edited['category_id'] = categories['cleansers']
        seed(api, preset, theme)
        self.assertEqual(product['category_id'], categories[moved[0]['category']])
        self.assertEqual(product['name'], 'Merchant name')
        self.assertEqual(product['attribute_set_id'], 'merchant-set')
        self.assertEqual(edited['category_id'], categories['cleansers'])
        writes = len(api.writes)
        seed(api, preset, theme)
        self.assertEqual(len(api.writes), writes)

    def test_pharmacy_attributes_backfill_and_global_availability_are_verified(self):
        api = MemoryAPI()
        preset, theme = load_preset('pharmacy')
        seed(api, preset, theme, publish=True)
        self.assertTrue(verify_seed(api, preset)['seeded'])
        product = api.products[0]
        product['attributes'] = {'brand': 'Merchant edited brand'}
        product['attribute_set_id'] = 'merchant-set'
        self.assertFalse(verify_seed(api, preset)['attributes_ready'])
        seed(api, preset, theme)
        self.assertEqual(product['attributes']['brand'], 'Merchant edited brand')
        self.assertEqual(product['attributes']['product-kind'], 'Serum')
        self.assertEqual(product['attribute_set_id'], 'merchant-set')
        source = next(s for s in api.sources if s.get('code') == 'demo-global')
        api.source_items[(product['id'], source['id'])]['quantity'] = 0
        check = verify_seed(api, preset)
        self.assertFalse(check['seeded'])
        self.assertEqual(check['global_stock']['unavailable_skus'], [product['sku']])
        seed(api, preset, theme)
        self.assertTrue(verify_seed(api, preset)['global_stock']['ready'])

    def test_pharmacy_arabic_seed_preserves_edited_translations(self):
        api = MemoryAPI()
        preset, theme = load_preset('pharmacy')
        seed(api, preset, theme)
        self.assertEqual({l['locale'] for l in api.languages}, {'ar'})
        self.assertEqual(len(api.translations), 53)
        path = next(iter(api.translations))
        api.translations[path]['fields']['name'] = 'اسم مخصص'
        before = copy.deepcopy(api.translations)
        seed(api, preset, theme)
        self.assertEqual(api.translations, before)

    def test_pharmacy_brand_catalog_retires_original_items_and_preserves_ids(self):
        api = MemoryAPI()
        preset, theme = load_preset('pharmacy')
        self.assertEqual(len(preset['products']), 40)
        brands = [p['attributes']['brand'] for p in preset['products']]
        self.assertEqual(len(set(brands)), 5)
        self.assertTrue(all(brands.count(brand) >= 4 for brand in set(brands)))
        for legacy in preset['retired_products']:
            api.products.append(dict(id=str(uuid.uuid4()), name='Legacy demo item',
                sku=legacy['sku'], slug=legacy['slug'], price='24.00', currency='USD',
                unit='each', description='Original sample', category_id=None,
                media_ids=[], active=True, in_stock=True, attributes={}))
        old_ids = {p['id'] for p in api.products}
        result = seed(api, preset, theme, publish=True)
        self.assertEqual(result['created_products'], 40)
        self.assertEqual(result['retired_products'], 12)
        self.assertEqual(sum(p['active'] for p in api.products), 40)
        self.assertEqual({p['id'] for p in api.products if not p['active']}, old_ids)
        rerun = seed(api, preset, theme, publish=True)
        self.assertEqual(rerun['created_products'], 0)
        self.assertEqual(rerun['retired_products'], 0)

    def test_electronics_replaces_legacy_catalog_with_forty_arabic_brand_products(self):
        api = MemoryAPI()
        preset, theme = load_preset('electronics')
        self.assertEqual(len(preset['products']), 40)
        self.assertEqual(len(preset['retired_products']), 8)
        brand = copy.deepcopy(next(d for d in preset['attributes'] if d['attribute_code'] == 'brand'))
        brand.update(id='existing-brand', label='Merchant brand label', options=[{'value': 'legacy', 'label': 'Legacy brand'}])
        api.definitions.append(brand)
        self.assertEqual(set(preset['translations']['ar']['products']),
                         {p['sku'] for p in preset['products']})
        for legacy in preset['retired_products']:
            api.products.append(dict(legacy, id=str(uuid.uuid4()), name='Legacy demo',
                price='24.00', currency='USD', unit='each', description='',
                category_id=None, media_ids=[], active=True, in_stock=True, attributes={}))
        old_ids = {p['id'] for p in api.products}
        result = seed(api, preset, theme, publish=True)
        self.assertEqual(result['created_products'], 40)
        self.assertEqual(result['retired_products'], 8)
        self.assertEqual(brand['label'], 'Merchant brand label')
        self.assertTrue({p['attributes']['brand'] for p in preset['products']} <= {o['value'] for o in brand['options']})
        self.assertIn({'value': 'legacy', 'label': 'Legacy brand'}, brand['options'])
        self.assertEqual(sum(p['active'] for p in api.products), 40)
        self.assertEqual({p['id'] for p in api.products if not p['active']}, old_ids)
        self.assertTrue(verify_seed(api, preset)['seeded'])
        rerun = seed(api, preset, theme, publish=True)
        self.assertEqual(rerun['created_products'], 0)
        self.assertEqual(rerun['retired_products'], 0)

    def test_all_presets_get_1000_global_units_and_reruns_reset_only_global_stock(self):
        for name in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            with self.subTest(preset=name):
                api = MemoryAPI()
                preset, theme = load_preset(name)
                seed(api, preset, theme, publish=True)
                stock = next(s for s in api.stocks if s.get('code') == 'demo-global')
                self.assertTrue(stock['is_global'])
                source = stock['sources'][0]['source_id']
                active = [p for p in api.products if p['active']]
                self.assertEqual(len([key for key in api.source_items if key[1] == source]), len(active))
                self.assertTrue(all(api.source_items[(p['id'], source)]['quantity'] == 1000 for p in active))
                product = active[0]['id']
                api.source_items[(product, source)].update(quantity=0, status='out_of_stock')
                local = {k: copy.deepcopy(v) for k, v in api.source_items.items() if k[1] != source}
                seed_global_stock(api, api.products)
                self.assertEqual(api.source_items[(product, source)]['quantity'], 1000)
                self.assertEqual(local, {k: v for k, v in api.source_items.items() if k[1] != source})
                writes = len(api.writes)
                seed_global_stock(api, api.products)
                self.assertEqual(len(api.writes), writes)

    def test_complete_seed_reuses_one_login_for_all_steps_and_logs_out_on_failure(self):
        spec = importlib.util.spec_from_file_location('complete_seed_cli', ROOT / 'commerce-ops/scripts/demo/seed-demo-storefront.py')
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        for store, fail_delivery in (('grocery', False), ('jewelry', False), ('grocery', True)):
            with self.subTest(store=store, fail_delivery=fail_delivery):
                api = MemoryAPI()
                auth = []
                original = api.call
                def call(method, path, body=None):
                    if '/auth/' in path:
                        auth.append(path)
                        return {}
                    return original(method, path, body)
                api.call = call
                delivery = Mock(side_effect=RuntimeError('Delivery failed') if fail_delivery else None)
                category = Mock()
                flags = ['--sync-palette'] if store == 'grocery' else []
                with patch.object(cli, 'Client', return_value=api), \
                     patch.object(cli, 'enrichment', side_effect=lambda name: delivery if name == 'seed-delivery-areas' else category), \
                     patch('grocery_palette.sync', return_value={'matches': True}) as palette, \
                     patch.dict('os.environ', {'DEMO_ADMIN_EMAIL': 'demo@example.test', 'DEMO_ADMIN_PASSWORD': 'test-only'}), \
                     patch.object(sys, 'argv', ['seed-demo-storefront.py', store, '--apply', '--publish', '--preserve-theme', '--complete', *flags, '--api-base', 'https://example.test/api']), \
                     contextlib.redirect_stdout(io.StringIO()):
                    if fail_delivery:
                        with self.assertRaisesRegex(RuntimeError, 'Delivery failed'):
                            cli.main()
                    else:
                        cli.main()
                    delivery.assert_called_once_with(api, store)
                    if store == 'jewelry': category.assert_called_once_with(api, store)
                    else: category.assert_not_called()
                    if store == 'grocery' and not fail_delivery: palette.assert_called_once_with(api, apply=True)
                    else: palette.assert_not_called()
                self.assertEqual(auth, ['/v1/admin/auth/login', '/v1/admin/auth/logout'])

    def test_complete_seed_does_not_retry_rate_limited_login(self):
        spec = importlib.util.spec_from_file_location('limited_seed_cli', ROOT / 'commerce-ops/scripts/demo/seed-demo-storefront.py')
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        client = Mock()
        client.call.side_effect = RuntimeError('HTTP 429: Too many attempts')
        with patch.object(cli, 'Client', return_value=client), patch.object(cli, 'seed') as apply_seed, \
             patch.dict('os.environ', {'DEMO_ADMIN_EMAIL': 'demo@example.test', 'DEMO_ADMIN_PASSWORD': 'test-only'}), \
             patch.object(sys, 'argv', ['seed-demo-storefront.py', 'grocery', '--apply', '--complete', '--api-base', 'https://example.test/api']):
            with self.assertRaisesRegex(RuntimeError, '429'):
                cli.main()
            self.assertEqual(client.call.call_count, 1)
            apply_seed.assert_not_called()

    def multi_source_api(self):
        api = MemoryAPI()
        api.sources += [{'id': 'backup-source', 'is_enabled': True},
                        {'id': 'disabled-source', 'is_enabled': False},
                        {'id': 'other-stock-source', 'is_enabled': True}]
        api.stocks[0]['sources'] += [{'source_id': 'backup-source'}, {'source_id': 'disabled-source'}]
        api.stocks.append({'is_default': False, 'sources': [{'source_id': 'other-stock-source'}]})
        return api

    def test_multi_source_stock_uses_enabled_default_sources_and_preserves_existing_stock(self):
        api = self.multi_source_api()
        preset, theme = load_preset('electronics')
        seed(api, preset, theme, publish=True)
        expected = {(p['id'], source) for p in api.products for source in ('default-source', 'backup-source')}
        global_source = next(s['id'] for s in api.sources if s.get('code') == 'demo-global')
        expected.update((p['id'], global_source) for p in api.products)
        self.assertEqual(set(api.source_items), expected)
        stock_by_sku = {p['sku']: p['stock'] for p in preset['products']}
        sku_by_id = {p['id']: p['sku'] for p in api.products}
        self.assertTrue(all(item['quantity'] == (1000 if source == global_source
                                                  else stock_by_sku[sku_by_id[product]])
                            for (product, source), item in api.source_items.items()))
        product = api.products[0]['id']
        api.source_items[(product, 'default-source')].update(quantity=0, status='out_of_stock', notify_stock_qty=7)
        api.source_items[(product, 'backup-source')].update(quantity=35, reserved=30)
        before = copy.deepcopy(api.source_items)
        writes = len(api.writes)
        seed(api, preset, theme, publish=True)
        self.assertEqual(api.source_items, before)
        self.assertEqual(len(api.writes), writes)

    def test_partial_multi_source_failure_resumes_without_duplicate_products_or_stock_reset(self):
        api = self.multi_source_api()
        preset, theme = load_preset('grocery')
        retired = dict(preset['retired_products'][0], id='retired', name='Old demo', price='1.00', currency='USD',
                       unit='pack', description='Original', category_id='old-category', media_ids=[],
                       attributes={}, active=True, in_stock=True)
        api.categories = [{'id': 'old-category', 'slug': preset['retired_categories'][0]}]
        api.products = [retired]
        original = api.call
        def interrupt_after_commit(method, path, body=None):
            result = original(method, path, body)
            if method == 'PUT' and path.endswith('/sources'):
                raise RuntimeError('Connection lost after committed stock write')
            return result
        with patch.object(api, 'call', side_effect=interrupt_after_commit):
            with self.assertRaisesRegex(RuntimeError, 'Connection lost'):
                seed(api, preset, theme, publish=True, preserve_theme=True)
        self.assertTrue(retired['active'])
        self.assertEqual(len(api.products), 51)
        self.assertEqual(len(api.source_items), 1)
        key = next(iter(api.source_items))
        api.source_items[key].update(quantity=31, reserved=9)
        before = copy.deepcopy(api.source_items[key])
        product_ids = [p['id'] for p in api.products]
        uploads = [w for w in api.writes if w[0] == 'upload']
        result = seed(api, preset, theme, publish=True, preserve_theme=True)
        self.assertEqual(result['created_products'], 0)
        self.assertEqual(result['retired_products'], 1)
        self.assertEqual(product_ids, [p['id'] for p in api.products])
        self.assertEqual(uploads, [w for w in api.writes if w[0] == 'upload'])
        self.assertEqual(api.source_items[key], before)
        self.assertEqual(len(api.source_items), 150)
        self.assertTrue(verify_seed(api, preset, preserve_theme=True)['seeded'])

    def test_no_enabled_default_source_stops_before_catalog_writes(self):
        api = MemoryAPI()
        api.sources[0]['is_enabled'] = False
        with self.assertRaisesRegex(ValueError, 'at least one enabled source'):
            seed(api, *load_preset('grocery'), publish=True, preserve_theme=True)
        self.assertEqual(api.writes, [])

    def test_missing_source_assignment_information_stops_before_stock_writes(self):
        api = MemoryAPI()
        original = api.call
        def old_contract(method, path, body=None):
            result = original(method, path, body)
            if method == 'GET' and path.endswith('/sources') and path != '/v1/admin/inventory/sources':
                for item in result:
                    item.pop('is_assigned')
            return result
        with patch.object(api, 'call', side_effect=old_contract):
            with self.assertRaisesRegex(ValueError, 'is_assigned support'):
                seed(api, *load_preset('electronics'), publish=True)
        self.assertEqual(api.source_items, {})

    def test_grocery_matches_every_white_background_image_and_thumbnail(self):
        preset, _ = load_preset('grocery')
        manifest = json.loads((ROOT / 'commerce-assets/demo/Grocery-Items/manifest.json').read_text())
        self.assertEqual(len(preset['products']), 50)
        self.assertEqual(len(preset['categories']), 8)
        self.assertEqual({p['images'][0] for p in preset['products']}, {'Grocery-Items/' + i['file'] for i in manifest['items']})
        self.assertEqual({p['thumbnail'] for p in preset['products']}, {'Grocery-Items/' + i['thumbnail'] for i in manifest['items']})
        self.assertTrue({p['sku'] for p in preset['products']}.isdisjoint({p['sku'] for p in preset['retired_products']}))
        self.assertEqual({c['slug'] for c in preset['categories']}, {p['category'] for p in preset['products']})

    def test_grocery_migration_retires_old_products_and_is_repeatable(self):
        api = MemoryAPI()
        preset, theme = load_preset('grocery')
        api.categories = [{'id': 'old-category', 'slug': preset['retired_categories'][0]}]
        api.products = [dict(p, id='old-' + p['sku'], name='Previous product', price='7.00', currency='USD',
                             unit='pack', description='Original', category_id='old-category', media_ids=['old-image'],
                             attributes={}, active=True, in_stock=True) for p in preset['retired_products']]
        before = copy.deepcopy(api.products)
        result = seed(api, preset, theme, publish=True, preserve_theme=True)
        self.assertEqual(result['created_products'], 50)
        self.assertEqual(result['retired_products'], 50)
        self.assertEqual(len(api.products), 100)
        for old, current in zip(before, api.products):
            self.assertEqual(current, {**old, 'active': False})
        self.assertTrue(all(p['media_ids'] and p['attributes'].get('demo-thumbnail') for p in api.products[50:]))
        self.assertTrue(verify_seed(api, preset, preserve_theme=True)['seeded'])
        writes = len(api.writes)
        result = seed(api, preset, theme, publish=True, preserve_theme=True)
        self.assertEqual(result['created_products'], 0)
        self.assertEqual(result['retired_products'], 0)
        self.assertEqual(len(api.writes), writes)
        api.products[0]['active'] = True
        self.assertFalse(verify_seed(api, preset, preserve_theme=True)['seeded'])

    def test_grocery_rejects_unrecognized_or_spoofed_retired_skus_before_writes(self):
        preset, theme = load_preset('grocery')
        for product in ({'sku': 'REAL-PRODUCT', 'slug': 'merchant'}, {**preset['retired_products'][0], 'slug': 'merchant'}):
            api = MemoryAPI()
            api.products = [product]
            with self.assertRaisesRegex(ValueError, 'another catalog'):
                seed(api, preset, theme, publish=True, preserve_theme=True)
            self.assertEqual(api.writes, [])

    def test_grocery_upload_failure_keeps_old_products_active(self):
        api = MemoryAPI()
        preset, theme = load_preset('grocery')
        api.products = [{**preset['retired_products'][0], 'id': 'old', 'active': True}]
        with patch.object(api, 'upload', side_effect=RuntimeError('Upload interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'Upload interrupted'):
                seed(api, preset, theme, publish=True, preserve_theme=True)
        self.assertTrue(api.products[0]['active'])
        self.assertFalse(any(path.endswith('/old') for _, path in api.writes))

    def test_preserve_theme_seeds_catalog_without_writing_themes_or_rules(self):
        for targeting, default in ((False, True), (True, True), (True, False)):
            with self.subTest(targeting=targeting, default=default):
                api = MemoryAPI()
                api.themes = [{'id': 'existing', 'name': 'Existing storefront', 'owner_channel': 'storefront',
                               'published_version': 'live', 'revision': 7, 'configuration': {'custom': True}}]
                api.assignment.update(theme_id='existing' if default else None,
                                      rules=[{'id': 'rule', 'theme_id': 'existing'}] if targeting else [])
                before = copy.deepcopy((api.themes, api.assignment))
                preset, template = load_preset('electronics')
                result = seed(api, preset, template, publish=True, preserve_theme=True)
                self.assertEqual(result['created_products'], len(preset['products']))
                self.assertTrue(result['theme_preserved'])
                self.assertFalse(result['published_and_assigned'])
                self.assertEqual((api.themes, api.assignment), before)
                self.assertFalse(any('/themes' in path for _, path in api.writes))
                self.assertTrue(verify_seed(api, preset, preserve_theme=True)['seeded'])
                self.assertFalse(verify_seed(api, preset)['seeded'])
                writes = len(api.writes)
                seed(api, preset, template, publish=True, preserve_theme=True)
                self.assertEqual(len(api.writes), writes)

    def test_preserve_theme_publishes_for_a_new_unassigned_channel(self):
        api = MemoryAPI()
        preset, template = load_preset('electronics')
        result = seed(api, preset, template, publish=True, preserve_theme=True)
        self.assertTrue(result['published_and_assigned'])
        self.assertTrue(verify_seed(api, preset, preserve_theme=True)['seeded'])
        api.themes[0]['configuration'] = {'edited': True}
        before = copy.deepcopy((api.themes, api.assignment))
        writes = len(api.writes)
        seed(api, preset, template, publish=True, preserve_theme=True)
        self.assertEqual((api.themes, api.assignment), before)
        self.assertEqual(len(api.writes), writes)

    def test_preserved_theme_verification_requires_products_and_published_rule_targets(self):
        api = MemoryAPI()
        preset, template = load_preset('electronics')
        seed(api, preset, template, publish=True)
        api.assignment['rules'] = [{'id': 'rule', 'theme_id': 'missing'}]
        self.assertFalse(verify_seed(api, preset, preserve_theme=True)['seeded'])
        api.assignment['rules'] = []
        api.themes[0]['published_version'] = None
        self.assertFalse(verify_seed(api, preset, preserve_theme=True)['seeded'])
        api.themes[0]['published_version'] = 'live'
        api.products.pop()
        self.assertFalse(verify_seed(api, preset, preserve_theme=True)['seeded'])

    def test_preserve_theme_does_not_bypass_catalog_isolation(self):
        api = MemoryAPI()
        api.products = [{'sku': 'REAL-STORE-PRODUCT'}]
        with self.assertRaisesRegex(ValueError, 'another catalog'):
            seed(api, *load_preset('electronics'), publish=True, preserve_theme=True)
        self.assertEqual(api.writes, [])

    def test_explicit_publish_still_rejects_another_assignment_before_writes(self):
        api = MemoryAPI()
        api.assignment['theme_id'] = 'existing'
        with self.assertRaisesRegex(ValueError, 'another assignment'):
            seed(api, *load_preset('electronics'), publish=True)
        self.assertEqual(api.writes, [])

    def test_preserve_and_refresh_are_incompatible_before_writes(self):
        api = MemoryAPI()
        with self.assertRaisesRegex(ValueError, 'Cannot refresh'):
            seed(api, *load_preset('electronics'), publish=True, refresh_theme=True, preserve_theme=True)
        self.assertEqual(api.writes, [])

    def test_cli_apply_and_verify_preserve_existing_theme(self):
        spec = importlib.util.spec_from_file_location('storefront_seed_cli', ROOT / 'commerce-ops/scripts/demo/seed-demo-storefront.py')
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        api = MemoryAPI()
        api.themes = [{'id': 'existing', 'name': 'Existing storefront', 'owner_channel': 'storefront',
                       'published_version': 'live', 'revision': 7}]
        api.assignment['theme_id'] = 'existing'
        original = api.call
        def call(method, path, body=None):
            if '/auth/' in path:
                return {}
            return original(method, path, body)
        api.call = call
        for action in (['--apply', '--publish'], ['--verify']):
            with patch.object(cli, 'Client', return_value=api), \
                 patch.dict('os.environ', {'DEMO_ADMIN_EMAIL': 'demo@example.test', 'DEMO_ADMIN_PASSWORD': 'test-only'}), \
                 patch.object(sys, 'argv', ['seed-demo-storefront.py', 'electronics', *action, '--preserve-theme', '--api-base', 'https://example.test/api']), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                cli.main()
                result = json.loads(output.getvalue())
                self.assertTrue(result['theme_preserved'])
        self.assertTrue(result['seeded'])
        self.assertFalse(any('/themes' in path for _, path in api.writes))

    def test_palette_cli_skips_targeting_without_palette_writes(self):
        spec = importlib.util.spec_from_file_location('palette_seed_cli', ROOT / 'commerce-ops/scripts/demo/sync-grocery-palette.py')
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        from unittest.mock import Mock
        client = Mock()
        client.call.side_effect = [{}, [{'channel': 'storefront', 'rules': [{'theme_id': 'existing'}]}], {}]
        with patch.object(cli, 'Client', return_value=client), patch.object(cli, 'sync') as sync, \
             patch.dict('os.environ', {'DEMO_ADMIN_EMAIL': 'demo@example.test', 'DEMO_ADMIN_PASSWORD': 'test-only'}), \
             patch.object(sys, 'argv', ['sync-grocery-palette.py', '--apply', '--skip-if-targeted', '--api-base', 'https://example.test/api']), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(), 0)
            self.assertTrue(json.loads(output.getvalue())['skipped'])
            sync.assert_not_called()

    def test_electronics_is_isolated_repeatable_and_preserves_merchant_edits(self):
        preset, theme = load_preset('electronics')
        for other in ('grocery', 'jewelry'):
            other_preset, _ = load_preset(other)
            self.assertTrue({p['sku'] for p in preset['products']}.isdisjoint({p['sku'] for p in other_preset['products']}))
            with self.assertRaises(ValueError):
                assert_isolated(preset, other_preset['products'], [])
        api = MemoryAPI()
        result = seed(api, preset, theme, publish=True)
        self.assertEqual(result['created_products'], len(preset['products']))
        self.assertEqual(len(api.categories), len(preset['categories']))
        self.assertEqual(api.themes[0]['configuration']['tokens']['color.primary'], '#c8102e')
        api.products[0]['name'] = 'Merchant edit'
        writes = len(api.writes)
        self.assertEqual(seed(api, *load_preset('electronics'), publish=True)['created_products'], 0)
        self.assertEqual(len(api.writes), writes)
        self.assertEqual(api.products[0]['name'], 'Merchant edit')

    def test_electronics_spec_backfill_preserves_merchant_values(self):
        api = MemoryAPI()
        seed(api, *load_preset('electronics'), publish=True)
        api.products[0]['attributes'] = {'brand': 'Merchant brand'}
        api.products[0]['price'] = '777.00'
        seed(api, *load_preset('electronics'), publish=True)
        self.assertEqual(api.products[0]['attributes']['brand'], 'Merchant brand')
        self.assertEqual(api.products[0]['attributes']['storage'], '128 GB')
        self.assertEqual(api.products[0]['price'], '777.00')
        writes = len(api.writes)
        seed(api, *load_preset('electronics'), publish=True)
        self.assertEqual(len(api.writes), writes)

    def test_grocery_theme_preserves_default_structure_with_refined_palette(self):
        _,theme=load_preset('grocery')
        default=json.loads((ROOT/'commerce-api/theme-contract.json').read_text())['default']
        default['tokens'].update({'color.primary':'#054828','color.success':'#054828','color.surface':'#F1F4F0'})
        self.assertEqual(theme,default)
    def test_grocery_theme_can_be_explicitly_refreshed_without_replacing_products(self):
        api=MemoryAPI();preset,theme=load_preset('grocery');seed(api,preset,theme,True)
        api.products[0]['name']='Merchant edit'
        api.themes[0]['configuration']['tokens']['color.primary']='#146c43'
        before_versions=api.themes[0]['revision']
        result=seed(api,*load_preset('grocery'),publish=True,refresh_theme=True)
        self.assertTrue(result['theme_refreshed'])
        self.assertEqual(api.products[0]['name'],'Merchant edit')
        self.assertEqual(api.themes[0]['configuration']['tokens']['color.primary'],'#054828')
        self.assertGreater(api.themes[0]['revision'],before_versions)
    def test_fresh_loads_are_isolated(self):
        grocery,gtheme=load_preset('grocery');jewelry,jtheme=load_preset('jewelry')
        jewelry['products'][0]['name']='Edited';jtheme['tokens']['color.primary']='#ff0000'
        self.assertNotEqual(load_preset('jewelry')[0]['products'][0]['name'],'Edited')
        self.assertEqual(gtheme,load_preset('grocery')[1])
        self.assertTrue({p['sku'] for p in grocery['products']}.isdisjoint({p['sku'] for p in jewelry['products']}))
    def test_wrong_installation_refused_before_any_write(self):
        api=MemoryAPI();api.products=[{'sku':'REAL-STORE-PRODUCT'}]
        with self.assertRaisesRegex(ValueError,'another catalog'):seed(api,*load_preset('jewelry'),publish=True)
        self.assertEqual(api.writes,[])
    def test_category_only_contamination_rejected(self):
        p,_=load_preset('jewelry')
        with self.assertRaises(ValueError):assert_isolated(p,[],[{'slug':'fresh-produce'}])
    def test_seed_is_idempotent_and_preserves_edits(self):
        api=MemoryAPI();p,t=load_preset('jewelry');first=seed(api,p,t,True)
        self.assertEqual(first['created_products'],51)
        self.assertEqual(len(api.families),1)
        config=api.themes[0]['configuration'];self.assertFalse('asset:' in json.dumps(config));self.assertFalse('category:' in json.dumps(config))
        api.products[0]['name']='Merchant edit';config['tokens']['color.primary']='#123456'
        writes=len(api.writes);second=seed(api,*load_preset('jewelry'),publish=True)
        self.assertEqual(second['created_products'],0);self.assertEqual(len(api.writes),writes)
        self.assertEqual(api.products[0]['name'],'Merchant edit');self.assertEqual(config['tokens']['color.primary'],'#123456')
    def test_resolving_does_not_mutate_template(self):
        _,theme=load_preset('jewelry');before=copy.deepcopy(theme)
        media={};cats={}
        from demo_presets import transform
        def collect(v):
            if v.startswith('asset:'):media[v[6:]]=str(uuid.uuid4())
            if v.startswith(('category:','category-link:')):cats[v.split(':',1)[1]]={'id':str(uuid.uuid4())}
            return v
        transform(theme,collect);result=resolve_theme(theme,media,cats)
        self.assertEqual(theme,before);self.assertNotEqual(result,theme)
    def test_preserves_targeting_rules_before_writes(self):
        api=MemoryAPI();api.assignment['rules']=[{'id':'existing'}]
        with self.assertRaisesRegex(ValueError,'another assignment'):seed(api,*load_preset('jewelry'),publish=True)
        self.assertEqual(api.writes,[])
    def test_asset_traversal_rejected(self):
        with self.assertRaises(ValueError):asset_path('../../README.md')
    def test_every_family_uses_distinct_supported_sizes(self):
        p,_=load_preset('jewelry');by_sku={x['sku']:x for x in p['products']}
        for f in p['families']:
            self.assertEqual({by_sku[s]['attributes']['size'] for s in f['children']},{'6','7','8'})


if __name__=='__main__':unittest.main()
