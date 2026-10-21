"""Demo distribution and safe rerun checks without external services."""
import importlib.util
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'commerce-assets/demo'))
spec = importlib.util.spec_from_file_location('delivery_seed', ROOT / 'commerce-assets/demo/seed-delivery-areas.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class DeliveryUploadTests(unittest.TestCase):
    def test_uploaded_sites_are_loaded(self):
        sites = [{'name': 'Uploaded Demo', 'latitude': 30.5, 'longitude': 31.5}]
        with patch.object(Path, 'read_text', return_value=json.dumps(sites)):
            self.assertEqual(seed.load_sites('/uploaded/areas.json'), sites)

    def test_rejects_bad_coordinates_empty_lists_and_duplicate_names(self):
        valid = {'name': 'Maadi, Cairo (Demo)', 'latitude': 30, 'longitude': 31}
        for payload in ([], {}, [valid, valid], [{**valid, 'latitude': None}], [{**valid, 'latitude': True}], [{**valid, 'longitude': 181}], [{**valid, 'latitude': '30'}]):
            with self.subTest(payload=payload), patch.object(Path, 'read_text', return_value=json.dumps(payload)), self.assertRaises(ValueError):
                seed.load_sites('/uploaded/areas.json')


class FakeClient:
    def __init__(self):
        self.sources = [{'id': 'default-source', 'code': 'default', 'is_enabled': True}]
        self.stocks = [{'id': 'default-stock', 'code': 'default', 'is_default': True,
                        'sources': [{'source_id': 'default-source', 'priority': 0}]}]
        self.areas = []
        self.items = {}
        self.writes = 0
        self.calls = []

    def call(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        inventory = '/v1/admin/inventory/'
        if path == '/v1/catalog/categories':
            return []
        for suffix, rows in [('sources', self.sources), ('stocks', self.stocks), ('delivery-areas', self.areas)]:
            if path == inventory + suffix:
                if method == 'GET':
                    return rows.copy()
                self.writes += 1
                row = dict(body, id=f'{suffix}-{len(rows)}')
                rows.append(row)
                return row
        if path.startswith(inventory + 'delivery-areas/') and method == 'PUT':
            self.writes += 1
            row = next(x for x in self.areas if x['id'] == path.rsplit('/', 1)[1])
            row.update(body)
            return row
        if path.endswith('/sources'):
            if method == 'GET':
                return [dict(source_id=s['id'], is_assigned=s['id'] in self.items,
                             quantity=self.items.get(s['id'], 0)) for s in self.sources]
            self.writes += 1
            self.items[body['source_id']] = body['quantity']
            return {}
        raise AssertionError((method, path))


class DeliveryTests(unittest.TestCase):
    def test_distribution_is_stable_varied_and_covers_every_city(self):
        plans = [seed.quantities('grocery', f'SKU-{i}') for i in range(100)]
        self.assertEqual(plans, [seed.quantities('grocery', f'SKU-{i}') for i in range(100)])
        for plan in plans:
            self.assertTrue(all(primary > 0 and backup > 0 for primary, backup in plan))
        for i in range(len(seed.SITES)):
            self.assertTrue(any(sum(p[i]) > 0 for p in plans))
            self.assertGreater(len({p[i] for p in plans}), 1)

    def test_network_spans_bundled_governorates_and_uses_known_city_coordinates(self):
        directory = ROOT / 'commerce-web/apps/storefront/public/data/delivery/eg'
        states = json.loads((directory / 'index.json').read_text())['states']
        self.assertEqual({s['code'] for s in states}, {s['governorate_code'] for s in seed.SITES})
        for site in seed.SITES:
            if site.get('geonames_id'):
                city = next(c for c in json.loads((directory / (site['governorate_code'] + '.json')).read_text()) if c['id'] == site['geonames_id'])
                self.assertEqual((site['latitude'], site['longitude']), (city['latitude'], city['longitude']))
        plan = seed.preview('grocery')
        self.assertEqual((plan['area_count'], plan['stock_count'], plan['source_count'], plan['governorates']), (43, 43, 53, 27))
        self.assertEqual(len({s['code'] for s in plan['sources']}), 53)
        for stock in plan['stocks']:
            self.assertEqual([s['priority'] for s in stock['sources']], [0, 100])
        self.assertEqual(len({s['sources'][1]['source_code'] for s in plan['stocks']}), 10)

    def test_quantities_survive_site_reordering_and_follow_store_profiles(self):
        for store in seed.PROFILES:
            original = dict(zip([seed.code(s) for s in seed.SITES], seed.quantities(store, 'SKU')))
            with patch.object(seed, 'SITES', list(reversed(seed.SITES))):
                reordered = dict(zip([seed.code(s) for s in seed.SITES], seed.quantities(store, 'SKU')))
            self.assertEqual(original, reordered)
            for primary, backup in original.values():
                self.assertTrue(seed.PROFILES[store]['primary'][0] <= primary <= seed.PROFILES[store]['primary'][1])
                self.assertTrue(seed.PROFILES[store]['backup'][0] <= backup <= seed.PROFILES[store]['backup'][1])

    def test_expansion_adds_missing_areas_without_changing_custom_configuration(self):
        c = self.custom_client()
        original = copy.deepcopy((c.areas[0], c.stocks[0], c.sources[0]))
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'grocery', expand_coverage=True)
            self.assertEqual((c.areas[0], c.stocks[0], c.sources[0]), original)
            self.assertEqual(len(c.areas), 44)
            before = c.writes
            seed.seed(c, 'grocery', expand_coverage=True)
            self.assertEqual(c.writes, before)

    def test_interrupted_network_run_recovers_without_duplicate_sources_or_stock(self):
        c = FakeClient()
        original = c.call
        def interrupt(method, path, body=None):
            result = original(method, path, body)
            if method == 'PUT':
                raise RuntimeError('Connection lost after committed inventory')
            return result
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            with patch.object(c, 'call', side_effect=interrupt), self.assertRaisesRegex(RuntimeError, 'Connection lost'):
                seed.seed(c, 'jewelry')
            self.assertEqual(len(c.areas), 0)
            seed.seed(c, 'jewelry')
        self.assertEqual((len(c.sources), len(c.stocks), len(c.areas)), (54, 44, 43))
        self.assertEqual(len(c.items), 53)

    def test_configurable_parent_and_inactive_products_do_not_get_physical_stock(self):
        c = FakeClient()
        preset = {'families': [{'parent': 'PARENT', 'children': ['CHILD']}]}
        products = [{'id': 'parent', 'sku': 'PARENT'}, {'id': 'p', 'sku': 'CHILD'}, {'id': 'inactive', 'sku': 'INACTIVE', 'active': False}]
        with patch.object(seed, 'load_preset', return_value=(preset, {})), \
             patch.object(seed, 'list_products', return_value=products), patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'jewelry')
        self.assertFalse(any('/parent/' in path or '/inactive/' in path for _, path, _ in c.calls))

    def test_rerun_replenishes_demo_stock_and_preserves_positive_inventory(self):
        c = FakeClient()
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'grocery')
            self.assertEqual((len(c.sources), len(c.stocks), len(c.areas)), (54, 44, 43))
            before = c.writes
            seed.seed(c, 'grocery')
            self.assertEqual(c.writes, before)
            c.items = {k: 0 for k in c.items}  # Demo stock is intentionally replenished.
            seed.seed(c, 'grocery')
            self.assertEqual(c.writes, before + 53)
            self.assertTrue(all(q > 0 for q in c.items.values()))

    def test_replenishment_keeps_reserved_units_and_adds_available_stock(self):
        c = FakeClient()
        original = c.call
        def call(method, path, body=None):
            result = original(method, path, body)
            if method == 'GET' and path.endswith('/sources') and '/inventory/p/' in path:
                return [dict(item, reserved=100) for item in result]
            return result
        c.call = call
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'grocery')
        self.assertTrue(all(q > 100 for q in c.items.values()))

    def test_legacy_area_migration_retains_saved_location_and_geometry(self):
        c = FakeClient()
        old = seed.area_input(seed.SITES[0], 'default-stock', 17)
        old.update(id='saved-area', is_active=False)
        c.areas = [old.copy()]
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'grocery')
        migrated = c.areas[0]
        for key in ('id', 'boundary', 'priority', 'is_active'):
            self.assertEqual(old[key], migrated[key])
        self.assertNotEqual(old['stocks'], migrated['stocks'])

    def custom_client(self):
        c = FakeClient()
        area = seed.area_input(seed.SITES[0], 'default-stock', 77)
        area.update(id='saved-area', name='Cairo delivery zone')
        c.areas = [area]
        return c

    def run_custom_seed(self, c, retired=False):
        preset = {'families': [], 'retired_products': [{'sku': 'OLD'}] if retired else []}
        products = [{'id': 'p', 'sku': 'SKU'}] + ([{'id': 'retired', 'sku': 'OLD'}] if retired else [])
        with patch.object(seed, 'load_preset', return_value=(preset, {})), \
             patch.object(seed, 'list_products', return_value=products), \
             patch.object(seed, 'assert_isolated'):
            seed.seed(c, 'grocery')

    def test_custom_coverage_is_preserved_and_existing_sources_are_stocked_repeatably(self):
        c = self.custom_client()
        # Mixed existing demo/custom coverage shares a stock; it must remain intact.
        c.areas.append(dict(seed.area_input(seed.SITES[1], 'default-stock', 10), id='demo-area'))
        before = copy.deepcopy((c.areas, c.stocks, c.sources))
        self.run_custom_seed(c, retired=True)
        self.assertEqual((c.areas, c.stocks, c.sources), before)
        self.assertEqual(c.writes, 1)
        self.assertGreater(c.items['default-source'], 0)
        self.assertFalse(any('/retired/' in path for _, path, _ in c.calls))
        self.assertTrue(all(path == '/v1/admin/inventory/p/sources' for method, path, _ in c.calls if method != 'GET'))
        self.run_custom_seed(c)
        self.assertEqual(c.writes, 1)

    def test_custom_coverage_ignores_disabled_unlinked_and_inactive_sources(self):
        c = self.custom_client()
        c.sources += [dict(id='disabled', code='disabled', is_enabled=False),
                      dict(id='inactive', code='inactive', is_enabled=True),
                      dict(id='unlinked', code='unlinked', is_enabled=True)]
        c.stocks[0]['sources'].append({'source_id': 'disabled', 'priority': 1})
        c.stocks.append(dict(id='inactive-stock', code='inactive', is_default=False,
                             sources=[{'source_id': 'inactive', 'priority': 0}]))
        c.areas.append(dict(seed.area_input(seed.SITES[1], 'inactive-stock', 10), id='inactive-area', is_active=False))
        self.run_custom_seed(c)
        self.assertEqual(set(c.items), {'default-source'})
        self.assertFalse(c.sources[1]['is_enabled'])
        self.assertFalse(c.areas[1]['is_active'])

    def test_custom_coverage_validates_all_links_before_inventory_writes(self):
        for broken in ('stock', 'source', 'disabled', 'empty'):
            with self.subTest(broken=broken):
                c = self.custom_client()
                if broken == 'stock': c.areas[0]['stocks'][0]['stock_id'] = 'missing'
                if broken == 'source': c.stocks[0]['sources'][0]['source_id'] = 'missing'
                if broken == 'disabled': c.sources[0]['is_enabled'] = False
                if broken == 'empty': c.areas[0]['stocks'] = []
                with self.assertRaisesRegex(RuntimeError, 'missing|no enabled source'):
                    self.run_custom_seed(c)
                self.assertEqual(c.writes, 0)

    def test_custom_coverage_replenishment_preserves_reservations_and_threshold(self):
        c = self.custom_client()
        c.items['default-source'] = 100
        original = c.call
        def call(method, path, body=None):
            result = original(method, path, body)
            if method == 'GET' and path == '/v1/admin/inventory/p/sources':
                return [dict(item, reserved=100, notify_stock_qty=12) for item in result]
            return result
        c.call = call
        self.run_custom_seed(c)
        self.assertGreater(c.items['default-source'], 100)
        body = next(body for method, _, body in c.calls if method == 'PUT')
        self.assertEqual(body['notify_stock_qty'], 12)
        self.run_custom_seed(c)
        self.assertEqual(c.writes, 1)

    def test_all_inactive_custom_coverage_is_left_unchanged(self):
        c = self.custom_client()
        c.areas[0]['is_active'] = False
        self.run_custom_seed(c)
        self.assertEqual(c.writes, 0)

    def test_custom_coverage_still_rejects_non_demo_catalog_before_writes(self):
        c = self.custom_client()
        preset = {'families': [], 'products': [{'sku': 'DEMO'}], 'categories': []}
        with patch.object(seed, 'load_preset', return_value=(preset, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'merchant', 'sku': 'REAL', 'slug': 'real'}]):
            with self.assertRaisesRegex(ValueError, 'another catalog'):
                seed.seed(c, 'grocery')
        self.assertEqual(c.writes, 0)

    def test_custom_coverage_resumes_after_committed_stock_write(self):
        c = self.custom_client()
        original = c.call
        def interrupt(method, path, body=None):
            result = original(method, path, body)
            if method == 'PUT': raise RuntimeError('Connection lost after write')
            return result
        with patch.object(c, 'call', side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, 'Connection lost'):
                self.run_custom_seed(c)
        self.run_custom_seed(c)
        self.assertEqual(c.writes, 1)

    def test_source_assignment_contract_is_still_required(self):
        c = self.custom_client()
        original = c.call
        def old_contract(method, path, body=None):
            result = original(method, path, body)
            if path == '/v1/admin/inventory/p/sources':
                for item in result: item.pop('is_assigned')
            return result
        c.call = old_contract
        with patch.object(seed, 'load_preset', return_value=({'families': []}, {})), \
             patch.object(seed, 'list_products', return_value=[{'id': 'p', 'sku': 'SKU'}]), \
             patch.object(seed, 'assert_isolated'):
            with self.assertRaisesRegex(RuntimeError, 'is_assigned'):
                seed.seed(c, 'grocery')
        self.assertEqual(c.writes, 0)


if __name__ == '__main__':
    unittest.main()
