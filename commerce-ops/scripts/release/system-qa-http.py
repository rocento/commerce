"""Real HTTP commerce journeys on disposable providers; never uses merchant data.

Build api-gateway and seed-admin first. Requires Docker and local networking.
All email is captured from the console adapter; no external delivery occurs.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import concurrent.futures
import json
import urllib.error
import urllib.request
import uuid

from m14_support import Client, ROOT, Stack, run, wait_for


def rejected(status, action):
    try:
        action()
    except urllib.error.HTTPError as error:
        assert error.code == status, (error.code, error.read())
    else:
        raise AssertionError(f'Expected HTTP {status}')


def verified_customer(stack, client, identifier, password):
    credentials = {'identifier': identifier, 'password': password}
    created = client.call('POST', '/v1/customer/auth/register', credentials)
    assert not created['verified']

    def delivered_code():
        for line in (stack.directory / 'gateway.log').read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get('target') == 'local_notifications':
                fields = entry.get('fields', {})
                if fields.get('identifier') == identifier:
                    return fields.get('code')
        return None

    wait_for(delivered_code, 10)
    client.call('POST', '/v1/customer/auth/verify', {
        'identifier': identifier, 'token': delivered_code()})
    logged_in = client.call('POST', '/v1/customer/auth/login', credentials)
    client.token = logged_in['access_token']
    assert logged_in['customer']['verified']
    location = client.call('POST', '/v1/customer/locations', {
        'label': 'home', 'latitude': 30, 'longitude': 31,
        'formatted_address': 'Isolated HTTP QA address'})
    assert location['is_default']
    return created, location


def exercise(stack, password=None, seed_admin=None):
    password = password or uuid.uuid4().hex + '!'
    run([str(seed_admin or ROOT / 'commerce-api/rocento-api/target/debug/seed-admin'), '--email', 'http-qa-admin@example.test'],
        env=dict(stack.env, BOOTSTRAP_ADMIN_PASSWORD=password))
    admin, guest, other, anonymous = (Client(stack.url) for _ in range(4))
    admin.call('POST', '/v1/admin/auth/login', {
        'email': 'http-qa-admin@example.test', 'password': password})
    rejected(401, lambda: anonymous.call('GET', '/v1/admin/catalog/products'))
    rejected(401, lambda: anonymous.call('POST', '/v1/customer/checkout/place', {
        'quote_id': str(uuid.uuid4()), 'idempotency_key': str(uuid.uuid4())}))
    category = admin.call('POST', '/v1/admin/catalog/categories', {
        'name': 'HTTP QA', 'slug': 'http-qa', 'parent_id': None})
    product = admin.call('POST', '/v1/admin/catalog/products', {
        'sku': 'HTTP-QA', 'name': 'HTTP QA product', 'slug': 'http-qa',
        'description': 'Synthetic QA product', 'price': '1.20', 'currency': 'USD',
        'unit': 'each', 'category_id': category['id'], 'attributes': {},
        'media_ids': [], 'active': True, 'in_stock': True})
    stock_path = '/v1/admin/inventory/' + product['id']
    admin.call('PUT', stock_path, {'on_hand': 3, 'reason': 'Isolated HTTP test'})

    guest.call('POST', '/v1/cart')
    guest.call('POST', '/v1/cart/items', {'product_id': product['id'], 'quantity': 1})
    first, location = verified_customer(stack, guest, 'http-qa-one@example.test', password)
    second, second_location = verified_customer(stack, other, 'http-qa-two@example.test', password)
    cart = guest.call('POST', '/v1/cart')
    assert len(cart['items']) == 1 and cart['items'][0]['quantity'] == 1
    assert guest.call('POST', '/v1/cart') == cart
    assert other.call('POST', '/v1/cart')['items'] == []
    rejected(401, lambda: guest.call('GET', '/v1/admin/catalog/products'))
    print('PASS signup -> actual console notification -> verify -> login -> isolated guest-cart merge', flush=True)

    before = stack.sql("SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM cart_checkout.items t")
    for quantity in (0, -1, 1000001):
        rejected(400, lambda: guest.call('POST', '/v1/cart/items', {
            'product_id': product['id'], 'quantity': quantity}))
    rejected(422, lambda: guest.call('POST', '/v1/cart/items', {
        'product_id': product['id'], 'quantity': None}))
    rejected(422, lambda: guest.call('POST', '/v1/cart/items', {'product_id': product['id']}))
    assert stack.sql("SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM cart_checkout.items t") == before
    print('PASS zero/negative/oversized/null/missing cart quantities rejected without persisted mutation', flush=True)

    rejected(404, lambda: other.call('POST', '/v1/customer/checkout/quote', {'location_id': location['id']}))
    for latitude, longitude in ((91, 31), (30, 181)):
        rejected(400, lambda: guest.call('POST', '/v1/customer/locations', {
            'label': 'bad', 'latitude': latitude, 'longitude': longitude,
            'formatted_address': 'Invalid coordinates'}))
    assert len(guest.call('GET', '/v1/customer/locations')) == 1
    print('PASS cross-customer address access and invalid coordinates reject without extra addresses', flush=True)

    # Both already own a cart; race two independent HTTP requests for the last units.
    guest.call('DELETE', '/v1/cart/items/' + product['id'])
    assert guest.call('POST', '/v1/cart')['items'] == []
    def reserve(client):
        try:
            return client.call('POST', '/v1/cart/items', {'product_id': product['id'], 'quantity': 3})
        except urllib.error.HTTPError as error:
            assert error.code == 400, (error.code, error.read())
            assert json.load(error)['code'] == 'Insufficient available source stock'
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(reserve, [guest, other]))
    assert sum(result is not None for result in results) == 1
    winner, loser = (guest, other) if results[0] else (other, guest)
    winner_location = location if winner is guest else second_location
    winner_cart = winner.call('POST', '/v1/cart')
    assert winner_cart['items'][0]['quantity'] == 3
    assert admin.call('GET', stock_path)['stock']['on_hand'] == 3
    print('PASS competing last-stock reservations allow exactly one winner without decrementing physical stock', flush=True)

    quote = winner.call('POST', '/v1/customer/checkout/quote', {'location_id': winner_location['id']})
    body = {'quote_id': quote['id'], 'idempotency_key': str(uuid.uuid4())}
    rejected(400, lambda: loser.call('POST', '/v1/customer/checkout/place', body))
    assert stack.sql('SELECT count(*) FROM orders.orders') == '0'
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        placed = list(executor.map(lambda _: winner.call('POST', '/v1/customer/checkout/place', body), range(2)))
    assert placed[0] == placed[1]
    order = placed[0]['order']
    assert stack.sql(f"SELECT count(*) FROM orders.orders WHERE id='{order['id']}'") == '1'
    assert stack.sql(f"SELECT count(*) FROM payments.payment_transactions WHERE order_id='{order['id']}'") == '1'
    assert stack.sql(f"SELECT count(*) FROM platform.outbox WHERE event_type='order.placed' AND payload->>'order_id'='{order['id']}'") == '1'
    assert admin.call('GET', stock_path)['stock']['on_hand'] == 0
    assert winner.call('POST', '/v1/cart')['items'] == []
    rejected(404, lambda: loser.call('GET', '/v1/customer/orders/' + order['id']))
    print('PASS quote ownership, concurrent checkout replay, one persisted order/payment/event, stock and cart consistency', flush=True)

    refreshed = winner.call('POST', '/v1/customer/auth/refresh')
    winner.token = refreshed['access_token']
    expected_customer = first if winner is guest else second
    assert winner.call('GET', '/v1/customer/me')['id'] == expected_customer['id']
    refresh_cookie = next(cookie.value for handler in winner.http.handlers
                          if isinstance(handler, urllib.request.HTTPCookieProcessor)
                          for cookie in handler.cookiejar if cookie.name == 'customer_refresh')
    winner.call('POST', '/v1/customer/auth/logout')
    rejected(401, lambda: winner.call('GET', '/v1/customer/me'))
    refresh_request = urllib.request.Request(stack.url + '/v1/customer/auth/refresh',
        method='POST', headers={'X-Commerce-Request': '1'})
    with winner.http.open(refresh_request, timeout=10) as response:
        assert response.status == 204 and response.read() == b''
    refresh_request.add_header('Cookie', 'customer_refresh=' + refresh_cookie)
    rejected(401, lambda: urllib.request.urlopen(refresh_request, timeout=10))
    print('PASS session refresh and logout revoke access and refresh credentials', flush=True)


if __name__ == '__main__':
    stack = Stack()
    try:
        stack.start()
        exercise(stack)
    finally:
        stack.close()
