#!/usr/bin/env python3
"""Remove unused legacy backend and AI tags after every shared service is healthy."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
import subprocess

STORES = ('grocery', 'jewelry', 'electronics', 'pharmacy')
SERVICES = {
    'api-gateway': 'rocento-backend:release',
    'export-worker': 'rocento-backend:release',
    'engagement-worker': 'rocento-backend:release',
    'ai-service': 'rocento-ai-service:release',
    'commerce-language-engine': 'rocento-language-engine:release',
    'ai-postgres': 'rocento-ai-postgres:release',
}


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def clean():
    shared = {tag: json.loads(docker('image', 'inspect', tag))[0]['Id']
              for tag in dict.fromkeys(SERVICES.values())}
    ids = docker('ps', '-aq').split()
    containers = json.loads(docker('inspect', *ids)) if ids else []
    # Include stopped containers when deciding whether an old image is in use.
    used = {c['Image'] for c in containers}
    for store in STORES:
        for service in SERVICES:
            matches = [c for c in containers
                       if c.get('Config', {}).get('Labels', {}).get('com.docker.compose.project') == 'rocento-' + store
                       and c.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == service]
            if len(matches) != 1 or matches[0]['Image'] != shared[SERVICES[service]] or not matches[0]['State'].get('Running'):
                print(f'[SKIP] Legacy image cleanup: {store}/{service} is not running the shared release.')
                return
            if service != 'export-worker' and matches[0]['State'].get('Health', {}).get('Status') != 'healthy':
                print(f'[SKIP] Legacy image cleanup: {store}/{service} is not healthy.')
                return
    available = set(docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}').splitlines())
    for store in STORES:
        for service in SERVICES:
            tag = f'rocento-{store}-{service}:latest'
            if tag not in available:
                continue
            image = json.loads(docker('image', 'inspect', tag))[0]['Id']
            if image in used:
                print(f'[SKIP] Retaining container-used legacy image: {tag}')
                continue
            # No force, broad prune, container deletion, or volume operations.
            docker('image', 'rm', tag)
            print(f'[OK] Removed unused legacy image tag: {tag}')


if __name__ == '__main__':
    try:
        clean()
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as error:
        print(f'[WARN] Legacy image cleanup deferred: {error}')
