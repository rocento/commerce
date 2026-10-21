#!/usr/bin/env python3
"""Check or restore the accepted Grocery demo palette through the theme API."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
import os
from pathlib import Path
import sys

from demo_presets import ROOT
from grocery_palette import sync

sys.path.insert(0, str(ROOT / 'commerce-assets/demo'))
from demo_seed import Client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-base', required=True)
    parser.add_argument('--credentials', type=Path)
    parser.add_argument('--apply', action='store_true', help='Save/publish only changed palette tokens; default is a read-only check')
    parser.add_argument('--skip-if-targeted', action='store_true', help='Leave palette unchanged when the storefront has targeting rules')
    args = parser.parse_args()
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not (email and password) and args.credentials:
        values = dict(line.split(': ', 1) for line in args.credentials.read_text().splitlines() if ': ' in line)
        email, password = values['Email'], values['Password']
    if not (email and password):
        parser.error('Set DEMO_ADMIN_EMAIL/DEMO_ADMIN_PASSWORD or pass --credentials')
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', {'email': email, 'password': password})
    try:
        if args.skip_if_targeted:
            assignments = client.call('GET', '/v1/admin/themes/assignments')
            if any(a['channel'] == 'storefront' and a.get('rules') for a in assignments):
                print(json.dumps({'preset': 'grocery', 'skipped': True, 'reason': 'Existing theme targeting rules preserved'}))
                return 0
        result = sync(client, apply=args.apply)
        print(json.dumps(result))
        return 0 if result['matches'] else 1
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    raise SystemExit(main())
