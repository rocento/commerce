#!/usr/bin/env python3
"""Publish a verified website export and its narrowly scoped documentation policy.

Run on the existing EC2 installation. Other sites, application containers,
databases, secrets and full-deployment fingerprints are left untouched.
"""
import argparse
import fcntl
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import time


POLICY_PATH = Path(__file__).resolve().parents[1] / 'configure.py'
spec = importlib.util.spec_from_file_location('website_docs_policy', POLICY_PATH)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

SITES = ('website', 'storefront', 'grocery-admin', 'jewelry-admin',
         'electronics-admin', 'pharmacy-admin', 'mobile-admin')
REQUIRED = ('index.html', 'docs/api/index.html', 'docs/api/openapi.json',
            'docs/api/reference/index.html')


def validate_export(source):
    if not source.is_dir() or source.is_symlink():
        raise ValueError('Source must be a real, verified export directory.')
    for entry in source.rglob('*'):
        if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
            raise ValueError(f'Export contains a link or special file: {entry}')
        if entry.name.startswith('.env') or entry.suffix in ('.pem', '.key'):
            raise ValueError(f'Export contains a private configuration file: {entry}')
    for filename in REQUIRED:
        if not (source / filename).is_file() or not (source / filename).stat().st_size:
            raise ValueError(f'Export is missing {filename}.')
    contract = json.loads((source / 'docs/api/openapi.json').read_text())
    if not contract.get('paths') or not contract.get('openapi'):
        raise ValueError('Public OpenAPI document is empty or invalid.')
    if any('/admin/' in route or route.startswith(('/internal/', '/metrics'))
           for route in contract['paths']):
        raise ValueError('Public reference contains a private API route.')


def current_release(base):
    pointer, releases = base / 'current', base / 'releases'
    if not pointer.is_symlink() or releases.is_symlink():
        raise ValueError('Expected the existing managed frontend release layout.')
    previous = pointer.resolve(strict=True)
    if previous.parent != releases.resolve(strict=True):
        raise ValueError('Active frontend release is outside the managed releases directory.')
    for site in SITES:
        if (previous / site).is_symlink() or not (previous / site / 'index.html').is_file():
            raise ValueError(f'Active release is missing a regular {site} directory.')
    return previous


def atomic_write(path, data):
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def activate(base, release):
    temporary = base / f'current.website-{os.getpid()}-{secrets.token_hex(4)}'
    try:
        temporary.symlink_to(release)
        temporary.replace(base / 'current')
    finally:
        temporary.unlink(missing_ok=True)


def run(command):
    subprocess.run(command, check=True)


class OriginVerificationError(RuntimeError):
    pass


def retry_origin_probe(check, timeout=5.0, interval=0.25,
                       now=time.monotonic, pause=time.sleep):
    """Allow gracefully reloading Nginx workers to converge, then fail closed."""
    deadline = now() + timeout
    while True:
        try:
            # Each attempt must pass the complete set of route/header checks.
            return check(deadline)
        except (OriginVerificationError, OSError, http.client.HTTPException, json.JSONDecodeError):
            remaining = deadline - now()
            if remaining <= 0:
                raise
            pause(min(interval, remaining))
            if now() >= deadline:
                raise


