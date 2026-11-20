#!/usr/bin/python3
"""Verify one exact unapproved candidate with disposable tenant resources."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

EXECUTOR = Path('/usr/local/lib/rocento/merchant-executor.py')
TEMPLATES = EXECUTOR.with_name('merchant_templates.py')
POLICY = Path('/usr/local/lib/rocento/release_readiness.py')
ROOT = Path('/opt/rocento-onboarding/candidate-verification')


def load_executor():
    spec = importlib.util.spec_from_file_location('executor', EXECUTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate_inventory(executor, directory, candidate):
    """Verify integrity without requiring or creating release authorization."""
    if executor.sha(directory / 'inventory.json') != candidate:
        raise ValueError('CANDIDATE_INVENTORY_CHANGED')
    inventory = executor.read_json(directory / 'inventory.json')
    if inventory.get('schemaVersion') not in (1, 2):
        raise ValueError('INVALID_CANDIDATE')
    executor.release_themes(inventory)
    architecture = {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(os.uname().machine)
    if inventory['architecture'] != architecture:
        raise ValueError('CANDIDATE_ARCHITECTURE_MISMATCH')
    for name, path in [('executor', EXECUTOR), ('templates', TEMPLATES), ('policy', POLICY)]:
        if executor.sha(path) != inventory['tools'][name]:
            raise ValueError('CANDIDATE_TOOL_CHANGED')
    if executor.sha(Path(__file__)) != inventory['source']['tools']['verifier']:
        raise ValueError('CANDIDATE_VERIFIER_CHANGED')
    if set(inventory['images']) != {'api', 'postgres', 'nats', 'meili', 'minio', 'clickhouse'}:
        raise ValueError('CANDIDATE_IMAGE_SET_INVALID')
    for identity in inventory['images'].values():
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', identity):
            raise ValueError('CANDIDATE_IMAGE_NOT_PINNED')
        details = json.loads(executor.command(['docker', 'image', 'inspect', identity]))[0]
        if details['Id'] != identity or details['Architecture'] != architecture or details['Os'] != 'linux':
            raise ValueError('CANDIDATE_IMAGE_CHANGED')
    artifacts = directory / 'artifacts'
    if any(path.is_symlink() for path in artifacts.rglob('*')):
        raise ValueError('CANDIDATE_ARTIFACT_SYMLINK')
    actual = {str(path.relative_to(artifacts)) for path in artifacts.rglob('*') if path.is_file()}
    if set(inventory['files']) != actual or not executor.required_artifacts(inventory) <= actual:
        raise ValueError('CANDIDATE_ARTIFACT_SET_CHANGED')
    for name, checksum in inventory['files'].items():
        if Path(name).is_absolute() or '..' in Path(name).parts or executor.sha(artifacts / name) != checksum:
            raise ValueError('CANDIDATE_ARTIFACT_CHANGED')
    return inventory


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--disposable', action='store_true', required=True)
    parser.add_argument('--candidate-sha256', required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[0-9a-f]{64}', args.candidate_sha256):
        parser.error('--candidate-sha256 must be the lowercase inventory SHA-256')
    if os.geteuid() != 0:
        raise SystemExit('Run on the deployment host as root')
    os.umask(0o077)
    executor = load_executor()
    release = executor.CONFIG / 'releases' / args.candidate_sha256
    inventory = candidate_inventory(executor, release, args.candidate_sha256)
    for theme in executor.release_themes(inventory):
        verify_theme(executor, release, inventory, args.candidate_sha256, theme)


def verify_theme(executor, release, inventory, candidate_sha256, theme):
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A fresh project and directory cannot silently reuse volumes from an older run.
    root = Path(tempfile.mkdtemp(dir=ROOT, prefix='runtime-'))
    job = {'tenantId': str(uuid.uuid4()), 'storefrontHost': 'candidate.rocento.com',
           'adminHost': 'candidate-admin.rocento.com', 'themeId': theme}
    binding = dict(job, gatewayPort=18999, adminEmail='candidate@example.test')
    fixture = root / 'fixture-config'
    fixture.mkdir(mode=0o700)
    (fixture / 'smtp.json').write_text(json.dumps({'SMTP_HOST': 'smtp.invalid', 'SMTP_PORT': '587',
        'SMTP_USERNAME': 'fixture', 'SMTP_PASSWORD': 'fixture-not-real', 'NOTIFICATION_FROM': 'fixture@example.test'}))
    executor.CONFIG = fixture
    executor.prepare_credentials(root)
    (root / 'compose.json').write_text(json.dumps(executor.render_compose(job, binding, inventory, release)))
    report = {'candidate_sha256': candidate_sha256, 'environment': inventory.get('configuration', {}).get('environment', 'unspecified'),
              'mode': 'disposable-acceptance', 'theme': theme,
              'fixture': job['tenantId'], 'images': inventory['images'], 'checks': {},
              'coverage': 'Disposable exact-image runtime, fresh migrations, selected industry/admin bootstrap and container isolation',
              'limitations': ['public ingress', 'browser journeys', 'external email', 'existing-schema upgrade',
                              'cross-tenant API authorization', 'capacity qualification', 'independent approval']}
    try:
        executor.start_runtime(root, theme)
        executor.bootstrap(root, binding, release)
        executor.verify_admin_and_theme(root, binding)
        executor.check_isolation(root, inventory, job, release)
        executor.bootstrap(root, binding, release)
        executor.verify_admin_and_theme(root, binding)
        candidate_inventory(executor, release, candidate_sha256)
        report['checks'] = {key: 'passed' for key in ('runtime', 'industryInstall', 'adminLogin', 'themePublish',
                                                    'repeatBootstrap', 'containerIsolation', 'candidateIntegrity')}
    except Exception as error:
        report['failureType'] = type(error).__name__
        raise
    finally:
        try:
            logs = subprocess.run(['docker', 'compose', '--env-file', str(root / 'runtime.env'), '-f',
                                   str(root / 'compose.json'), 'logs', '--tail', '60'],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            (root / 'private-runtime.log').write_bytes(logs.stdout)
            report['logCollection'] = 'passed' if logs.returncode == 0 else 'failed'
        except (OSError, subprocess.TimeoutExpired):
            # Diagnostics failure must never prevent removal of this disposable project.
            report['logCollection'] = 'failed'
        try:
            executor.compose(root, 'down', '-v')
            report['cleanup'] = 'passed'
        except Exception:
            report['cleanup'] = 'failed'
            raise
        finally:
            report['completed_at'] = datetime.now(timezone.utc).isoformat()
            (root / 'runtime-evidence.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'evidence': str(root / 'runtime-evidence.json'), **report}))


if __name__ == '__main__':
    main()
