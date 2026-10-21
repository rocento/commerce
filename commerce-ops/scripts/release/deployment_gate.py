"""Host-enforced release authorization before deployment mutates managed state.

The authorization directory is provisioned by the release operator, never uploaded
with application source. Inventory creation does not authorize a deployment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

import release_readiness as readiness

AUTHORIZATION = Path('/etc/rocento/release/authorization.json')
IGNORED = {'.git', 'node_modules', '__pycache__', '.venv', 'target', 'dist', 'out',
           '.next', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.local', 'output', 'tmp'}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=readiness.unique_object)


def protected(path, uid=0):
    """Require an immutable-to-unprivileged-users chain, including the leaf."""
    path = Path(path).absolute()
    for entry in [path, *path.parents]:
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise ValueError(f'untrusted release authorization path: {entry}')
    if not path.is_file():
        raise ValueError('authorization input must be a regular file')


def source_inventory(root, operation, service='all', preserve_ai=False):
    root = Path(root).resolve()
    if operation == 'website':
        paths = list(root.rglob('*'))
    elif operation == 'full':
        # Use the canonical upload boundary, including migrations' separate mirror.
        with tempfile.TemporaryDirectory(prefix='release-inventory-') as temporary:
            command = '''set -euo pipefail
ROOT=$1
DEST=$2
PRESERVE_AI=$3
. "$ROOT/commerce-ops/deploy/ec2/server/ec2-source-filters.sh"
configure_source_filters
rsync -a --dry-run --out-format='%n' "${SOURCE_FILTERS[@]}" "$ROOT/" "$DEST/"
rsync -a --dry-run --out-format='commerce-api/rocento-api/migrations/%n' "$ROOT/commerce-api/rocento-api/migrations/" "$DEST/"
'''
            result = subprocess.run(['bash', '-c', command, 'inventory', str(root), temporary,
                                     str(int(preserve_ai))], check=True, capture_output=True, text=True)
            paths = [root / name for name in result.stdout.splitlines() if name and not name.endswith('/')]
    else:
        roots = ['commerce-web/apps/rengine', 'commerce-ops/compose/compose.rengine.yaml', 'commerce-ops/deploy/rengine',
                 'commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh']
        if operation == 'ai':
            roots = ['commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh', 'commerce-ops/deploy/ec2/server/ec2-compose.sh',
                     'commerce-ops/deploy/ec2/server/ec2-shared-ai-upgrade.sh',
                     'commerce-ops/deploy/assistant/shared-tenants.sql', 'commerce-ops/deploy/assistant/shared-language-tenants.sql',
                     'commerce-ops/deploy/ec2/shared-ai-consumer.yaml']
            if service != 'language':
                roots += ['commerce-assistant-platform/Dockerfile', 'commerce-assistant-platform/.dockerignore', 'commerce-assistant-platform/requirements.lock',
                          'commerce-assistant-platform/app', 'commerce-assistant-platform/knowledge', 'commerce-assistant-platform/migrations',
                          'commerce-ops/compose/compose.assistant-admin.yaml', 'commerce-ops/compose/compose.assistant-provider.yaml',
                          'commerce-ops/scripts/conversations-setup.py', 'commerce-ops/scripts/local/conversations-setup.py',
                          'commerce-ops/scripts/agentic-preflight.py', 'commerce-ops/scripts/release/agentic-preflight.py']
                for name in ('generate_openapi.py', 'generate_assistant_models.py', 'generate_assistant_validator.py'):
                    roots += ['commerce-ops/scripts/' + name, 'commerce-ops/scripts/contracts/' + name]
            if service != 'ai':
                language = 'commerce-assistant-platform/app/commerce_language_engine/'
                roots += [language + name for name in ('Dockerfile', '.dockerignore', 'package.json',
                          'package-lock.json', 'src', 'seeds', 'scripts', 'migrations', 'public',
                          'data/compiled.json', 'data/deployment-release.json.gz')]
        roots += ['commerce-ops/scripts/release/deployment_gate.py', 'commerce-ops/scripts/release/release_readiness.py']
        paths = []
        for relative in roots:
            path = root / relative
            if not path.exists():
                raise ValueError(f'incomplete {operation} inventory: {relative}')
            paths.extend(path.rglob('*') if path.is_dir() else [path])
    files = {}
    for path in sorted(set(paths)):
        relative = path.relative_to(root)
        if operation not in ('full', 'website') and (
                any(part in IGNORED for part in relative.parts) or path.name.startswith('.env')
                or path.suffix == '.pyc' or (operation == 'rengine' and path.suffix == '.log')):
            continue
        language_prefix = 'commerce-assistant-platform/app/commerce_language_engine/'
        if operation == 'ai' and str(relative).startswith(language_prefix):
            if service == 'ai':
                continue
            suffix = str(relative)[len(language_prefix):]
            if suffix.split('/')[0] not in {'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'src', 'seeds', 'scripts', 'migrations', 'public', 'data'}:
                continue
            if suffix.startswith('data/') and suffix not in ('data/compiled.json', 'data/deployment-release.json.gz'):
                continue
        if path.is_symlink():
            raise ValueError(f'symlink deployment input: {relative}')
        if path.is_file():
            files[relative.as_posix()] = sha256(path)
    if not files:
        raise ValueError('empty source inventory')
    return files


def enforce(root, operation, service='all', store='all', preserve_ai=False,
            authorization=AUTHORIZATION, machine_id=Path('/etc/machine-id'), bootstrap=None, domain=None):
    protected(authorization)
    auth = read_json(authorization)
    # Both inventory and evidence are trusted, reviewed server-side inputs.
    directory = authorization.parent
    inventory_path = directory / 'inventory.json'
    packet_path = directory / 'readiness.json'
    protected(inventory_path)
    protected(packet_path)
    inventory = read_json(inventory_path)
    candidate = sha256(inventory_path)
    if auth.get('candidate_sha256') != candidate:
        raise ValueError('authorized inventory checksum mismatch')
    if auth.get('machine_id_sha256') != sha256(machine_id):
        raise ValueError('release authorization belongs to another host')
    expected_mode = dict(operation=operation, service=service, store=store, preserve_ai=preserve_ai)
    if operation == 'website' and (not domain or inventory.get('domain') != domain):
        raise ValueError('website domain differs from reviewed inventory')
    if inventory.get('deployment') != expected_mode:
        raise ValueError('deployment scope differs from reviewed inventory')
    if operation == 'full':
        bootstrap = bootstrap or Path(root) / 'deploy/ec2/bootstrap.env'
        if inventory.get('bootstrap_sha256') != sha256(bootstrap):
            raise ValueError('bootstrap configuration differs from reviewed inventory')
    environment = auth.get('environment')
    if not readiness.nonempty(environment):
        raise ValueError('authorized environment missing')
    packet = read_json(packet_path)
    blockers = readiness.validate(packet, directory, candidate, environment)
    if blockers:
        raise ValueError('release readiness blocked: ' + '; '.join(blockers))
    for check in packet['checks']:
        for evidence in check['evidence']:
            protected(directory / evidence['path'])
    if inventory.get('source_files') != source_inventory(root, operation, service, preserve_ai):
        raise ValueError('deployment source differs from reviewed inventory')
    check_artifacts(operation, service, preserve_ai, directory / 'frontend' if operation == 'full' else None, authorization)
    print(json.dumps({'authorized': True, 'candidate_sha256': candidate,
                      'environment': environment, 'deployment': expected_mode}))



def expected_tags(operation, service, preserve_ai):
    if operation == 'website':
        return set()
    if operation == 'rengine':
        return {'rocento-rengine:release'}
    tags = {'rocento-backend:release'} if operation == 'full' else set()
    if not preserve_ai:
        if service != 'language':
            tags.add('rocento-ai-service:release')
        if service != 'ai':
            tags.add('rocento-language-engine:release')
        if operation == 'full':
            tags.add('rocento-ai-postgres:release')
    return tags


def check_artifacts(operation, service, preserve_ai, frontend=None, authorization=AUTHORIZATION):
    protected(authorization)
    auth = read_json(authorization)
    inventory_path = authorization.parent / 'inventory.json'
    protected(inventory_path)
    if sha256(inventory_path) != auth.get('candidate_sha256'):
        raise ValueError('authorized inventory checksum mismatch')
    inventory = read_json(inventory_path)
    expected = inventory.get('image_ids', {})
    if set(expected) != expected_tags(operation, service, preserve_ai):
        raise ValueError('reviewed immutable application image IDs missing or incomplete')
    for tag, identity in expected.items():
        if not isinstance(identity, str) or not identity.startswith('sha256:') or not readiness.HEX.fullmatch(identity[7:]):
            raise ValueError('invalid immutable image ID')
        actual = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag],
                                check=True, capture_output=True, text=True).stdout.strip()
        if actual != identity:
            raise ValueError(f'untested image for {tag}; load the exact reviewed image before deploying')
    if frontend is not None:
        files = {}
        for path in sorted(frontend.rglob('*')):
            if path.is_symlink():
                raise ValueError('symlink in frontend artifact')
            if path.is_file():
                if frontend == authorization.parent / 'frontend':
                    protected(path)
                files[path.relative_to(frontend).as_posix()] = sha256(path)
        if not files or files != inventory.get('frontend_files'):
            raise ValueError('frontend artifact differs from reviewed release')
    print(json.dumps({'artifacts_verified': True, 'candidate_sha256': auth['candidate_sha256']}))

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('inventory', 'check', 'artifacts'))
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--operation', required=True, choices=('full', 'ai', 'rengine', 'website'))
    parser.add_argument('--service', default='all', choices=('all', 'ai', 'language'))
    parser.add_argument('--store', default='all', choices=('all', 'grocery', 'jewelry', 'electronics', 'pharmacy'))
    parser.add_argument('--preserve-ai', action='store_true')
    parser.add_argument('--bootstrap', type=Path)
    parser.add_argument('--frontend', type=Path)
    parser.add_argument('--domain')
    parser.add_argument('--capture-images', action='store_true', help='Capture already qualified local image IDs for operator review')
    args = parser.parse_args(argv)
    try:
        if args.action == 'inventory':
            inventory = dict(schema_version=1,
                                  deployment=dict(operation=args.operation, service=args.service,
                                                  store=args.store, preserve_ai=args.preserve_ai),
                                  source_files=source_inventory(args.source, args.operation, args.service, args.preserve_ai))
            if args.operation == 'full':
                inventory['bootstrap_sha256'] = sha256(args.bootstrap or args.source / 'deploy/ec2/bootstrap.env')
            if args.operation == 'website':
                if not args.domain:
                    raise ValueError('--domain is required for website inventory')
                inventory['domain'] = args.domain
            if args.capture_images:
                inventory['image_ids'] = {tag: subprocess.run(
                    ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], check=True,
                    capture_output=True, text=True).stdout.strip()
                    for tag in sorted(expected_tags(args.operation, args.service, args.preserve_ai))}
            if args.frontend:
                inventory['frontend_files'] = {}
                for path in sorted(args.frontend.rglob('*')):
                    if path.is_symlink():
                        raise ValueError('frontend export must not contain symlinks')
                    if path.is_file():
                        inventory['frontend_files'][path.relative_to(args.frontend).as_posix()] = sha256(path)
            print(json.dumps(inventory, sort_keys=True, indent=2))
        elif args.action == 'artifacts':
            enforce(args.source, args.operation, args.service, args.store, args.preserve_ai, bootstrap=args.bootstrap, domain=args.domain)
            check_artifacts(args.operation, args.service, args.preserve_ai, args.frontend)
        else:
            enforce(args.source, args.operation, args.service, args.store, args.preserve_ai, bootstrap=args.bootstrap, domain=args.domain)
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        print(json.dumps({'authorized': False, 'blocker': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
