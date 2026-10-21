"""The enrichment demo can be repeated without replacing merchant data or decisions."""
import copy
import importlib.util
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlparse

spec = importlib.util.spec_from_file_location('enrichment_seed', Path(__file__).resolve().parents[1] / 'seed-catalog-enrichment.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class FakeClient:
    def __init__(self):
        self.products = [dict(id='merchant', sku='NORMAL', slug='normal', active=True, attributes={'brand': 'Original'})]
        self.definitions, self.sets, self.suggestions, self.writes = [], [], [], []

    def call(self, method, url, body=None):
        path, query = urlparse(url).path, parse_qs(urlparse(url).query)
        if method != 'GET':
            self.writes.append((method, path, copy.deepcopy(body)))
        if path.endswith('/attribute-definitions'):
            if method == 'POST':
                self.definitions.append(copy.deepcopy(body))
                return body
            return self.definitions
        if path.endswith('/attribute-sets'):
            if method == 'POST':
                self.sets.append(copy.deepcopy(body))
                return body
            return self.sets
        if path.endswith('/catalog/categories'):
            return [dict(id='category')]
        if path.endswith('/catalog/products'):
            if method == 'POST':
                product = dict(copy.deepcopy(body), id=body['sku'])
                self.products.append(product)
                return copy.deepcopy(product)
            offset = int(query.get('offset', [0])[0])
            return copy.deepcopy(self.products[offset:offset+50])
        if path.endswith('/enrichment') and method == 'POST':
            product_id = path.split('/')[-2]
            product = next(p for p in self.products if p['id'] == product_id)
            result = []
            for definition in self.definitions:
                if definition['attribute_code'] in product['attributes']:
                    continue
                suggestion_id = product_id + ':' + definition['id']
                suggestion = next((s for s in self.suggestions if s['id'] == suggestion_id), None)
                if not suggestion:
                    suggestion = dict(id=suggestion_id, product_id=product_id, definition_id=definition['id'], status='pending')
                    self.suggestions.append(suggestion)
                result.append(copy.deepcopy(suggestion))
            return result
        if '/enrichment/' in path and method == 'PUT':
            suggestion = next(s for s in self.suggestions if s['id'] == path.split('/')[-1])
            suggestion['status'] = 'approved' if body['approve'] else 'rejected'
            if body['approve']:
                product = next(p for p in self.products if p['id'] == suggestion['product_id'])
                definition = next(d for d in self.definitions if d['id'] == suggestion['definition_id'])
                product['attributes'][definition['attribute_code']] = 'gifting'
            return copy.deepcopy(suggestion)
        if path.endswith('/enrichment') and method == 'GET':
            return [copy.deepcopy(s) for s in self.suggestions if s['product_id'] == query['product_id'][0]]
        raise AssertionError((method, url))


class SeedTests(unittest.TestCase):
    def test_reseed_preserves_products_and_review_decisions(self):
        client = FakeClient()
        merchant = copy.deepcopy(client.products[0])
        first = seed.seed(client)
        self.assertEqual(first['created_products'], 4)
        self.assertEqual(len(client.suggestions), 11)
        self.assertEqual(sum(s['status'] == 'pending' for s in client.suggestions), 9)
        self.assertTrue(all(not p['active'] and not p['in_stock'] for p in client.products[1:]))
        client.suggestions[0]['status'] = 'rejected'  # a reviewer has started testing
        before = copy.deepcopy((client.products, client.definitions, client.sets, client.suggestions))
        second = seed.seed(client)
        self.assertEqual(second['created_products'], 0)
        self.assertEqual(before, (client.products, client.definitions, client.sets, client.suggestions))
        self.assertEqual(client.products[0], merchant)

    def test_conflicting_demo_sku_stops_before_writes(self):
        client = FakeClient()
        client.products.append(dict(id='conflict', sku=seed.PRODUCTS[0]['sku'], slug='real-product', active=True))
        with self.assertRaisesRegex(RuntimeError, 'Demo product conflict'):
            seed.seed(client)
        self.assertEqual(client.writes, [])


if __name__ == '__main__':
    unittest.main()
