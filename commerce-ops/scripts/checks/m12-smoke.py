"""Local M12 5+3 split demo. Keeps synthetic order history and a private UI fixture.

Uses a dedicated source pool and, when M13 zones exist, a tiny synthetic delivery area.
With no zones, temporarily selects the demo pool as default and restores the original pool.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import http.cookiejar
import json
import os
import subprocess
import urllib.request
import uuid
from catalog_support import Client, ROOT

admin = Client()
http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
token = None
pin = {'latitude': -61.12345, 'longitude': -133.12345}

def call(method, path, body=None):
    headers = {'Content-Type': 'application/json', 'X-Commerce-Request': '1',
               'x-delivery-context': '1', 'x-delivery-latitude': str(pin['latitude']),
               'x-delivery-longitude': str(pin['longitude'])}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request('http://localhost:5173/api' + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with http.open(request, timeout=30) as response:
        return json.load(response)

suffix = uuid.uuid4().hex[:8]
original = next(s for s in admin.call('GET', '/v1/admin/inventory/stocks') if s['is_default'])
areas = admin.call('GET', '/v1/admin/inventory/delivery-areas')
sources = []
stock = area = product = category = order = None
default_changed = False
try:
    for label in ['A', 'B']:
        body = {'code': 'm12_' + label.lower() + '_' + suffix, 'name': 'M12 Warehouse ' + label + ' ' + suffix,
                'is_enabled': True, 'address': 'Synthetic M12 test location', **pin,
                'contact_name': '', 'contact_phone': '', 'priority': len(sources)}
        sources.append(admin.call('POST', '/v1/admin/inventory/sources', body))
    pool = {'code': 'm12_' + suffix, 'name': 'M12 demo stock ' + suffix, 'is_default': not bool(areas),
            'sources': [{'source_id': s['id'], 'priority': n * 10} for n, s in enumerate(sources)]}
    stock = admin.call('POST', '/v1/admin/inventory/stocks', pool)
    default_changed = pool['is_default']
    if areas:
        area_body = {'name': 'M12 isolated demo ' + suffix, 'center_lat': pin['latitude'],
                     'center_lng': pin['longitude'], 'radius_km': .05, 'priority': -100000,
                     'is_active': True, 'stocks': [{'stock_id': stock['id'], 'priority': 0}]}
        area = admin.call('POST', '/v1/admin/inventory/delivery-areas', area_body)
    category = admin.call('POST', '/v1/admin/catalog/categories', {'name': 'M12 test', 'slug': 'm12-' + suffix, 'parent_id': None})
    product = admin.call('POST', '/v1/admin/catalog/products', {'sku': 'M12-' + suffix, 'slug': 'm12-' + suffix,
        'name': 'M12 split-order apples', 'description': 'Synthetic multi-source checkout fixture',
        'price': '2.50', 'currency': 'USD', 'unit': 'each', 'category_id': category['id'],
        'attributes': {}, 'media_ids': [], 'active': True, 'in_stock': True})
    for source, quantity in zip(sources, [5, 20]):
        admin.call('PUT', '/v1/admin/inventory/' + product['id'] + '/sources', {
            'source_id': source['id'], 'quantity': quantity, 'status': 'in_stock',
            'notify_stock_qty': 2, 'reason': 'M12 smoke fixture'})
    credentials = {'identifier': 'm12-' + suffix + '@example.test', 'password': uuid.uuid4().hex}
    call('POST', '/v1/customer/auth/register', credentials)
    token = call('POST', '/v1/customer/auth/login', credentials)['access_token']
    logs = subprocess.check_output(['docker', 'compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'logs', '--since', '2m', '--no-log-prefix', 'api-gateway'], cwd=ROOT, text=True)
    codes = []
    for line in logs.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get('target') == 'local_notifications' and row.get('fields', {}).get('identifier') == credentials['identifier']:
            codes.append(row['fields']['code'])
    assert codes, 'Development verification code unavailable'
    call('POST', '/v1/customer/auth/verify', {'identifier': credentials['identifier'], 'token': codes[-1]})
    location = call('POST', '/v1/customer/locations', {'label': 'home', **pin, 'formatted_address': 'Synthetic M12 test destination', 'is_default': True})
    call('POST', '/v1/cart', {})
    cart = call('POST', '/v1/cart/items', {'product_id': product['id'], 'quantity': 8})
    assert cart['fully_reserved']
    items = admin.call('GET', '/v1/admin/inventory/' + product['id'] + '/sources')
    assert {i['source_id']: i['reserved'] for i in items if i['source_id'] in {s['id'] for s in sources}} == {sources[0]['id']: 5, sources[1]['id']: 3}
    quote = call('POST', '/v1/customer/checkout/quote', {'location_id': location['id']})
    placement = {'quote_id': quote['id'], 'idempotency_key': str(uuid.uuid4())}
    order = call('POST', '/v1/customer/checkout/place', placement)
    assert call('POST', '/v1/customer/checkout/place', placement)['order']['id'] == order['order']['id']
    assert len(order['shipments']) == 2
    allocation = {s['shipment']['source_id']: s['items'][0]['quantity'] for s in order['shipments']}
    assert allocation == {sources[0]['id']: 5, sources[1]['id']: 3}
    oid = order['order']['id']
    for status in ['confirmed', 'fulfilling']:
        admin.call('POST', '/v1/admin/orders/' + oid + '/status', {'status': status, 'reason': 'M12 smoke'})
    for n, dispatch in enumerate(order['shipments']):
        sid = dispatch['shipment']['id']
        order = admin.call('POST', '/v1/admin/orders/' + oid + '/dispatch', {
            'shipment_id': sid, 'tracking_reference': 'M12-' + suffix + '-' + str(n + 1), 'reason': 'M12 independent dispatch'})
        order = admin.call('POST', '/v1/admin/shipments/' + sid + '/status', {'status': 'delivered', 'reason': 'M12 synthetic delivery'})
        assert order['order']['status'] == ('shipped' if n == 0 else 'delivered')
    customer_view = call('GET', '/v1/customer/orders/' + oid)
    assert len(customer_view['shipments']) == 2
    assert all(s['shipment']['status'] == 'delivered' for s in customer_view['shipments'])
    assert len({s['shipment']['tracking_reference'] for s in customer_view['shipments']}) == 2
    assert customer_view['items'][0]['name'] == 'M12 split-order apples'
    fixture = ROOT / '.local/m12-ui-fixture.json'
    with os.fdopen(os.open(fixture, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as out:
        json.dump({'order_id': oid, 'order_number': order['order']['number'], 'credentials': credentials,
                   'source_ids': [s['id'] for s in sources], 'stock_id': stock['id'], 'product_id': product['id']}, out)
    print('PASS: live reservation 5+3, idempotent checkout, two independent dispatches, partial/final delivery and customer tracking. Order #' + str(order['order']['number']))
finally:
    # No deletion of order/source history. The synthetic product is removed so the UI also
    # demonstrates that order details and tracking remain readable after catalog deletion.
    if token and product:
        call('DELETE', '/v1/cart/items/' + product['id'])
    if order and order['order']['status'] in ['placed', 'confirmed', 'fulfilling']:
        admin.call('POST', '/v1/admin/orders/' + order['order']['id'] + '/status', {'status': 'cancelled', 'reason': 'M12 fixture cleanup'})
    if product:
        for source in sources:
            admin.call('PUT', '/v1/admin/inventory/' + product['id'] + '/sources', {
                'source_id': source['id'], 'quantity': 0, 'status': 'out_of_stock',
                'notify_stock_qty': 0, 'reason': 'M12 fixture cleanup'})
        admin.call('DELETE', '/v1/admin/catalog/products/' + product['id'])
    if category:
        admin.call('DELETE', '/v1/admin/catalog/categories/' + category['id'])
    if area:
        admin.call('PUT', '/v1/admin/inventory/delivery-areas/' + area['id'], {**area_body, 'is_active': False})
    if default_changed:
        admin.call('PUT', '/v1/admin/inventory/stocks/' + original['id'], {k: original[k] for k in ['code', 'name', 'is_default', 'sources']})
    for source in sources:
        admin.call('PUT', '/v1/admin/inventory/sources/' + source['id'], {**{k: v for k, v in source.items() if k != 'id'}, 'is_enabled': False})
