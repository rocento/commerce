#!/usr/bin/env python3
"""Record/verify running AI identities without exporting dictionaries or user data."""
import argparse
import json
from pathlib import Path
import subprocess

STORES = ('grocery', 'jewelry', 'electronics', 'pharmacy')
SERVICES = {'ai-service', 'commerce-language-engine', 'ai-postgres', 'ai-health',
            'assistant-ingress', 'assistant-tools', 'assistant-provider'}


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def inspect_container(identifier):
    item = json.loads(command('docker', 'inspect', identifier))[0]
    if not item['State']['Running'] or item['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
        raise ValueError('An existing AI container is not running and healthy')
    return item


def capture():
    records = {}
    for store in STORES:
        ids = command('docker', 'ps', '--filter', f'label=com.docker.compose.project=rocento-{store}', '--format', '{{.ID}}').splitlines()
        services = {}
        for identifier in ids:
            item = json.loads(command('docker', 'inspect', identifier))[0]
            service = item.get('Config', {}).get('Labels', {}).get('com.docker.compose.service')
            if service not in SERVICES:
                continue
            if service in services:
                raise ValueError(f'Multiple containers for {store}/{service}; resolve before preserving AI')
            if not item['State']['Running'] or item['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
                raise ValueError(f'{store}/{service} is not running and healthy')
            services[service] = {'container': item['Id'], 'image': item['Image']}
        if not {'ai-service', 'commerce-language-engine'} <= services.keys():
            raise ValueError(f'{store} needs existing Python and Language Engine containers for --preserve-ai')
        engine = services['commerce-language-engine']['container']
        # Fixed internal readiness URLs only; no chat queries or corpus export.
        body = json.loads(command('docker', 'exec', engine, 'node', '-e',
            "require('node:http').get('http://127.0.0.1:3000/api/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)process.exit(1);console.log(b)})}).on('error',()=>process.exit(1)).setTimeout(5000,function(){this.destroy()})"))
        provenance = body.get('provenance', {})
        if body.get('status') != 'ok' or not provenance.get('releaseId') or not provenance.get('runtimeVersion'):
            raise ValueError(f'{store} language release readiness/identity is missing')
        assistant = services['ai-service']['container']
        ready = json.loads(command('docker', 'exec', assistant, 'python', '-c',
            "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/ready', timeout=5).read().decode())"))
        if ready.get('status') != 'ready' or any(ready.get('components', {}).get(key) != 'ready' for key in ('language', 'storage')):
            raise ValueError(f'{store} assistant is not ready')
        records[store] = {'services': services, 'provenance': provenance}
    shared = command('docker', 'ps', '-a', '--filter', 'name=^/rocento-ai-shared-ai-postgres-1$', '--format', '{{.ID}}').splitlines()
    for identifier in shared:
        item = inspect_container(identifier)
        records['shared-database'] = {'container': item['Id'], 'image': item['Image']}
    return records


def verify(path):
    expected = json.loads(path.read_text())
    if capture() != expected:
        raise ValueError('Production AI container, image or release identity changed during deployment')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('snapshot', 'verify', 'image'))
    parser.add_argument('path', type=Path)
    parser.add_argument('store', nargs='?', choices=STORES)
    args = parser.parse_args()
    if args.action == 'snapshot':
        result = capture()
        with args.path.open('x') as output:
            json.dump(result, output, indent=2)
        args.path.chmod(0o600)
        print('[OK] Recorded healthy production AI containers and release identities')
    elif args.action == 'verify':
        verify(args.path)
        print('[OK] Production AI containers, images and release identities are unchanged')
    else:
        if not args.store:
            parser.error('image requires a store')
        print(json.loads(args.path.read_text())[args.store]['services']['ai-service']['image'])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit(f'AI preservation check failed: {error}') from None
