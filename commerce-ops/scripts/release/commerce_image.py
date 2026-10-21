"""Build a frozen backend image and run the commerce gate against its immutable ID."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

import commerce_reliability as baseline

BINARIES = ('api-gateway', 'seed-admin', 'sync-reports', 'export-worker', 'install-catalog-data',
            'prepare-storefront-images', 'engagement-worker', 'analytics-worker')


def require_local_docker():
    endpoint = baseline.command(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).decode().strip()
    baseline.check(endpoint.startswith('unix://'), 'Image verification requires local Unix-socket Docker')


def binary_hashes(identity):
    hashes = baseline.command(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', identity,
                               *['/usr/local/bin/' + name for name in BINARIES]])
    return {Path(path).name: digest for digest, path in (line.split() for line in hashes.decode().splitlines())}


def inspect_image(identity):
    return json.loads(baseline.command(['docker', 'image', 'inspect', identity]))[0]


def build_image(output):
    require_local_docker()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    context = output / 'backend'
    shutil.copytree(baseline.ROOT / 'commerce-api/rocento-api', context,
                    ignore=shutil.ignore_patterns('target', '.git', '.env', '.env.*', '*.log', '.DS_Store'))
    files = {str(p.relative_to(context)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(context.rglob('*')) if p.is_file()}
    source_hash = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    baseline.write_json(output / 'image-source-manifest.json', {'sha256': source_hash, 'files': files})
    revision = baseline.command(['git', 'rev-parse', 'HEAD']).decode().strip()
    subprocess.run(['python3', str(baseline.ROOT / 'commerce-ops/scripts/checks/check-rust-architecture.py'),
                    '--manifest-path', str(context / 'Cargo.toml'), '--policy', str(context / 'architecture-policy.json')], check=True)
    with (output / 'image-build.log').open('wb') as log:
        subprocess.run(['docker', 'build', '--pull', '--progress=plain', '--iidfile', str(output / 'image-id'),
                        '--label', 'org.opencontainers.image.revision=' + revision,
                        '--label', 'io.rocento.source.sha256=' + source_hash, str(context)],
                       env=baseline.host_environment(), stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=3600)
    identity = (output / 'image-id').read_text().strip()
    info = inspect_image(identity)
    manifest = {'schema_version': 1, 'profile': 'release', 'image_id': identity,
                'repo_digests': info['RepoDigests'], 'git_revision': revision, 'source_sha256': source_hash,
                'os': info['Os'], 'architecture': info['Architecture'], 'user': info['Config']['User'],
                'binaries': binary_hashes(identity)}
    baseline.write_json(output / 'release-image.json', manifest)
    load_image(output)
    print(f'Built release image {identity}; evidence: {output}', flush=True)


def load_image(directory):
    require_local_docker()
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'release-image.json').read_text())
    baseline.check(manifest['schema_version'] == 1 and manifest['profile'] == 'release', 'Invalid image manifest')
    identity = manifest['image_id']
    baseline.check(identity.startswith('sha256:') and len(identity) == 71, 'An immutable local image ID is required')
    info = inspect_image(identity)
    baseline.check(info['Id'] == identity and info['Os'] == manifest['os'] == 'linux'
                   and info['Architecture'] == manifest['architecture'], 'Image identity mismatch')
    baseline.check(info['Config']['User'] == manifest['user'] == '10001:10001', 'Unexpected runtime user')
    source = json.loads((directory / 'image-source-manifest.json').read_text())
    baseline.check(hashlib.sha256(json.dumps(source['files'], sort_keys=True).encode()).hexdigest()
                   == source['sha256'] == manifest['source_sha256']
                   == info['Config']['Labels']['io.rocento.source.sha256'], 'Image source mismatch')
    baseline.check(set(manifest['binaries']) == set(BINARIES), 'Incomplete image binary manifest')
    baseline.check(binary_hashes(identity) == manifest['binaries'], 'Image binary checksum mismatch')
    return manifest


class ContainerProcess:
    """Minimal process identity/liveness contract used by existing fault scenarios."""
    def __init__(self, identity):
        self.pid = identity

    def poll(self):
        state = json.loads(baseline.command(['docker', 'inspect', '--format', '{{json .State}}', self.pid]))
        return None if state['Running'] else state['ExitCode']


class ImageStack(baseline.BaselineStack):
    def __init__(self, directory, profile, image):
        super().__init__(directory, profile)
        self.image = image
        self.followers = {}
        self.export_process = None
        self.wrappers = directory / 'commands'
        self.wrappers.mkdir()
        for name in ('seed-admin', 'sync-reports'):
            args = self.base + ['exec', '-T']
            if name == 'seed-admin':
                args += ['-e', 'BOOTSTRAP_ADMIN_PASSWORD']
            args += ['release-api', name]
            path = self.wrappers / name
            path.write_text('#!' + sys.executable + '\nimport os,sys\nargs=' + repr(args)
                            + '\nos.execvp(args[0],args+sys.argv[1:])\n')
            path.chmod(0o500)

    def binary(self, name):
        return self.wrappers / name

    def container_environment(self):
        environment = dict(self.config['services']['api-gateway']['environment'])
        for key in ('APP_ENV', 'NOTIFICATION_MODE', 'COOKIE_SECURE', 'RESERVATION_TTL_SECONDS',
                    'REPORTING_INTERVAL_SECONDS', 'DB_MAX_CONNECTIONS'):
            environment[key] = self.env[key]
        if 'MAILPIT_URL' in self.env:
            environment['MAILPIT_URL'] = self.env['MAILPIT_URL']
        environment.pop('ASSISTANT_TENANT_ID', None)
        environment['BIND_ADDRESS'] = '0.0.0.0:8080'
        return environment

    def start_service(self, service, binary, environment, host_port=None, target=None, log_name=None):
        config = {'image': self.image, 'pull_policy': 'never', 'command': [binary],
                  'environment': environment, 'restart': 'no', 'cpus': '1.0', 'mem_limit': '512m'}
        if host_port:
            config['ports'] = [{'target': target, 'host_ip': '127.0.0.1', 'published': host_port}]
        self.spec['services'][service] = config
        self.save()
        self.compose('up', '-d', '--no-deps', service)
        identity = self.compose('ps', '-q', service).decode().strip()
        log = (self.directory / (log_name + '.log')).open('ab')
        follower = subprocess.Popen(['docker', 'logs', '--follow', '--since', '0s', identity],
                                    env=baseline.host_environment(), stdout=log, stderr=subprocess.STDOUT)
        self.followers[service] = (follower, log)
        return ContainerProcess(identity)

    def stop_service(self, service, kill=False):
        if service not in self.spec['services']:
            return
        if kill:
            self.compose('kill', '-s', 'SIGKILL', service)
        else:
            self.compose('stop', '-t', '15', service)
        follower = self.followers.pop(service, None)
        if follower:
            process, log = follower
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=15)
            log.close()

    def start_api(self):
        self.api = self.start_service('release-api', 'api-gateway', self.container_environment(),
                                      self.env['BIND_ADDRESS'].rsplit(':', 1)[1], 8080, 'gateway')
        def ready():
            baseline.check(self.api.poll() is None, 'Gateway container exited')
            with urllib.request.urlopen(self.url + '/ready', timeout=3) as response:
                return response.status == 200
        baseline.wait_until(ready)

    def stop_api(self, kill=False):
        self.stop_service('release-api', kill)

    def start_analytics(self, wait=True):
        environment = self.container_environment()
        environment.update(ANALYTICS_BIND_ADDRESS='0.0.0.0:8082')
        self.analytics_process = self.start_service('release-analytics', 'analytics-worker', environment,
            self.analytics_url.rsplit(':', 1)[1], 8082, 'analytics')
        if wait:
            baseline.wait_until(self.analytics_ready)

    def stop_analytics(self, kill=False):
        self.stop_service('release-analytics', kill)

    def start_engagement(self):
        self.engagement_process = self.start_service('release-engagement', 'engagement-worker',
                                                     self.container_environment(), log_name='engagement')
        baseline.wait_until(self.engagement_ready)

    def engagement_ready(self):
        baseline.check(self.engagement_process.poll() is None, 'Engagement container exited')
        result = subprocess.run(self.base + ['exec', '-T', 'release-engagement', 'engagement-worker', '--health'],
                                env=baseline.host_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode == 0

    def start_export(self):
        self.export_process = self.start_service('release-export', 'export-worker',
                                                self.container_environment(), log_name='export')
        baseline.wait_until(self.export_ready)

    def export_ready(self):
        baseline.check(self.export_process.poll() is None, 'Export container exited')
        result = subprocess.run(self.base + ['exec', '-T', 'release-export', 'export-worker', '--health'],
                                env=baseline.host_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=6)
        return result.returncode == 0

    def verify_export_faults(self):
        # Fail a probe against an unreachable database without disrupting the worker's own connection.
        result = subprocess.run(self.base + ['exec', '-T', '-e',
                                'DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/invalid',
                                'release-export', 'export-worker', '--health'],
                                env=baseline.host_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=6)
        baseline.check(result.returncode != 0, 'Export health accepted an unreachable database')
        identity = self.export_process.pid
        baseline.command(['docker', 'kill', '--signal', 'STOP', identity])
        try:
            self.compose('exec', '-T', 'release-export', 'touch', '-d', '3 minutes ago', '/tmp/commerce-export-worker.health')
            baseline.check(not self.export_ready(), 'Export health accepted stale progress')
        finally:
            baseline.command(['docker', 'kill', '--signal', 'CONT', identity])
        baseline.wait_until(self.export_ready)
        return {'database_failure_rejected': True, 'stale_progress_rejected': True, 'recovery_passed': True}

    def stop_engagement(self):
        self.stop_service('release-export')
        self.stop_service('release-engagement')
