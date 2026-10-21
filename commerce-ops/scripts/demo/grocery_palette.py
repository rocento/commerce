"""Keep the accepted Grocery demo colors without resetting its theme content."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from copy import deepcopy
import json
import re

from demo_presets import PRESETS, list_products

PALETTE_KEYS = ('color.primary', 'color.success', 'color.surface')


def palette():
    # The existing, valid theme preset is the single source of predefined values.
    tokens = json.loads((PRESETS / 'grocery/theme.json').read_text())['tokens']
    result = {key: tokens[key] for key in PALETTE_KEYS}
    if any(not re.fullmatch(r'#[0-9a-fA-F]{6}', value) for value in result.values()):
        raise ValueError('Invalid predefined Grocery palette')
    return result


def with_palette(configuration):
    result = deepcopy(configuration)
    result['tokens'].update(palette())
    return result


def sync(client, apply=False):
    preset = json.loads((PRESETS / 'grocery/preset.json').read_text())
    products = list_products(client)
    categories = client.call('GET', '/v1/catalog/categories')
    # Existing demo QA may add products/categories. Require the complete Grocery
    # fingerprint, but do not mistake those additions for a different installation.
    skus = {p['sku'] for p in products}
    # commerce-ops/scripts/seed-catalog.py created the original local Grocery demo with these
    # stable identifiers, before the newer 50-product preset was introduced.
    legacy = {'DEMO-APL-001', 'DEMO-BAN-001', 'DEMO-BRD-001'}
    grocery = {p['sku'] for p in preset['products']}.issubset(skus) or legacy.issubset(skus)
    if (not grocery
            or not {c['slug'] for c in preset['categories']}.issubset({c['slug'] for c in categories})):
        raise ValueError('Target does not match a supported Grocery demo catalog; verify the API target before synchronizing its palette')
    assignments = client.call('GET', '/v1/admin/themes/assignments')
    assignment = next((a for a in assignments if a['channel'] == preset['channel']), None)
    if not assignment or not assignment.get('theme_id') or assignment.get('rules'):
        raise ValueError('Grocery palette requires one assigned theme without targeting rules; review the assignment first')
    path = '/v1/admin/themes/' + assignment['theme_id']
    theme = client.call('GET', path)
    if theme['owner_channel'] != preset['channel'] or not theme.get('published_version'):
        raise ValueError('Grocery theme must be published in the storefront channel')
    published = client.call('GET', path + '/versions/' + theme['published_version'])
    draft = with_palette(theme['configuration'])
    live = with_palette(published['configuration'])
    draft_changed = draft != theme['configuration']
    live_changed = live != published['configuration']
    result = {'preset': 'grocery', 'palette': palette(), 'theme_id': theme['id'],
              'changed': False, 'matches': not (draft_changed or live_changed)}
    if not apply or result['matches']:
        return result
    # Publishing a draft publishes all its content. Never ship unrelated pending edits.
    if live_changed and draft != live:
        raise ValueError('Unpublished non-palette theme edits exist; publish or resolve them before palette synchronization')
    if client.call('GET', '/v1/admin/themes/assignments') != assignments:
        raise ValueError('Theme assignment changed during palette synchronization; retry')
    if draft_changed:
        theme = client.call('PUT', path, {'expected_revision': theme['revision'], 'configuration': draft})
    if live_changed:
        client.call('POST', path + '/publish', {'expected_revision': theme['revision']})
    # An interrupted save-before-publish is recoverable on the next invocation.
    current = client.call('GET', path)
    version = client.call('GET', path + '/versions/' + current['published_version'])
    if current['configuration'] != draft or version['configuration'] != live:
        raise ValueError('Theme changed during palette verification; inspect the current draft and published version')
    if client.call('GET', '/v1/admin/themes/assignments') != assignments:
        raise ValueError('Theme assignment changed during palette verification; retry')
    return {**result, 'changed': True, 'matches': True}
