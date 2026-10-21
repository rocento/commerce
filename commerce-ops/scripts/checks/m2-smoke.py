"""M2 real-provider integration test. Creates and removes its own synthetic catalog records."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from catalog_support import Client, ROOT

client = Client()
unique = uuid.uuid4().hex[:10]
created = []

def expect_error(method, path, body, status):
    try:
        client.call(method, path, body)
    except urllib.error.HTTPError as e:
        assert e.code == status, (e.code, e.read())
    else:
        raise AssertionError('Request unexpectedly succeeded')

def wait_for(query, predicate):
    # The durable indexer may await its 120-second redelivery window after a gateway crash.
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        result = client.call('GET', '/v1/search?' + urllib.parse.urlencode(query))
        if predicate(result):
            return result
        time.sleep(0.3)
    raise AssertionError(f'Index did not converge for {query}')

try:
    parent = client.call('POST', '/v1/admin/catalog/categories', {'name': 'Smoke Produce', 'slug': 'smoke-produce-' + unique, 'parent_id': None})
    created.append(('categories', parent['id']))
    child = client.call('POST', '/v1/admin/catalog/categories', {'name': 'Smoke Fruits', 'slug': 'smoke-fruits-' + unique, 'parent_id': parent['id']})
    created.append(('categories', child['id']))
    attr = client.call('POST', '/v1/admin/catalog/attributes', {'name': 'Smoke origin', 'code': 'origin-' + unique, 'kind': 'text', 'required': False})
    created.append(('attributes', attr['id']))
    image = (ROOT / 'commerce-assets/demo/organic-bananas.png').read_bytes()
    media = client.upload(image, 'Smoke bananas')
    created.append(('media', media['id']))
    with urllib.request.urlopen('http://localhost:5173/api/v1/catalog/media/' + media['id'] + '/content') as response:
        assert response.headers['Content-Type'] == 'image/png'
        assert response.read() == image
    body = {'sku': 'SMOKE-' + unique, 'name': 'Organic Bananas ' + unique, 'slug': 'smoke-bananas-' + unique, 'description': 'M2 integration fixture', 'price': '1.20', 'currency': 'USD', 'unit': 'lb', 'category_id': child['id'], 'attributes': {attr['code']: 'Demo farm'}, 'media_ids': [media['id']], 'active': True, 'in_stock': True}
    product = client.call('POST', '/v1/admin/catalog/products', body)
    created.append(('products', product['id']))
    client.call('PUT', '/v1/admin/inventory/' + product['id'], {'on_hand': 5, 'reason': 'M2 regression stock'})
    contains = lambda r: any(p['id'] == product['id'] for p in r['hits'])
    absent = lambda r: not contains(r)
    query = {'q': 'banan', 'category_id': parent['id'], 'min_price': '1.20', 'max_price': '1.20', 'in_stock': 'true'}
    result = wait_for(query, contains)
    assert any(p['price'] == '1.20' for p in result['hits'])
    wait_for({'q': 'banans', 'category_id': child['id']}, contains)  # actual typo, in addition to prefix search
    assert not contains(client.call('GET', '/v1/search?' + urllib.parse.urlencode({'category_id': child['id'], 'min_price': '1.21'})))
    assert not contains(client.call('GET', '/v1/search?' + urllib.parse.urlencode({'category_id': child['id'], 'max_price': '1.19'})))
    expect_error('GET', '/v1/search?min_price=1%20OR%20true', None, 400)
    expect_error('DELETE', '/v1/admin/catalog/media/' + media['id'], None, 409)
    expect_error('DELETE', '/v1/admin/catalog/categories/' + child['id'], None, 409)
    expect_error('DELETE', '/v1/admin/catalog/attributes/' + attr['id'], None, 409)
    client.call('PUT', '/v1/admin/catalog/media/' + media['id'], {'alt': 'Updated banana image description'})
    assert client.call('GET', '/v1/catalog/media/' + media['id'])['alt'].startswith('Updated')
    client.call('PUT', '/v1/admin/inventory/' + product['id'], {'on_hand': 0, 'reason': 'M2 stock filter regression'})
    body['in_stock'] = False
    client.call('PUT', '/v1/admin/catalog/products/' + product['id'], body)
    wait_for(query, absent)
    wait_for({'category_id': child['id'], 'in_stock': 'false'}, contains)
    body['active'] = False
    client.call('PUT', '/v1/admin/catalog/products/' + product['id'], body)
    wait_for({'category_id': child['id']}, absent)
    expect_error('GET', '/v1/catalog/products/' + product['id'], None, 404)
    body['active'] = True
    client.call('PUT', '/v1/admin/catalog/products/' + product['id'], body)
    wait_for({'category_id': child['id']}, contains)
    client.call('PUT', '/v1/admin/catalog/categories/' + child['id'], {'name': child['name'], 'slug': child['slug'], 'parent_id': None})
    wait_for({'category_id': parent['id']}, absent)
    wait_for({'category_id': child['id']}, contains)
    session = str(uuid.uuid4())
    for event_type in ['page_view', 'search_query']:
        event = {'id': str(uuid.uuid4()), 'session_id': session, 'event_type': event_type, 'path': '/products/' + product['id']}
        if event_type == 'search_query':
            event.update(query='banan', result_count=1)
        client.call('POST', '/v1/analytics/events', event)
    # Query inside ClickHouse with its configured password supplied by container environment.
    sql = f"SELECT (SELECT count() FROM commerce_analytics.page_view_events WHERE session_id='{session}') AS pages, (SELECT count() FROM commerce_analytics.search_query_events WHERE session_id='{session}') AS searches FORMAT JSONEachRow"
    result = subprocess.run(['docker', 'compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'exec', '-T', 'clickhouse', 'sh', '-c', 'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"', 'sh', sql], cwd=ROOT, capture_output=True, text=True, check=True)
    counts = json.loads(result.stdout)
    assert int(counts['pages']) == 1 and int(counts['searches']) == 1, counts
    client.call('DELETE', '/v1/admin/catalog/products/' + product['id'])
    created.pop()
    wait_for({'category_id': child['id']}, absent)
    print('PASS M2: image upload/read, catalog CRUD, exact prices, typo search, ancestor/price/stock filters, update/unpublish/reparent/delete indexing, media protection, and ClickHouse events.')
finally:
    for kind, identifier in reversed(created):
        try:
            client.call('DELETE', f'/v1/admin/catalog/{kind}/{identifier}')
        except Exception as error:
            print(f'Cleanup needed: {kind}/{identifier}: {error}')
    client.call('POST', '/v1/admin/auth/logout')
