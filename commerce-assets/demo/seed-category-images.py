"""Upload generated category images and attach them using editable category attributes."""
import argparse
import json
import os
from pathlib import Path
from demo_seed import Client

HERE = Path(__file__).resolve().parent / 'categories'


def seed(c, store):
    manifest = json.loads((HERE / 'manifest.json').read_text())
    assets = [x for x in manifest if x['store'] == store]
    assert len(assets) == 16
    for x in assets:
        assert (HERE / x['file']).is_file(), x['file']
    public = {x['slug']: x for x in c.call('GET', '/v1/catalog/categories')}
    if any(x['category_slug'] not in public for x in assets):
        raise RuntimeError('Demo categories are missing. Seed the demo before category images.')
    assets = [x for x in assets if not public[x['category_slug']].get('thumbnail' if x['kind'] == 'icon' else 'banner')]
    if not assets:
        print('[OK] Category images already assigned; no changes needed.')
        return
    categories = {x['slug']: x for x in c.call('GET', '/v1/catalog/categories')}
    slugs = sorted({x['category_slug'] for x in assets})
    assert all(s in categories for s in slugs)
    old = {s: c.call('GET', f"/v1/admin/catalog/categories/{categories[s]['id']}/attributes") for s in slugs}
    receipt = {}
    for s in slugs:
        attrs = c.call('GET', f"/v1/admin/catalog/categories/{categories[s]['id']}/attributes")
        for x in [v for v in assets if v['category_slug'] == s]:
            key = x['file']
            field = 'thumbnail' if x['kind'] == 'icon' else 'banner'
            if attrs.get(field):
                receipt[key] = attrs[field]
                continue
            if key not in receipt:
                receipt[key] = c.upload(HERE / key, x['name'] + ' category ' + x['kind'] + ' — generated image')['id']
            attrs['thumbnail' if x['kind'] == 'icon' else 'banner'] = receipt[key]
        c.call('PUT', f"/v1/admin/catalog/categories/{categories[s]['id']}/attributes", attrs)
        print('Updated ' + s, flush=True)
    fresh = {x['slug']: x for x in c.call('GET', '/v1/catalog/categories')}
    for x in assets:
        field = 'thumbnail' if x['kind'] == 'icon' else 'banner'
        assert fresh[x['category_slug']][field] == receipt[x['file']]
    print(f'Verified {len(slugs)} categories, {len(assets)} images.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', choices=['grocery', 'jewelry'], required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--api-base')
    args = parser.parse_args()
    if not args.apply:
        manifest = json.loads((HERE / 'manifest.json').read_text())
        print(json.dumps([x for x in manifest if x['store'] == args.store], indent=2))
        return
    if not args.api_base:
        parser.error('--apply requires an explicit --api-base')
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not email or not password:
        parser.error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD using protected deployment configuration.')
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', {'email': email, 'password': password})
    try:
        seed(client, args.store)
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    main()
