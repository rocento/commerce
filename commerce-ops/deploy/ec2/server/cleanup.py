#!/usr/bin/env python3
"""Reclaim disposable deployment artifacts while retaining runtime and persistent data."""
import os
from pathlib import Path
import re
import shutil
import subprocess


def clean_releases(base):
    releases = base / 'releases'
    current = base / 'current'
    if not releases.exists():
        return
    if releases.is_symlink() or not current.is_symlink():
        print('[SKIP] Release cleanup: no trustworthy active release pointer')
        return
    active = current.resolve()
    if active.parent != releases.resolve() or not active.is_dir():
        print('[SKIP] Release cleanup: active release is outside the managed directory')
        return
    candidates = sorted(
        (p for p in releases.iterdir()
         if not p.is_symlink() and p.is_dir() and p.resolve() != active
         and (re.fullmatch(r'release-[A-Za-z0-9]{8}', p.name)
              or all((p / site / 'index.html').is_file()
                     and not (p / site).is_symlink()
                     for site in ('website', 'storefront', 'grocery-admin',
                                  'jewelry-admin', 'electronics-admin',
                                  'pharmacy-admin', 'mobile-admin')))),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    for path in candidates[2:]:
        print(f'[INFO] Removing obsolete frontend release: {path}', flush=True)
        shutil.rmtree(path)
    print('[OK] Active release and two newest rollback copies retained')


def clean_development_caches(root):
    # Only known disposable caches; never follow a path outside the checkout.
    root = root.resolve()
    for relative in ('.mypy_cache', '.pytest_cache', '.ruff_cache',
                     'commerce-assistant-platform/.mypy_cache', 'commerce-assistant-platform/.pytest_cache',
                     'commerce-assistant-platform/.ruff_cache', '.pnpm-store', 'commerce-web/.pnpm-store',
                     'commerce-web/playwright-report', 'commerce-web/test-results',
                     'commerce-web/node_modules', 'commerce-assistant-platform/.venv'):
        path = root / relative
        if path.is_symlink() or not path.is_dir() or not path.resolve().is_relative_to(root):
            continue
        print(f'[INFO] Removing disposable development cache: {relative}', flush=True)
        shutil.rmtree(path)
    # Published assets live under /var/www/rocento/releases. These source-tree
    # intermediates are excluded from upload and rebuilt in deployment containers.
    for relative in ('commerce-corporate-site/.next',):
        path = root / relative
        if path.is_symlink() or not path.is_dir() or not path.resolve().is_relative_to(root):
            continue
        print(f'[INFO] Removing disposable build output: {relative}', flush=True)
        shutil.rmtree(path)
    for relative in ('commerce-corporate-site/tsconfig.tsbuildinfo',):
        path = root / relative
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            continue
        print(f'[INFO] Removing disposable build metadata: {relative}', flush=True)
        path.unlink()


def clean_package_cache(root):
    if shutil.disk_usage(root).free // (1024 * 1024) >= 30000 or not shutil.which('apt-get'):
        return
    print('[INFO] Low disk space: clearing downloaded APT package cache.', flush=True)
    try:
        subprocess.run(['apt-get', 'clean'], check=True, timeout=120)
    except (subprocess.SubprocessError, OSError) as error:
        print(f'[WARN] Package cache cleanup could not finish: {error}')


def clean_build_cache(root):
    for options in (['--filter', 'until=24h'], ['--all']):
        if shutil.disk_usage(root).free // (1024 * 1024) >= 30000 or not shutil.which('docker'):
            return
        scope = 'older than 24 hours' if '--filter' in options else 'of any age (low-space fallback)'
        print(f'[INFO] Low disk space: pruning unused Docker build cache {scope}; later builds may take longer.', flush=True)
        try:
            subprocess.run(['docker', 'builder', 'prune', '--force', *options], check=True, timeout=300)
        except (subprocess.SubprocessError, OSError) as error:
            print(f'[WARN] Cache cleanup could not finish: {error}')
            return


def clean_dangling_images(root):
    if shutil.disk_usage(root).free // (1024 * 1024) >= 30000 or not shutil.which('docker'):
        return
    # Deliberately omit --all: keep tagged rollback images and every image used
    # by any container, including stopped containers. Recent build outputs stay.
    print('[INFO] Low disk space: pruning untagged, unused Docker images older than 24 hours.', flush=True)
    try:
        subprocess.run(['docker', 'image', 'prune', '--force', '--filter', 'until=24h'], check=True, timeout=300)
    except (subprocess.SubprocessError, OSError) as error:
        print(f'[WARN] Dangling image cleanup could not finish: {error}')


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run cleanup through sudo bash deploy/ec2/server/ec2-up.sh')
    root = next(parent for parent in Path(__file__).resolve().parents if (parent / 'commerce-api/rocento-api/Cargo.toml').is_file())
    before = shutil.disk_usage(root).free
    clean_development_caches(root)
    clean_releases(Path('/var/www/rocento'))
    clean_package_cache(root)
    clean_dangling_images(root)
    clean_build_cache(root)
    after = shutil.disk_usage(root).free
    print(f'[OK] Cleanup reclaimed {max(0, after-before) // (1024*1024)} MiB; {after // (1024*1024)} MiB available')
    print('[INFO] Removed artifacts can be rebuilt. Volumes, tagged/container-used images, recent images, containers, secrets and source were retained.')


if __name__ == '__main__':
    main()
