#!/usr/bin/env python3
"""Configure the explicitly requested grocery product-visit test, through admin APIs.
Run on EC2 with deploy/aws-deploy/activate-grocery-visitor-offer.sh after deployment.
--prepare only updates the existing inactive coupon to whole-order scope.
"""

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import socket
import sys
import uuid

PRODUCT = 'bc0cbb1d-8b21-45e2-8047-b5ac807260f3'
COUPON = '7617929f-c5d4-462c-a24b-a86afac34ca5'
CODE = 'TOMATO10'
ROOT = Path('/opt/rocento')
STATE = ROOT / 'deploy/ec2/grocery-visitor-offer.json'
PROMOTION_FIELDS = ('name', 'scope', 'kind', 'value', 'coupon_code', 'min_subtotal', 'skus', 'category_ids', 'customer_group', 'priority', 'active', 'starts_at', 'ends_at')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    os.environ['DEMO_SSL_CA_FILE'] = '/etc/nginx/ssl/rocento-origin.pem'
    resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda host, *a, **kw: resolve('127.0.0.1' if host == 'admin.rocento.com' else host, *a, **kw)
    sys.path.insert(0, str(ROOT / 'commerce-assets/demo'))
    from demo_seed import Client
    config = dict(line.split('=', 1) for line in (ROOT / 'deploy/ec2/bootstrap.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    client = Client('https://admin.rocento.com/api')
    client.call('POST', '/v1/admin/auth/login', {'email': config['GROCERY_ADMIN_EMAIL'], 'password': config['GROCERY_ADMIN_PASSWORD']})
    try:
        product = client.call('GET', '/v1/catalog/products/' + PRODUCT)
        if product['sku'] != 'DEMO-GRO-WHITE-007' or not product['active']:
            raise RuntimeError('The expected active grocery product was not found; no changes made.')
        coupon = next(p for p in client.call('GET', '/v1/admin/promotions') if p['id'] == COUPON)
        if coupon['coupon_code'] != CODE or coupon['kind'] != 'percentage' or float(coupon['value']) != 10 or coupon['scope'] != 'cart':
            raise RuntimeError('The prepared coupon has changed; preserving it.')
        payload = {key: coupon[key] for key in PROMOTION_FIELDS}
        payload.update(skus=[], category_ids=[], customer_group='all', min_subtotal='0')
        if args.prepare:
            if coupon['active']:
                raise RuntimeError('Coupon already active; prepare will not change it.')
            payload['name'] = 'TEST — Product visitors — 10% off whole order'
            client.call('PUT', '/v1/admin/promotions/' + COUPON, payload)
            print('Prepared TOMATO10: 10% off the whole merchandise subtotal, all customers, still inactive. No notification published.')
            return
        # An old gateway rejects the route. Do not activate a coupon until the
        # actual running API recognizes product-visit delivery (not just files).
        try:
            client.call('POST', '/v1/notifications/product-view', {'product': ''})
        except RuntimeError as exc:
            if 'HTTP 400' not in str(exc) or 'Provide a product ID or slug' not in str(exc):
                raise RuntimeError('Deploy the new notification code first, then rerun this command. No offer was activated.') from None
        else:
            raise RuntimeError('Unexpected product-visit API response; no offer activated.')
        with open(str(STATE) + '.lock', 'w') as lock:
            os.chmod(str(STATE) + '.lock', 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            if STATE.exists():
                publication_input = json.loads(STATE.read_text())
            else:
                if coupon['active']:
                    raise RuntimeError('Active coupon has no activation record; preserving it.')
                expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7)).isoformat()
                publication_input = {'title': 'Your 10% order discount', 'body': 'Thanks for visiting Tomatoes 1kg! Use code TOMATO10 at checkout for 10% off your whole order’s merchandise subtotal. Delivery and tax are excluded.', 'audience': 'all', 'area_ids': [], 'trigger_product_id': PRODUCT, 'cta_label': 'View cart', 'cta_path': '/cart', 'starts_at': None, 'expires_at': expires, 'idempotency_key': str(uuid.uuid4())}
                fd = os.open(STATE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w') as state:
                    json.dump(publication_input, state, ensure_ascii=False, indent=2)
            if dt.datetime.fromisoformat(publication_input['expires_at']) <= dt.datetime.now(dt.timezone.utc):
                raise RuntimeError('The seven-day test has expired. This command will not silently renew it.')
            if publication_input['trigger_product_id'] != PRODUCT or publication_input['audience'] != 'all':
                raise RuntimeError('Activation record differs; preserving it.')
            # Repeated activation is a no-op, and does not undo a withdrawal or
            # manually disabled coupon. A lost response retries the exact key.
            existing = []
            for offset in range(0, 100001, 100):
                page = client.call('GET', f'/v1/admin/marketing/notifications/publications?offset={offset}&limit=100')
                existing.extend(page['publications'])
                if offset + len(page['publications']) >= page['total']:
                    break
            match = next((p for p in existing if p.get('trigger_product_id') == PRODUCT and p['title'] == publication_input['title'] and dt.datetime.fromisoformat(p['expires_at'].replace('Z', '+00:00')) == dt.datetime.fromisoformat(publication_input['expires_at'])), None)
            if match:
                print(json.dumps({'coupon': CODE, 'coupon_active': coupon['active'], 'publication_id': match['id'], 'withdrawn': bool(match['withdrawn_at']), 'expires_at': match['expires_at'], 'changed': False}))
                return
            payload.update(name='TEST — Product visitors — 10% off whole order', active=True, starts_at=None, ends_at=publication_input['expires_at'])
            client.call('PUT', '/v1/admin/promotions/' + COUPON, payload)
            result = client.call('POST', '/v1/admin/marketing/notifications/publications', publication_input)
            if result.get('trigger_product_id') != PRODUCT or result['audience'] != 'all':
                raise RuntimeError('Publication did not retain its product targeting.')
            verified = next(p for p in client.call('GET', '/v1/admin/promotions') if p['id'] == COUPON)
            if not verified['active'] or verified['skus'] or verified['category_ids']:
                raise RuntimeError('Coupon verification failed.')
            print(json.dumps({'coupon': CODE, 'discount': '10% whole merchandise subtotal', 'audience': 'guests and signed-in product visitors', 'publication_id': result['id'], 'expires_at': result['expires_at'], 'active': True}))
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
