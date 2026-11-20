#!/usr/bin/env python3
"""Package CI-built candidate bytes; publishing requires existing release approval."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCES = [
    'commerce-ops/cloud/host/fleet_node.py',
    'commerce-ops/cloud/host/merchant_executor.py',
    'commerce-ops/cloud/host/merchant_templates.py',
    'commerce-ops/cloud/host/tenant_controls.py',
    'commerce-ops/workflows/release/release_readiness.py',
    *['commerce-ops/services/onboarding/' + name for name in (
        'install-fleet-node.sh', 'merchant-default.conf', 'metadata-firewall.nft', 'metadata-firewall.service')]]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--environment', required=True)
    parser.add_argument('--candidate', action='store_true', help='Export unapproved CI build for qualification only')
    args = parser.parse_args()
    release = args.release.resolve()
    raw = (release / 'inventory.json').read_bytes()
    inventory = json.loads(raw)
    digest = hashlib.sha256(raw).hexdigest()
    preparer = load('preparer', ROOT / 'commerce-ops/services/onboarding/prepare-merchant-candidate.py')
    preparer.verify_source_manifest(ROOT, inventory['source'])
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if inventory['source']['revision'] != revision:
        raise ValueError('RELEASE_SOURCE_REVISION_MISMATCH')
    if not args.candidate:
        policy = load('readiness', ROOT / 'commerce-ops/workflows/release/release_readiness.py')
        packet = release / ('readiness.' + args.environment + '.json')
        if not packet.exists():
            packet = release / 'readiness.json'
        blockers = policy.validate(json.loads(packet.read_text()), release, digest, args.environment)
        if blockers:
            raise ValueError('RELEASE_REVIEW_REQUIRED: ' + ', '.join(blockers))
    args.output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=args.output) as temp:
        stage = Path(temp)
        # Explicit source allowlist and candidate directory only; no host config.
        for relative in SOURCES:
            source = ROOT / relative
            target = stage / 'source' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for path in [release, *release.rglob('*')]:
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError('UNSAFE_RELEASE_FILE')
        shutil.copytree(release, stage / 'release')
        subprocess.run(['docker', 'save', '-o', str(stage / 'images.tar'), *sorted(set(inventory['images'].values()))], check=True)
        archive = args.output / 'merchant-release.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for name in ('source', 'release', 'images.tar'):
                bundle.add(stage / name, arcname=name)
    if archive.stat().st_size >= 2 * 1024**3:
        raise ValueError('GITHUB_RELEASE_ASSET_EXCEEDS_2_GIB')
    with archive.open('rb') as stream:
        bundle_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    (args.output / 'release-pin.json').write_text(json.dumps({
        'sha256': bundle_sha, 'inventoryDigest': 'sha256:' + digest,
        'revision': revision, 'approved': not args.candidate,
        'environment': args.environment}, indent=2) + '\n')


if __name__ == '__main__':
    main()
