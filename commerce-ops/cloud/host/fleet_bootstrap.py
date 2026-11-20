#!/usr/bin/python3
"""One-shot Ubuntu release receiver. GitHub credentials never reach this host."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

CONFIG = Path('/etc/rocento/fleet-node.json')
ROOT = Path('/opt/rocento-bootstrap')
TOOLS = Path('/usr/local/lib/rocento')
PACKAGES_READY = Path('/etc/rocento/bootstrap-packages-ready')
RELEASES = Path('/etc/rocento/merchant-provisioning/releases')


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def extract(archive, destination):
    with tarfile.open(archive) as bundle:
        seen = set()
        for member in bundle.getmembers():
            parts = Path(member.name).parts
            if (not parts or member.name.startswith('/') or '..' in parts
                    or not (member.isfile() or member.isdir()) or member.name in seen
                    or member.mode & 0o7000):
                raise ValueError('UNSAFE_RELEASE_ARCHIVE')
            seen.add(member.name)
        bundle.extractall(destination, filter='data')


def release_permissions(destination):
    # Public frontend assets are consumed by non-root API/Nginx processes.
    # Keep release metadata/evidence private while allowing pathname traversal.
    paths = [destination, *destination.rglob('*')]
    if any(path.is_symlink() for path in paths):
        raise ValueError('UNSAFE_RELEASE_PATH')
    for path in paths:
        public = path == destination / 'artifacts' or destination / 'artifacts' in path.parents
        path.chmod((0o755 if path.is_dir() else 0o644) if public
                   else (0o700 if path.is_dir() else 0o600))
    destination.chmod(0o711)
    destination.parent.chmod(0o711)


def install(config, stream):
    if not PACKAGES_READY.exists():
        raise ValueError('HOST_BOOT_PENDING')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (ROOT / 'install-intent').exists():
            raise ValueError('BOOTSTRAP_RECONCILIATION_REQUIRED')
        pin = config['release']
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            stage = Path(temporary)
            archive = stage / 'bundle.tar'
            with archive.open('wb') as out:
                shutil.copyfileobj(stream, out, 1024 * 1024)
            if checksum(archive) != pin['sha256']:
                raise ValueError('RELEASE_BUNDLE_CHANGED')
            content = stage / 'content'
            content.mkdir()
            extract(archive, content)
            release = content / 'release'
            inventory = json.loads((release / 'inventory.json').read_text())
            if ('sha256:' + checksum(release / 'inventory.json') != config['releaseDigest']
                    or inventory['source']['revision'] != pin['revision']):
                raise ValueError('RELEASE_IDENTITY_MISMATCH')
            # Persist intent before any installation. An interrupted installation
            # is an operator reconciliation case, never an automatic replay.
            with (ROOT / 'install-intent').open('x') as marker:
                marker.write(pin['sha256'])
                marker.flush()
                os.fsync(marker.fileno())
            subprocess.run(['bash', str(content / 'source/commerce-ops/services/onboarding/install-fleet-node.sh')], check=True, stdout=sys.stderr)
            subprocess.run(['docker', 'load', '-i', str(content / 'images.tar')], check=True, stdout=sys.stderr)
            destination = RELEASES / config['releaseDigest'][7:]
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise ValueError('RELEASE_ALREADY_PRESENT')
            shutil.copytree(release, destination)
            release_permissions(destination)
            spec = importlib.util.spec_from_file_location('merchant', TOOLS / 'merchant-executor.py')
            merchant = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(merchant)
            merchant.authorized_release({'artifactDigest': config['releaseDigest'], 'releaseVersion': inventory['version']}, config)
            subprocess.run(['systemctl', 'is-active', 'rocento-metadata-firewall.service'], check=True, stdout=sys.stderr)
            (ROOT / 'ready').write_text(pin['sha256'])


def main():
    os.umask(0o077)
    config = json.loads(CONFIG.read_text())
    if (ROOT / 'ready').exists():
        if (ROOT / 'ready').read_text() != config['release']['sha256']:
            raise ValueError('BOOTSTRAP_IDENTITY_MISMATCH')
        os.execv(str(TOOLS / 'fleet-node.py'), [str(TOOLS / 'fleet-node.py')])
    header = sys.stdin.buffer.readline(65537)
    request = json.loads(header)
    if request['hostId'] != config['hostId']:
        raise ValueError('HOST_IDENTITY_MISMATCH')
    if not PACKAGES_READY.exists():
        raise ValueError('HOST_BOOT_PENDING')
    if request['operation'] == 'inspect':
        print(json.dumps({'hostId': config['hostId'], 'bootstrap': checksum(Path(__file__))}))
    elif request['operation'] == 'install-release':
        install(config, sys.stdin.buffer)
        print(json.dumps({'installed': True}))
    else:
        raise ValueError('HOST_BOOT_PENDING')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'BOOTSTRAP_FAILED'}))
        sys.exit(1)
