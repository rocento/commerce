import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('grocery_visitor_offer', Path(__file__).parents[1] / 'grocery-visitor-offer.py')
offer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(offer)


class Client:
    def __init__(self):
        self.calls = []
        self.ready = True
        self.lose_reply = False
        self.publications = []
        self.coupon = dict(id=offer.COUPON, name='Prepared', scope='cart', kind='percentage', value='10', coupon_code=offer.CODE, min_subtotal='0', skus=['DEMO-GRO-WHITE-007'], category_ids=[], customer_group='all', priority=0, active=False, starts_at=None, ends_at=None)

    def call(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if '/auth/' in path:
            return {}
        if path.startswith('/v1/catalog/products/'):
            return {'sku': 'DEMO-GRO-WHITE-007', 'active': True}
        if path == '/v1/admin/promotions':
            return [copy.deepcopy(self.coupon)]
        if path.startswith('/v1/admin/promotions/'):
            self.coupon.update(body)
            return copy.deepcopy(self.coupon)
        if path == '/v1/notifications/product-view':
            raise RuntimeError('HTTP 400: Provide a product ID or slug' if self.ready else 'HTTP 404: not found')
        if path.startswith('/v1/admin/marketing/notifications/publications?'):
            return {'publications': self.publications, 'total': len(self.publications)}
        if path == '/v1/admin/marketing/notifications/publications':
            publication = dict(body, id='publication-test', withdrawn_at=None)
            self.publications.append(publication)
            if self.lose_reply:
                self.lose_reply = False
                raise RuntimeError('Network response lost')
            return publication
        raise AssertionError(path)


class GroceryVisitorOfferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'deploy/ec2').mkdir(parents=True)
        (self.root / 'deploy/ec2/bootstrap.env').write_text('GROCERY_ADMIN_EMAIL=local@example.test\nGROCERY_ADMIN_PASSWORD=synthetic\n')
        self.client = Client()
        self.state = self.root / 'deploy/ec2/grocery-visitor-offer.json'

    def tearDown(self):
        self.temp.cleanup()

    def run_offer(self, *args):
        module = types.SimpleNamespace(Client=lambda base: self.client)
        with patch.object(offer, 'ROOT', self.root), patch.object(offer, 'STATE', self.state), patch.dict(sys.modules, {'demo_seed': module}), patch.object(sys, 'argv', ['offer', *args]), patch.object(socket, 'getaddrinfo', socket.getaddrinfo), contextlib.redirect_stdout(io.StringIO()):
            offer.main()

    def test_prepare_changes_scope_without_activating_or_publishing(self):
        self.run_offer('--prepare')
        self.assertFalse(self.client.coupon['active'])
        self.assertEqual(self.client.coupon['skus'], [])
        self.assertFalse(self.state.exists())
        self.assertEqual(self.client.publications, [])

    def test_old_gateway_blocks_activation_without_mutations(self):
        self.client.ready = False
        with self.assertRaisesRegex(RuntimeError, 'Deploy the new notification code first'):
            self.run_offer()
        self.assertFalse(self.client.coupon['active'])
        self.assertEqual(self.client.publications, [])
        self.assertFalse(self.state.exists())

    def test_activation_uses_whole_order_all_visitors_and_matched_expiry(self):
        self.run_offer()
        p = self.client.publications[0]
        self.assertTrue(self.client.coupon['active'])
        self.assertEqual(self.client.coupon['skus'], [])
        self.assertEqual(self.client.coupon['category_ids'], [])
        self.assertEqual(self.client.coupon['ends_at'], p['expires_at'])
        self.assertEqual(p['trigger_product_id'], offer.PRODUCT)
        self.assertEqual(p['audience'], 'all')
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.run_offer()
        self.assertEqual(len(self.client.publications), 1)

    def test_uncertain_response_reuses_publication_and_preserves_withdrawal(self):
        self.client.lose_reply = True
        with self.assertRaisesRegex(RuntimeError, 'Network response lost'):
            self.run_offer()
        self.client.publications[0]['withdrawn_at'] = '2026-10-05T12:00:00Z'
        self.client.coupon['active'] = False
        self.run_offer()
        self.assertEqual(len(self.client.publications), 1)
        self.assertFalse(self.client.coupon['active'])
        self.assertIsNotNone(self.client.publications[0]['withdrawn_at'])

    def test_expired_campaign_is_not_renewed(self):
        self.run_offer()
        value = json.loads(self.state.read_text())
        value['expires_at'] = '2000-01-01T00:00:00+00:00'
        self.state.write_text(json.dumps(value))
        count = len(self.client.calls)
        with self.assertRaisesRegex(RuntimeError, 'will not silently renew'):
            self.run_offer()
        self.assertFalse(any(method == 'PUT' for method, _, _ in self.client.calls[count:]))


if __name__ == '__main__':
    unittest.main()
