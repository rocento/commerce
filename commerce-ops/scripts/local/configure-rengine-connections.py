"""Save existing production demo accounts without exposing their credentials.

Run on the production host with sudo. --check performs read-only verification
apart from temporary authentication sessions. No shopper requests are generated.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    values = {}
    for line in Path('/opt/rocento/deploy/ec2/bootstrap.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"\'')
    cookie = ''

    def call(path, data=None):
        nonlocal cookie
        headers = {'X-Rengine-Request': '1', 'Origin': 'https://rengine.rocento.com', 'Cookie': cookie}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request('http://127.0.0.1:3190'+path, headers=headers,
                                         data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.headers.get('Set-Cookie'):
                    cookie = response.headers['Set-Cookie'].split(';', 1)[0]
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{path.split("?")[0]} returned HTTP {error.code}') from None

    try:
        result = call('/api/login', {'store': 'grocery', 'email': values['GROCERY_ADMIN_EMAIL'],
                                     'password': values['GROCERY_ADMIN_PASSWORD']})
        if not result.get('operator'):
            raise RuntimeError('Configured account did not authenticate as rengine operator.')
        saved = {item['store'] for item in call('/api/connections')['connections'] if item['saved']}
        if not args.check:
            for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                if store not in saved:
                    call('/api/connections', {'action': 'save', 'store': store,
                         'email': values[store.upper()+'_ADMIN_EMAIL'],
                         'password': values[store.upper()+'_ADMIN_PASSWORD']})
        connections = call('/api/connections')
        assert all(item['saved'] for item in connections['connections'])
        assert len(connections['stores']) == 4
        encrypted = Path('/opt/rocento/deploy/rengine-private/data/connections.enc').read_bytes()
        for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            assert values[store.upper()+'_ADMIN_PASSWORD'].encode() not in encrypted
        traces = call('/api/all-traces?hours=24')
        assert len(traces['demos']) == 4 and not any(item.get('error') for item in traces['demos'])
        live = call('/api/live')
        assert len(live['batches']) == 4 and not any(item.get('error') for item in live['batches'])
        print(json.dumps({'saved_demos': len(connections['stores']),
                          'history_demos': len(traces['demos']), 'live_demos': len(live['batches']),
                          'capture': {item['store']: item.get('capture_enabled') for item in traces['demos']},
                          'passwords_encrypted': True}))
    finally:
        if cookie:
            call('/api/logout', {})


if __name__ == '__main__':
    main()
