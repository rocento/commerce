#!/usr/bin/python3
"""Prepare an immutable four-demo merchant candidate and an explicitly UNAPPROVED packet.

Write a source manifest before building, label each application image with its
component SHA-256, then prepare on the test host using that same manifest.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SOURCE = Path('/home/ubuntu/commerce-ai')
CONFIG = Path('/etc/rocento/merchant-provisioning')
TOOLS = Path('/usr/local/lib/rocento')
IMAGES = {
    'api': 'rocento-merchant-api:candidate-20261112', 'postgres': 'postgres:16-bookworm',
    'nats': 'nats:2.11-alpine', 'meili': 'getmeili/meilisearch:v1.15',
    'minio': 'rocento-minio:candidate-20251015', 'clickhouse': 'clickhouse/clickhouse-server:25.8',
}
THEMES = ('grocery', 'jewelry', 'electronics', 'pharmacy')
WEB_IMAGE = 'rocento-merchant-web:candidate-20261112'
BUILD_ROOTS = {
    'api': ('commerce-api/rocento-api',),
    'web': ('commerce-web/package.json', 'commerce-web/pnpm-lock.yaml',
            'commerce-web/pnpm-workspace.yaml', 'commerce-web/apps', 'commerce-web/packages',
            'commerce-web/Dockerfile.merchant-release',
            'commerce-web/Dockerfile.merchant-release.dockerignore'),
    'minio': ('commerce-ops/services/onboarding/Dockerfile.minio',
              'commerce-ops/services/onboarding/minio'),
}
TOOL_SOURCES = {
    'executor': 'commerce-ops/cloud/host/merchant_executor.py',
    'templates': 'commerce-ops/cloud/host/merchant_templates.py',
    'policy': 'commerce-ops/workflows/release/release_readiness.py',
    'preparer': 'commerce-ops/services/onboarding/prepare-merchant-candidate.py',
    'verifier': 'commerce-ops/services/onboarding/verify-merchant-candidate.py',
}
EXCLUDED_DIRECTORIES = {
    '.git', '.next', '.turbo', '.cache', '__pycache__', 'node_modules', 'target',
    'dist', 'dist-server', 'test-results', 'playwright-report',
}


def run(args):
    return subprocess.check_output(args)


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Source/artifact must be a regular non-symlink file')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def theme_dependencies(source, theme):
    configuration = json.loads((source / 'commerce-demo' / theme / 'theme.json').read_text())
    assets, categories = set(), set()
    def visit(value):
        if isinstance(value, dict):
            for item in value.values(): visit(item)
        elif isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, str):
            if value.startswith('asset:'): assets.add(value[6:])
            elif value.startswith(('category:', 'category-link:')): categories.add(value.split(':', 1)[1])
    visit(configuration)
    for asset in assets:
        if not re.fullmatch(re.escape(theme) + r'/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)', asset):
            raise ValueError('Unsafe theme asset reference')
        digest(source / 'commerce-assets/demo' / asset)
    definitions = {}
    if categories:
        preset = json.loads((source / 'commerce-demo' / theme / 'preset.json').read_text())
        definitions = {row['slug']: {'slug': row['slug'], 'name': row['name']} for row in preset['categories'] if row['slug'] in categories}
        if set(definitions) != categories:
            raise ValueError('Unknown theme category reference')
    return {'assets': sorted(assets), 'categories': definitions}


def source_files(source, roots):
    files = {}
    for relative in roots:
        root = source / relative
        if root.is_symlink():
            raise ValueError('Source symlinks are not supported')
        if root.is_file():
            files[relative] = digest(root)
            continue
        if not root.is_dir():
            raise ValueError('Required source is missing')
        for directory, directories, names in os.walk(root):
            directories[:] = sorted(name for name in directories
                                    if name not in EXCLUDED_DIRECTORIES and not name.startswith('.env'))
            if any((Path(directory) / name).is_symlink() for name in directories):
                raise ValueError('Source symlinks are not supported')
            for name in sorted(names):
                if name.startswith('.env') or name == '.DS_Store' or name.endswith(('.log', '.pyc')):
                    continue
                path = Path(directory) / name
                files[str(path.relative_to(source))] = digest(path)
    return files


def source_manifest(source, revision):
    if not re.fullmatch(r'[0-9a-f]{40,64}', revision):
        raise ValueError('An explicit full Git source revision is required')
    components = {}
    for name, roots in BUILD_ROOTS.items():
        files = source_files(source, roots)
        components[name] = {'sha256': hashlib.sha256(canonical(files)).hexdigest(), 'files': files}
    tools = {name: digest(source / path) for name, path in TOOL_SOURCES.items()}
    themes = {theme: digest(source / 'commerce-demo' / theme / 'theme.json') for theme in THEMES}
    inputs = {}
    for theme in THEMES:
        dependencies = theme_dependencies(source, theme)
        if dependencies['categories']:
            path = 'commerce-demo/' + theme + '/preset.json'
            inputs[path] = digest(source / path)
        for asset in dependencies['assets']:
            path = 'commerce-assets/demo/' + asset
            inputs[path] = digest(source / path)
    return {'schemaVersion': 1, 'revision': revision, 'components': components,
            'tools': tools, 'themes': themes, 'themeInputs': inputs,
            'scope': 'Selected build inputs including uncommitted changes; no claim of a clean checkout'}


def verify_source_manifest(source, manifest):
    if source_manifest(source, manifest['revision']) != manifest:
        raise ValueError('Source differs from the pre-build manifest')


def verify_image_provenance(images, web, manifest):
    for component, info in [('api', images['api']), ('minio', images['minio']), ('web', web)]:
        if (info['Config'].get('Labels') or {}).get('io.rocento.source.sha256') != manifest['components'][component]['sha256']:
            raise ValueError('Image source label does not match the pre-build manifest: ' + component)


def load_image_ids(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate image role')
            result[key] = value
        return result
    identities = json.loads(path.read_text(), object_pairs_hook=unique_object)
    if (not isinstance(identities, dict) or set(identities) != {*IMAGES, 'web'}
            or any(not isinstance(value, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value)
                   for value in identities.values())):
        raise ValueError('Image IDs must contain every runtime role and web, using immutable lowercase sha256 IDs')
    return identities


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--write-source-manifest', type=Path)
    mode.add_argument('--source-manifest', type=Path)
    parser.add_argument('--source-revision')
    parser.add_argument('--environment', default='aws-merchant-production',
                        help='Exact target installation for the unapproved readiness packet')
    parser.add_argument('--release-version', default='merchant-20261118',
                        help='Operator-selected release version; immutable inventory remains authoritative')
    parser.add_argument('--output-directory', type=Path,
                        help='Create an unapproved local draft in a new directory; never install authorization')
    image_overrides = parser.add_mutually_exclusive_group()
    image_overrides.add_argument('--minio-image-id',
                                 help='Use an existing immutable MinIO image ID without changing any tags')
    image_overrides.add_argument('--image-ids', type=Path,
                                 help='JSON map of all six runtime roles plus web to immutable IDs on the selected Docker engine')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[a-z0-9-]+', args.environment):
        parser.error('--environment must contain lowercase letters, digits and hyphens')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', args.release_version):
        parser.error('--release-version must be a simple version identifier')
    if args.minio_image_id and not re.fullmatch(r'sha256:[0-9a-f]{64}', args.minio_image_id):
        parser.error('--minio-image-id requires an immutable lowercase sha256 image ID')
    identities = None
    if args.image_ids:
        try:
            identities = load_image_ids(args.image_ids)
        except (OSError, ValueError):
            parser.error('--image-ids requires valid JSON with exactly api, postgres, nats, meili, minio, clickhouse, web and immutable lowercase sha256 IDs')
    source = args.source.resolve()
    if args.write_source_manifest:
        if args.output_directory or args.minio_image_id or args.image_ids:
            parser.error('--output-directory and image overrides require --source-manifest')
        revision = args.source_revision or run(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip()
        manifest = source_manifest(source, revision)
        with args.write_source_manifest.open('xb') as output:
            output.write(canonical(manifest))
        print(json.dumps({'sourceManifest': str(args.write_source_manifest),
                          'buildLabels': {name: item['sha256'] for name, item in manifest['components'].items()}}))
        return
    draft = args.output_directory.resolve() if args.output_directory else None
    if draft and draft.exists():
        raise SystemExit('Local candidate output directory must be new')
    if draft is None and os.geteuid() != 0:
        raise SystemExit('Run candidate preparation on the deployment host as root')
    manifest = json.loads(args.source_manifest.read_text())
    verify_source_manifest(source, manifest)
    if draft:
        draft.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        stage_parent = draft.parent
        policy_path = source / TOOL_SOURCES['policy']
        tool_paths = {key: source / TOOL_SOURCES[key] for key in ('executor', 'templates', 'policy')}
    else:
        CONFIG.mkdir(parents=True, exist_ok=True, mode=0o755)
        (CONFIG / 'releases').mkdir(exist_ok=True, mode=0o755)
        stage_parent = CONFIG
        policy_path = TOOLS / 'release_readiness.py'
        tool_paths = {'executor': TOOLS / 'merchant-executor.py', 'templates': TOOLS / 'merchant_templates.py', 'policy': policy_path}
    references = {key: identities[key] for key in IMAGES} if identities else dict(IMAGES)
    if args.minio_image_id:
        references['minio'] = args.minio_image_id
    images = {key: json.loads(run(['docker', 'image', 'inspect', value]))[0] for key, value in references.items()}
    for key, reference in references.items():
        if reference.startswith('sha256:') and images[key]['Id'] != reference:
            raise SystemExit('Image identity does not match the requested immutable ID: ' + key)
    web_reference = identities['web'] if identities else WEB_IMAGE
    web = json.loads(run(['docker', 'image', 'inspect', web_reference]))[0]
    if identities and web['Id'] != web_reference:
        raise SystemExit('Image identity does not match the requested immutable ID: web')
    verify_image_provenance(images, web, manifest)
    arch = images['api']['Architecture']
    if any(image['Architecture'] != arch or image['Os'] != 'linux' for image in [*images.values(), web]):
        raise SystemExit('Image architectures or operating systems do not match')
    installed_tools = {key: digest(path) for key, path in tool_paths.items()}
    if any(manifest['tools'][key] != value for key, value in installed_tools.items()):
        raise SystemExit('Installed tools do not match candidate source')
    with tempfile.TemporaryDirectory(dir=stage_parent, prefix='.candidate-') as temp:
        stage = Path(temp)
        artifacts = stage / 'artifacts'
        artifacts.mkdir()
        container = run(['docker', 'create', web['Id'], '/unused']).decode().strip()
        try:
            for name in ('storefront', 'admin'):
                run(['docker', 'cp', container + ':/' + name, str(artifacts / name)])
        finally:
            run(['docker', 'rm', container])
        (artifacts / 'themes').mkdir()
        for theme in THEMES:
            shutil.copyfile(source / 'commerce-demo' / theme / 'theme.json', artifacts / 'themes' / (theme + '.json'))
            dependencies = theme_dependencies(source, theme)
            (artifacts / 'themes' / (theme + '.dependencies.json')).write_bytes(canonical(dependencies))
            for asset in dependencies['assets']:
                destination = artifacts / 'theme-assets' / asset
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / 'commerce-assets/demo' / asset, destination)
        if any(path.is_symlink() for path in artifacts.rglob('*')):
            raise SystemExit('Candidate artifacts contain symlinks')
        files = {str(p.relative_to(artifacts)): digest(p) for p in sorted(artifacts.rglob('*')) if p.is_file()}
        migrations = {path: sha for path, sha in manifest['components']['api']['files'].items()
                      if path.startswith(('commerce-api/rocento-api/migrations/',
                                          'commerce-api/rocento-api/engagement-migrations/'))}
        if not migrations:
            raise SystemExit('Candidate migration set is empty')
        inventory = {'schemaVersion': 2, 'themes': list(THEMES), 'version': args.release_version,
                     'architecture': arch, 'images': {key: image['Id'] for key, image in images.items()},
                     'files': files, 'tools': installed_tools, 'source': manifest, 'migrations': migrations,
                     'frontendImage': web['Id'],
                     'imageProvenance': {key: {'id': info['Id'], 'repoDigests': info.get('RepoDigests', [])}
                                         for key, info in [*images.items(), ('web', web)]},
                     'configuration': {'executorTemplateSha256': installed_tools['executor'],
                                       'environment': args.environment,
                                       'scope': 'Runtime topology, limits and ingress templates; private credentials excluded'}}
        verify_source_manifest(source, manifest)
        raw = canonical(inventory)
        candidate = hashlib.sha256(raw).hexdigest()
        destination = draft if draft else CONFIG / 'releases' / candidate
        if destination.exists():
            if draft:
                raise SystemExit('Local candidate output directory must be new')
            if (destination / 'inventory.json').read_bytes() != raw:
                raise SystemExit('Existing candidate differs')
            print(json.dumps({'candidate': 'sha256:' + candidate, 'directory': str(destination), 'approved': False}))
            return
        (stage / 'inventory.json').write_bytes(raw)
        spec = importlib.util.spec_from_file_location('readiness', policy_path)
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        (stage / 'readiness.json').write_bytes(canonical(policy.template(candidate, args.environment, 'codex-candidate-preparation')))
        for item in [stage, *stage.rglob('*')]:
            item.chmod(0o755 if item.is_dir() else 0o644)
        (stage / 'readiness.json').chmod(0o600)
        stage.rename(destination)
        print(json.dumps({'candidate': 'sha256:' + candidate, 'directory': str(destination), 'approved': False}))


if __name__ == '__main__':
    main()