def origin_probe(domain, certificate):
    # Trust the configured origin certificate as a scoped trust anchor. Verify
    # the hostname and certificate, even though the socket connects to loopback.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(certificate))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN

    class OriginConnection(http.client.HTTPSConnection):
        def connect(self):
            self.sock = context.wrap_socket(
                socket.create_connection(('127.0.0.1', 443), timeout=self.timeout),
                server_hostname=self.host)

    def fetch(host, path, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Origin verification did not converge within five seconds.')
        connection = OriginConnection(host, timeout=remaining, context=context)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def probe_once(deadline):
        for path in ('/docs/api/', '/docs/api/reference/index.html', '/docs/api/openapi.json'):
            status, headers, content = fetch(domain, path, deadline)
            headers = {key.lower(): value for key, value in headers.items()}
            if status != 200 or headers.get('x-content-type-options') != 'nosniff':
                raise OriginVerificationError(f'Origin documentation verification failed: {path} ({status}).')
            if 'reference/' in path and "default-src 'none'" not in headers.get('content-security-policy', ''):
                raise OriginVerificationError('Origin Swagger reference is missing its strict CSP.')
            if path.endswith('openapi.json'):
                json.loads(content)
        for subdomain in ('grocery', 'admin', 'jewelry', 'jewelry-admin',
                          'electronics', 'electronics-admin', 'pharmacy', 'pharmacy-admin'):
            status, _, _ = fetch(f'{subdomain}.{domain}', '/api/openapi.json', deadline)
            if status != 404:
                raise OriginVerificationError(f'Private contract is not blocked on {subdomain} ({status}).')
    return lambda: retry_origin_probe(probe_once)


def publish(source, base, nginx_file, domain, runner=run, probe=lambda: None, dry_run=False):
    validate_export(source)
    previous = current_release(base)
    if source.resolve().is_relative_to(base.resolve()):
        raise ValueError('Stage the new export outside the live frontend directory.')
    if nginx_file.is_symlink() or not nginx_file.is_file():
        raise ValueError('Expected a regular managed Nginx configuration file.')
    old_config = nginx_file.read_bytes()
    candidate = policy.secure_merchant_api_docs_nginx(
        policy.secure_api_docs_nginx(old_config.decode(), domain), domain).encode()
    if dry_run:
        return {'previous': str(previous), 'nginx_changed': candidate != old_config, 'dry_run': True}

    # An independent copy preserves all store/admin assets and the previous
    # rollback release. Never write through hard links into the active release.
    release = base / 'releases' / f'release-{secrets.token_hex(4)}'
    config_changed = False
    activated = False
    try:
        shutil.copytree(previous, release, symlinks=True)
        shutil.rmtree(release / 'website')
        shutil.copytree(source, release / 'website')
        for entry in (release / 'website', *(release / 'website').rglob('*')):
            entry.chmod(0o755 if entry.is_dir() else 0o644)
        if candidate != old_config:
            atomic_write(nginx_file, candidate)
            config_changed = True
        runner(['nginx', '-t'])
        if config_changed:
            runner(['systemctl', 'reload', 'nginx'])
        activate(base, release)
        activated = True
        probe()
        return {'release': str(release), 'previous': str(previous), 'nginx_changed': config_changed}
    except BaseException:
        if activated:
            activate(base, previous)
        if config_changed:
            atomic_write(nginx_file, old_config)
            runner(['nginx', '-t'])
            runner(['systemctl', 'reload', 'nginx'])
        if release.is_dir() and (base / 'current').resolve() != release.resolve():
            shutil.rmtree(release)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Verified website static export, staged outside /var/www/rocento.')
    parser.add_argument('--root', type=Path, default=Path('/opt/rocento'))
    parser.add_argument('--domain', default='rocento.com')
    parser.add_argument('--nginx-config', type=Path, default=Path('/etc/nginx/sites-available/rocento'),
                        help='Existing regular Nginx configuration serving the corporate domain.')
    parser.add_argument('--origin-certificate', type=Path, default=Path('/etc/nginx/ssl/rocento-origin.pem'),
                        help='Existing origin certificate used to verify HTTPS after publication.')
    parser.add_argument('--dry-run', action='store_true', help='Validate the export and existing routing without publishing.')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo on the existing EC2 deployment.')
    policy.validate_domain(args.domain)
    if not (args.root / 'deploy/ec2/setup.lock').is_file():
        parser.error('An existing full deployment with its setup.lock is required.')
    def interrupted(signum, frame):
        raise RuntimeError(f'Website publication interrupted by signal {signum}.')
    for signum in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(signum, interrupted)
    with (args.root / 'deploy/ec2/setup.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('Another deployment or seed is active. Wait for it to finish.')
        if not args.dry_run:
            subprocess.run(['python3', str(args.root / 'commerce-ops/scripts/release/deployment_gate.py'),
                            'check', '--source', str(args.source), '--operation', 'website',
                            '--domain', args.domain], check=True)
        result = publish(args.source, Path('/var/www/rocento'),
                         args.nginx_config, args.domain,
                         probe=origin_probe(args.domain, args.origin_certificate),
                         dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
