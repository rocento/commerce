"""Shared standard-library API runner for the two demo generators."""
import argparse
import http.cookiejar
import json
import mimetypes
import os
from pathlib import Path
import ssl
import urllib.error
import urllib.request
import uuid

DEMO = Path(__file__).resolve().parent
ROOT = DEMO.parents[1]


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        # Origin CA certificates are intentionally not in the operating system
        # trust store.  Deployment can supply this one scoped trust anchor for
        # the internal HTTPS seed route; normal callers continue to use the OS
        # trust store and certificate verification remains enabled.
        ca_file = os.environ.get('DEMO_SSL_CA_FILE')
        context = ssl.create_default_context(cafile=ca_file) if ca_file else None
        handlers = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())]
        if context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.http = urllib.request.build_opener(
            *handlers)

    def request(self, method, path, data=None, content_type='application/json'):
        req = urllib.request.Request(self.base + path, method=method, data=data,
            headers={'Content-Type': content_type, 'X-Commerce-Request': '1'})
        try:
            with self.http.open(req, timeout=60) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'{method} {path}: HTTP {exc.code}: '
                + exc.read().decode(errors='replace')[:1000]) from None

    def call(self, method, path, body=None):
        return self.request(method, path, json.dumps(body).encode() if body is not None else None)

    def upload(self, path, alt):
        boundary = 'demo-' + uuid.uuid4().hex
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n{alt}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                f'Content-Type: {content_type}\r\n\r\n').encode() + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
        return self.request('POST', '/v1/admin/catalog/media', data, f'multipart/form-data; boundary={boundary}')


def validate(categories, products):
    assert len(products) == 50, 'Each demo must contain exactly 50 products'
    for key in ('sku', 'slug', 'name'):
        assert len({p[key] for p in products}) == 50, f'Duplicate {key}'
    for product in products:
        assert product['category'] in categories, product['name']
        assert (DEMO / product['image']).is_file(), product['image']


def seed(client, categories, products):
    existing_categories = {c['slug']: c for c in client.call('GET', '/v1/catalog/categories')}
    existing = {}
    offset = 0
    while True:
        rows = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
        existing.update((p['sku'], p) for p in rows)
        if len(rows) < 50:
            break
        offset += 50
    # Detect conflicting slugs before creating categories or uploading media.
    by_slug = {p['slug']: p['sku'] for p in existing.values()}
    for p in products:
        if p['sku'] not in existing and p['slug'] in by_slug:
            raise RuntimeError(f"Slug already belongs to another SKU: {p['slug']}")
    for slug, name in categories.items():
        if slug not in existing_categories:
            existing_categories[slug] = client.call('POST', '/v1/admin/catalog/categories',
                {'name': name, 'slug': slug, 'parent_id': None})
    # Reuse shared product photography on reruns and between size/pack variants.
    media = {}
    for p in products:
        old = existing.get(p['sku'])
        if old and old.get('media_ids'):
            media.setdefault(p['image'], old['media_ids'][0])
    created = 0
    for p in products:
        if p['sku'] in existing:
            print('Kept existing: ' + p['sku'])
            continue
        if p['image'] not in media:
            media[p['image']] = client.upload(DEMO / p['image'], p['name'] + ' — synthetic demo image')['id']
        payload = {k: p[k] for k in ('sku', 'slug', 'name', 'description', 'price', 'unit')}
        payload.update(currency='USD', category_id=existing_categories[p['category']]['id'],
            attributes={}, media_ids=[media[p['image']]], active=True, in_stock=True)
        client.call('POST', '/v1/admin/catalog/products', payload)
        created += 1
        print('Created: ' + p['name'])
    return {'created': created, 'kept_existing': 50 - created, 'demo_products': 50}


def run(store, categories, products):
    parser = argparse.ArgumentParser(description=f'Prepare 50 {store} demo products; preview by default.')
    parser.add_argument('--apply', action='store_true', help='Create missing products/categories and upload images')
    parser.add_argument('--api-base', default='http://localhost:5174/api', help='Target store API prefix, including /api if using the frontend proxy')
    parser.add_argument('--credentials', type=Path, default=ROOT / '.local/admin-credentials.txt', help='File containing Email: and Password: lines')
    args = parser.parse_args()
    validate(categories, products)
    if not args.apply:
        print(json.dumps({'store': store, 'categories': categories, 'products': products}, indent=2))
        return
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not (email and password):
        values = dict(line.split(': ', 1) for line in args.credentials.read_text().splitlines() if ': ' in line)
        email, password = values['Email'], values['Password']
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', {'email': email, 'password': password})
    try:
        print(json.dumps(seed(client, categories, products)))
    finally:
        client.call('POST', '/v1/admin/auth/logout')
