#!/usr/bin/env python3
"""Preview or install a data preset. An explicit API target is required for writes."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from demo_presets import ROOT, load_preset, seed, verify_seed, seed_global_stock, list_products, assert_isolated
sys.path.insert(0, str(ROOT / 'commerce-assets/demo'))
from demo_seed import Client


def enrichment(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'commerce-assets/demo' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.seed


def complete_seed(client, preset, theme, publish, refresh_theme, preserve_theme, sync_palette):
    result = seed(client, preset, theme, publish, refresh_theme, preserve_theme)
    print(json.dumps(result, indent=2), flush=True)
    verified = verify_seed(client, preset, preserve_theme=preserve_theme)
    print(json.dumps(verified), flush=True)
    if not verified['seeded']:
        raise RuntimeError('Demo verification failed; inspect the seed output before rerunning')
    if preset['id'] == 'jewelry':
        print('[INFO] Checking demo category images using the existing session', flush=True)
        enrichment('seed-category-images')(client, preset['id'])
    print('[INFO] Seeding delivery inventory using the existing session', flush=True)
    enrichment('seed-delivery-areas')(client, preset['id'])
    if sync_palette:
        from grocery_palette import sync
        assignments = client.call('GET', '/v1/admin/themes/assignments')
        if any(a['channel'] == preset['channel'] and a.get('rules') for a in assignments):
            print('[OK] Grocery palette skipped; existing targeting rules preserved', flush=True)
        else:
            print('[INFO] Synchronizing Grocery palette using the existing session', flush=True)
            palette = sync(client, apply=True)
            print(json.dumps(palette), flush=True)
            if not palette['matches']:
                raise RuntimeError('Grocery palette verification failed')
    print(f'[OK] {preset["id"]} catalog, images and delivery inventory complete', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('preset')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--publish', action='store_true', help='Publish and assign a new preset; preserve existing published themes')
    parser.add_argument('--refresh-theme', action='store_true', help='Replace the matching demo theme draft with the current preset and publish a new version')
    parser.add_argument('--preserve-theme', action='store_true', help='Seed catalog data while keeping existing assigned themes and targeting rules; publish only on an unassigned channel')
    parser.add_argument('--global-stock-only', action='store_true', help='Set every active product in this isolated demo to 1000 global units without changing catalog or themes')
    parser.add_argument('--verify', action='store_true', help='Check that the complete preset is already published; makes no changes')
    parser.add_argument('--complete', action='store_true', help='Apply, verify and enrich using one admin session')
    parser.add_argument('--sync-palette', action='store_true', help='Synchronize Grocery palette within the complete seed session')
    parser.add_argument('--api-base', help='Target installation API, for example http://localhost:5274/api')
    parser.add_argument('--credentials', type=Path)
    args = parser.parse_args()
    if args.refresh_theme and not args.publish:
        parser.error('--refresh-theme requires --publish')
    if args.refresh_theme and args.preserve_theme:
        parser.error('--refresh-theme cannot be combined with --preserve-theme')
    if args.global_stock_only and (not args.apply or args.verify or args.complete):
        parser.error('--global-stock-only requires --apply and cannot be combined with --verify or --complete')
    if args.complete and (not args.apply or args.verify):
        parser.error('--complete requires --apply and cannot be combined with --verify')
    if args.sync_palette and (not args.complete or args.preset != 'grocery'):
        parser.error('--sync-palette requires --complete for grocery')
    preset, theme = load_preset(args.preset)
    if not args.apply and not args.verify:
        print(json.dumps({'preset': preset, 'theme_template': theme}, indent=2))
        return
    if not args.api_base:
        parser.error('--apply requires an explicit --api-base for the isolated target installation')
    email, password = os.environ.get('DEMO_ADMIN_EMAIL'), os.environ.get('DEMO_ADMIN_PASSWORD')
    if not (email and password) and args.credentials:
        values = dict(line.split(': ', 1) for line in args.credentials.read_text().splitlines() if ': ' in line)
        email, password = values['Email'], values['Password']
    if not (email and password):
        parser.error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD or pass --credentials')
    client = Client(args.api_base)
    client.call('POST', '/v1/admin/auth/login', {'email': email, 'password': password})
    try:
        if args.global_stock_only:
            products = list_products(client)
            assert_isolated(preset, products, client.call('GET', '/v1/catalog/categories'))
            print(json.dumps(seed_global_stock(client, products)))
            return
        if args.complete:
            complete_seed(client, preset, theme, args.publish, args.refresh_theme, args.preserve_theme, args.sync_palette)
            return
        if args.verify:
            result = verify_seed(client, preset, preserve_theme=args.preserve_theme)
            print(json.dumps(result))
            if not result['seeded']:
                raise SystemExit(1)
            return
        print(json.dumps(seed(client, preset, theme, args.publish, args.refresh_theme, args.preserve_theme), indent=2))
    finally:
        client.call('POST', '/v1/admin/auth/logout')


if __name__ == '__main__':
    main()
