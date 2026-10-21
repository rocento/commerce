"""Add illustrative Egyptian delivery areas to the local demo, preserving existing areas.

Preview: python3 commerce-ops/scripts/demo/seed-egypt-delivery-areas.py
Apply: python3 commerce-ops/scripts/demo/seed-egypt-delivery-areas.py --apply --stock-id UUID
Uses the local admin client at localhost:5174. The rectangles are sample service
zones around approximate neighborhood centers, not official district boundaries.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from pathlib import Path


def area_inputs(stock_id):
    samples = json.loads((Path(__file__).resolve().parents[3] / 'commerce-demo/egypt-delivery-areas.json').read_text())
    for index, sample in enumerate(samples):
        lat, lng = sample['latitude'], sample['longitude']
        yield {
            'name': sample['name'], 'priority': 100 + index, 'is_active': True,
            'boundary': [
                {'latitude': lat - .015, 'longitude': lng - .02},
                {'latitude': lat - .015, 'longitude': lng + .02},
                {'latitude': lat + .015, 'longitude': lng + .02},
                {'latitude': lat + .015, 'longitude': lng - .02},
            ],
            'stocks': [{'stock_id': stock_id, 'priority': 0}],
        }


def seed(client, stock_id):
    stocks = client.call('GET', '/v1/admin/inventory/stocks')
    if not any(s['id'] == stock_id and s.get('sources') for s in stocks):
        raise ValueError('Choose an existing stock with linked inventory sources')
    existing = {area['name'] for area in client.call('GET', '/v1/admin/inventory/delivery-areas')}
    created = []
    for body in area_inputs(stock_id):
        if body['name'] not in existing:
            client.call('POST', '/v1/admin/inventory/delivery-areas', body)
            created.append(body['name'])
    return created


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--stock-id')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps(list(area_inputs(args.stock_id or 'CHOOSE_EXISTING_STOCK')), indent=2))
    else:
        if not args.stock_id:
            parser.error('--apply requires --stock-id')
        from catalog_support import Client
        client = Client()
        try:
            print(json.dumps({'created': seed(client, args.stock_id)}))
        finally:
            client.call('POST', '/v1/admin/auth/logout')
