"""Build and verify native commerce release bundles against disposable providers."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

import commerce_reliability as baseline

BINARIES = ('api-gateway', 'analytics-worker', 'engagement-worker', 'seed-admin', 'sync-reports')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_bundle(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'release.json').read_text())
    baseline.check(manifest['schema_version'] == 1, 'Unsupported release manifest')
    baseline.check(manifest['host'] == [platform.system(), platform.machine()], 'Bundle platform mismatch')
    baseline.check(manifest['profile'] in ('debug', 'release'), 'Invalid bundle profile')
    baseline.check(set(manifest['binaries']) == set(BINARIES), 'Incomplete release bundle')
    for name in BINARIES:
        path = directory / name
        baseline.check(not path.is_symlink() and path.is_file() and os.access(path, os.X_OK), 'Invalid bundle executable')
        baseline.check(digest(path) == manifest['binaries'][name], 'Bundle binary checksum mismatch')
    source = json.loads((directory / 'source-manifest.json').read_text())
    baseline.check(hashlib.sha256(json.dumps(source['files'], sort_keys=True).encode()).hexdigest()
                   == source['sha256'] == manifest['source_sha256'], 'Bundle source manifest mismatch')
    expected_migrations = {p: h for p, h in source['files'].items()
                           if p.startswith(('commerce-api/rocento-api/migrations/', 'commerce-api/rocento-api/engagement-migrations/'))}
    baseline.check(manifest['migration_files'] == expected_migrations, 'Migration manifest mismatch')
    return manifest


def package(output, profile):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    source = baseline.source_manifest()
    baseline.write_json(output / 'source-manifest.json', source)
    subprocess.run(['python3', str(baseline.ROOT / 'commerce-ops/scripts/check-rust-architecture.py')], check=True)
    build = ['cargo', '+1.94.0', 'build', '--manifest-path', str(baseline.ROOT / 'commerce-api/rocento-api/Cargo.toml'),
             '--locked', '-p', 'api-gateway']
    for name in BINARIES:
        build += ['--bin', name]
    if profile == 'release':
        build.append('--release')
    with (output / 'build.log').open('wb') as log:
        subprocess.run(build, cwd=baseline.ROOT, env=baseline.host_environment(), stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=1800)
    for name in BINARIES:
        shutil.copy2(baseline.ROOT / 'commerce-api/rocento-api/target' / profile / name, output / name)
        (output / name).chmod(0o500)
    baseline.check(baseline.source_manifest() == source, 'Source changed during packaging')
    manifest = {'schema_version': 1, 'profile': profile, 'host': [platform.system(), platform.machine()],
                'git_revision': baseline.command(['git', 'rev-parse', 'HEAD']).decode().strip(),
                'source_sha256': source['sha256'], 'built_unix': time.time(),
                'binaries': {name: digest(output / name) for name in BINARIES},
                'migration_files': {p: h for p, h in source['files'].items()
                                    if p.startswith(('commerce-api/rocento-api/migrations/', 'commerce-api/rocento-api/engagement-migrations/'))}}
    baseline.write_json(output / 'release.json', manifest)
    load_bundle(output)
    print(f'Packaged {profile} release: {output}', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    build = sub.add_parser('package')
    build.add_argument('--output', required=True, type=Path)
    build.add_argument('--profile', choices=('debug', 'release'), default='release')
    image_build = sub.add_parser('build-image')
    image_build.add_argument('--output', required=True, type=Path)
    image_verify = sub.add_parser('verify-image')
    image_verify.add_argument('--candidate', required=True, type=Path)
    image_verify.add_argument('--concurrency', default='1,4,8', type=baseline.concurrency_levels)
    image_verify.add_argument('--iterations', default=5, type=int)
    verify = sub.add_parser('verify')
    verify.add_argument('--candidate', required=True, type=Path)
    verify.add_argument('--concurrency', default='1,4,8', type=baseline.concurrency_levels)
    verify.add_argument('--iterations', default=5, type=int)
    args = parser.parse_args(argv)
    if args.action == 'build-image':
        from commerce_image import build_image
        build_image(args.output)
        return 0
    if args.action == 'verify-image':
        return baseline.main(['--profile', 'release', '--candidate-image', str(args.candidate.resolve()),
                              '--analytics-faults', '--async-faults',
                              '--concurrency', ','.join(map(str, args.concurrency)), '--iterations', str(args.iterations)])
    if args.action == 'package':
        package(args.output, args.profile)
        return 0
    candidate = load_bundle(args.candidate)
    return baseline.main(['--profile', candidate['profile'], '--candidate-bundle', str(args.candidate.resolve()),
                          '--analytics-faults', '--async-faults',
                          '--concurrency', ','.join(map(str, args.concurrency)), '--iterations', str(args.iterations)])
