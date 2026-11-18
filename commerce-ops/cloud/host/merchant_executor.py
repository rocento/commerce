#!/usr/bin/python3
"""Fixed, root-operated merchant executor; untrusted job input never selects paths.

Authorization is installed separately under /etc/rocento/merchant-provisioning.
The worker has no Docker privileges. Missing review returns 78 without writes.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import time
import http.cookies
import shutil
import subprocess
import sys
import urllib.request
import uuid

CONFIG = Path('/etc/rocento/merchant-provisioning')
STATE = Path('/opt/rocento-merchants')
SUPPORTED_THEMES = ('grocery', 'jewelry', 'electronics', 'pharmacy')


def release_themes(inventory):
    """Allow legacy single-theme releases and explicitly inventoried demo bundles."""
    if inventory.get('schemaVersion', 1) not in (1, 2):
        raise ValueError('INVALID_RELEASE_SCHEMA')
    themes = inventory.get('themes') if inventory.get('schemaVersion') == 2 else [inventory.get('theme')]
    if (not isinstance(themes, list) or not themes
            or any(not isinstance(theme, str) or theme not in SUPPORTED_THEMES for theme in themes)
            or len(set(themes)) != len(themes)):
        raise ValueError('INVALID_RELEASE_THEMES')
    return themes


def theme_artifact(inventory, theme):
    if theme not in release_themes(inventory):
        raise ValueError('RELEASE_THEME_MISMATCH')
    return 'themes/' + theme + '.json' if inventory.get('schemaVersion') == 2 else 'theme.json'


def required_artifacts(inventory):
    return {'storefront/index.html', 'admin/index.html',
            *(theme_artifact(inventory, theme) for theme in release_themes(inventory))}


STEPS = {
    'RELEASE': ['release_authorized', 'architecture_compatible', 'artifact_present'],
    'ALLOCATE': ['capacity_reserved', 'tenant_isolated'],
    'DATABASE': ['database_ready'],
    'MIGRATE': ['migrations_applied', 'installation_identity'],
    'SERVICES': ['runtime_healthy'],
    'BOOTSTRAP': ['admin_access_ready', 'theme_ready'],
    'INGRESS': ['ingress_configured', 'tenant_isolation'],
    'VALIDATE': ['storefront_https', 'admin_https', 'tenant_identity', 'release_identity', 'dns_routing', 'tenant_isolation'],
}
HEX = re.compile(r'sha256:[0-9a-f]{64}')
# Resolve the installed sibling explicitly; callers may load us via importlib.
TEMPLATES = Path(__file__).with_name('merchant_templates.py')
_template_spec = importlib.util.spec_from_file_location('merchant_templates', TEMPLATES)
_templates = importlib.util.module_from_spec(_template_spec)
_template_spec.loader.exec_module(_templates)
CLOUDFLARE_NETWORKS = _templates.CLOUDFLARE_NETWORKS

class Blocked(Exception):
    pass


def trusted(path):
    path = Path(path)
    for item in [path, *path.parents]:
        st = item.lstat()
        if item.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('UNTRUSTED_HOST_FILE')
    return path


def read_json(path):
    return json.loads(trusted(path).read_text(), object_pairs_hook=unique)


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def sha(path):
    return hashlib.sha256(trusted(path).read_bytes()).hexdigest()


def artifact_files(directory):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError('ARTIFACT_SYMLINK')
    result = set()
    for path in directory.rglob('*'):
        # rglob does not descend into directory symlinks, while Nginx can follow
        # them when serving a request. Reject them instead of silently omitting
        # their unbound target from the inventory comparison.
        if path.is_symlink():
            raise ValueError('ARTIFACT_SYMLINK')
        if path.is_file():
            result.add(str(path.relative_to(directory)))
    return result


# One node checkpoint has 100s, inside 110s SSH / 130s worker / 180s lease.
# Context-local so fleet reconciliation threads cannot share a command deadline.
DEADLINE = ContextVar('merchant_execution_deadline', default=None)


def bounded_timeout(seconds):
    deadline = DEADLINE.get()
    remaining = seconds if deadline is None else min(seconds, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError('CHECKPOINT_DEADLINE_EXCEEDED')
    return remaining


@contextmanager
def execution_window(binding, seconds=100):
    remaining = min(seconds, binding['expiresAt'] - time.time() - 10)
    if remaining <= 0:
        raise ValueError('EXECUTION_LEASE_EXPIRED')
    deadline = time.monotonic() + remaining
    if DEADLINE.get() is not None:
        deadline = min(deadline, DEADLINE.get())
    token = DEADLINE.set(deadline)
    try:
        yield
    finally:
        DEADLINE.reset(token)


def command(args, *, timeout=75, data=None):
    # Kill/reap the command process group on timeout; remote Docker side effects
    # can still be ambiguous, so an unfinished intent is never replayed.
    timeout = bounded_timeout(timeout)
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True,
                          env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'}) as process:
        try:
            output, _ = process.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        if process.returncode:
            raise ValueError('HOST_COMMAND_FAILED')
        return output


def validate_request(request, bindings):
    if request.get('schemaVersion') != 2 or request.get('operation') not in ('execute', 'reconcile') or not isinstance(request.get('job'), dict):
        raise ValueError('INVALID_REQUEST')
    job = request['job']
    for key in ('id', 'tenantId', 'paymentRequestId', 'leaseToken'):
        if str(uuid.UUID(job[key])) != job[key]:
            raise ValueError('INVALID_ID')
    binding = bindings.get(job['tenantId'])
    if not isinstance(binding, dict):
        raise Blocked('TENANT_NOT_AUTHORIZED')
    for key in ('tenantId', 'paymentRequestId', 'themeId', 'releaseVersion',
                'artifactDigest', 'storefrontHost', 'adminHost'):
        if job.get(key) != binding.get(key):
            raise Blocked('TENANT_BINDING_MISMATCH')
    if job['themeId'] not in SUPPORTED_THEMES or job['step'] not in STEPS:
        raise ValueError('UNSUPPORTED_JOB')
    if not HEX.fullmatch(job['artifactDigest']):
        raise ValueError('INVALID_DIGEST')
    slug = job['storefrontHost'].removesuffix('.rocento.com')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,38}[a-z0-9]', slug) or job['storefrontHost'] != slug + '.rocento.com' or job['adminHost'] != slug + '-admin.rocento.com':
        raise ValueError('INVALID_HOSTS')
    if request.get('idempotencyKey') != job['id'] + ':' + job['step']:
        raise ValueError('INVALID_IDEMPOTENCY_KEY')
    port = binding.get('gatewayPort')
    if type(port) is not int or not 18000 <= port <= 18999:
        raise ValueError('INVALID_PRIVATE_PORT')
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', binding.get('adminEmail', '')):
        raise ValueError('INVALID_ADMIN')
    return job, binding


def authorized_release(job, binding, runtime=True):
    directory = CONFIG / 'releases' / job['artifactDigest'][7:]
    inventory_path = directory / 'inventory.json'
    if not re.fullmatch(r'[a-z0-9-]+', binding['environment']):
        raise ValueError('INVALID_RELEASE_ENVIRONMENT')
    packet_path = directory / ('readiness.' + binding['environment'] + '.json')
    if not packet_path.exists():
        packet_path = directory / 'readiness.json'
    if not inventory_path.exists() or not packet_path.exists():
        raise Blocked('RELEASE_REVIEW_REQUIRED')
    if sha(inventory_path) != job['artifactDigest'][7:]:
        raise ValueError('RELEASE_INVENTORY_CHANGED')
    inventory = read_json(inventory_path)
    themes = release_themes(inventory)
    if (('themeId' in job and job['themeId'] not in themes)
            or inventory.get('version') != job['releaseVersion']):
        raise ValueError('RELEASE_IDENTITY_MISMATCH')
    policy = trusted(Path('/usr/local/lib/rocento/release_readiness.py'))
    spec = importlib.util.spec_from_file_location('merchant_release_readiness', policy)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    packet = read_json(packet_path)
    blockers = module.validate(packet, directory, job['artifactDigest'][7:], binding['environment'])
    if blockers:
        raise Blocked('RELEASE_REVIEW_REQUIRED')
    architecture = {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(os.uname().machine)
    if runtime and inventory.get('architecture') != architecture:
        raise ValueError('ARCHITECTURE_MISMATCH')
    # Bind executor and policy themselves, not only merchant image tags.
    for name, path in [('executor', Path(__file__)), ('templates', TEMPLATES), ('policy', policy)]:
        if sha(path) != inventory['tools'][name]:
            raise ValueError('EXECUTOR_RELEASE_CHANGED')
    required = {'api', 'postgres', 'nats', 'meili', 'minio', 'clickhouse'}
    if set(inventory['images']) != required:
        raise ValueError('IMAGE_INVENTORY_INVALID')
    for name, image in inventory['images'].items():
        if not HEX.fullmatch(image):
            raise ValueError('IMAGE_NOT_PINNED')
        if runtime:
            details = json.loads(command(['docker', 'image', 'inspect', image]))[0]
            if details['Id'] != image or details['Architecture'] != architecture:
                raise ValueError('IMAGE_IDENTITY_MISMATCH')
    expected_files = inventory['files']
    actual = artifact_files(directory / 'artifacts')
    if set(expected_files) != actual or not required_artifacts(inventory) <= actual:
        raise ValueError('ARTIFACT_SET_CHANGED')
    for name, digest in expected_files.items():
        if Path(name).is_absolute() or '..' in Path(name).parts or sha(directory / 'artifacts' / name) != digest:
            raise ValueError('ARTIFACT_CHANGED')
    return directory, inventory


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('x') as output:
        json.dump(value, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def publication_artifact(job, release=None):
    release = release or CONFIG / 'releases' / job['artifactDigest'][7:]
    return release / 'artifacts/storefront/index.html'


def render_compose(job, binding, inventory, release=None):
    return _templates.render_compose(job, binding, inventory, publication_artifact(job, release))

def compose(directory, *args, data=None):
    env_files = ['--env-file', str(directory / 'runtime.env')]
    publication = directory / 'publication.env'
    if publication.exists():
        env_files += ['--env-file', str(trusted(publication))]
    return command(['docker', 'compose', '--project-directory', str(directory), *env_files, '-f', str(directory / 'compose.json'), *args], data=data, timeout=95)


def migrate_runtime(directory, industry='grocery'):
    # The database creates its own installation identity during migration. Read
    # it before starting the production gateway; never invent or overwrite it.
    if industry not in SUPPORTED_THEMES:
        raise ValueError('UNSUPPORTED_INDUSTRY')
    compose(directory, 'run', '--rm', '--no-deps', '--pull', 'never', 'api-gateway',
            'install-catalog-data', '--install-core', '--industry', industry, '--apply')
    value = compose(directory, 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1',
                    '-U', 'commerce', '-d', 'commerce', '-Atc',
                    'SELECT installation_id FROM platform.publication_installation WHERE singleton').decode().strip()
    if str(uuid.UUID(value)) != value:
        raise ValueError('PUBLICATION_INSTALLATION_INVALID')
    target = directory / 'publication.env'
    content = 'PUBLICATION_INSTALLATION_ID=' + value + '\n'
    if target.exists():
        if trusted(target).read_text() != content:
            raise ValueError('PUBLICATION_INSTALLATION_CHANGED')
    else:
        target.write_text(content)
        target.chmod(0o600)


def start_runtime(directory, industry='grocery'):
    """Qualification-only convenience; provisioning executes separate checkpoints."""
    compose(directory, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '80', 'postgres')
    migrate_runtime(directory, industry)
    compose(directory, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '80')


def check_isolation(directory, inventory, job, release=None):
    containers = json.loads(command(['docker', 'inspect', *compose(directory, 'ps', '-q').decode().split()]))
    expected_project = 'merchant-' + job['tenantId']
    if len(containers) != 10:
        raise ValueError('RUNTIME_INCOMPLETE')
    allowed_volumes = {expected_project + '_' + n for n in ('postgres', 'engagement', 'nats', 'meili', 'minio', 'clickhouse')}
    for item in containers:
        service = item['Config']['Labels']['com.docker.compose.service']
        if item['Config']['Labels']['com.docker.compose.project'] != expected_project or item['HostConfig']['Privileged']:
            raise ValueError('TENANT_ISOLATION_FAILED')
        if set(item['NetworkSettings']['Networks']) != {expected_project + '_tenant'}:
            raise ValueError('TENANT_NETWORK_MISMATCH')
        for mount in item['Mounts']:
            if mount['Type'] == 'volume' and mount['Name'] in allowed_volumes:
                continue
            if (service == 'api-gateway' and mount['Type'] == 'bind'
                    and mount.get('Source') == str(publication_artifact(job, release))
                    and mount.get('Destination') == '/srv/publication/index.html'
                    and mount.get('RW') is False):
                continue
            raise ValueError('TENANT_VOLUME_MISMATCH')
        if service == 'api-gateway' and not any(
                mount.get('Destination') == '/srv/publication/index.html' for mount in item['Mounts']):
            raise ValueError('PUBLICATION_ARTIFACT_MISSING')
        image_key = {'api-gateway': 'api', 'analytics-worker': 'api', 'engagement-worker': 'api', 'export-worker': 'api', 'engagement-postgres': 'postgres', 'meilisearch': 'meili'}.get(service, service)
        if item['Image'] != inventory['images'][image_key] or not item['State']['Running']:
            raise ValueError('RUNTIME_IDENTITY_MISMATCH')
        if item['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
            raise ValueError('RUNTIME_UNHEALTHY')
        for endpoints in item['HostConfig'].get('PortBindings', {}).values():
            if any(endpoint['HostIp'] != '127.0.0.1' for endpoint in endpoints or []):
                raise ValueError('PUBLIC_BACKEND_PORT')


def nginx_config(job, binding, release):
    return _templates.nginx_config(job, binding, release)

def execute(request):
    return execute_bound(request, database_binding(request))


def receipt_identity(job, binding):
    return {**{key: job[key] for key in ('id', 'tenantId', 'paymentRequestId', 'step',
            'themeId', 'releaseVersion', 'artifactDigest', 'storefrontHost', 'adminHost')},
            'environment': binding['environment']}


def execute_bound(request, binding):
    job, binding = validate_request(request, {binding['tenantId']: binding})
    reconcile = request['operation'] == 'reconcile'
    with execution_window(binding, 15 if reconcile else 100):
        release, inventory = authorized_release(job, binding)
        if not reconcile:
            STATE.mkdir(mode=0o700, exist_ok=True)
        trusted(STATE)
        # Retain the installed host lock: ports, nginx and restrictions share it.
        with (STATE / 'deployment.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            bounded_timeout(1)
            receipt_dir = STATE / 'execution-receipts' / job['id']
            receipt_path = receipt_dir / (job['step'] + '.json')
            identity = receipt_identity(job, binding)
            evidence = dict(jobId=job['id'], tenantId=job['tenantId'], leaseToken=job['leaseToken'],
                            step=job['step'], artifactDigest=job['artifactDigest'], checks=STEPS[job['step']])
            if receipt_path.exists():
                receipt = read_json(receipt_path)
                if receipt.get('identity') != identity:
                    raise ValueError('CHECKPOINT_IDENTITY_CHANGED')
                if receipt.get('status') != 'SUCCEEDED':
                    raise ValueError('CHECKPOINT_OUTCOME_UNCERTAIN')
                # Public validation is read-only and is refreshed on normal runs.
                if reconcile or job['step'] != 'VALIDATE':
                    return evidence
            elif reconcile:
                raise ValueError('CHECKPOINT_RECEIPT_MISSING')
            # Capacity blockers have no side effects and must remain retryable.
            ports_path = STATE / 'ports.json'
            ports = read_json(ports_path) if ports_path.exists() else {}
            if job['tenantId'] not in ports and len(ports) >= 3:
                raise Blocked('CAPACITY_REQUIRED')
            if job['step'] == 'ALLOCATE':
                check_capacity()
            receipt_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
            for parent in (receipt_dir.parent, STATE):
                fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            trusted(receipt_dir)
            # Persist intent before any external mutation. A crash here requires
            # inspection; only a completed durable receipt permits automatic reuse.
            atomic_json(receipt_path, dict(identity=identity, status='STARTED'))
            directory = STATE / job['tenantId']
            binding['gatewayPort'] = allocate_port(job['tenantId'])
            execute_checkpoint(job, binding, directory, release, inventory)
            bounded_timeout(1)
            atomic_json(receipt_path, dict(identity=identity, status='SUCCEEDED'))
            return evidence


def check_capacity():
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(memory['MemAvailable'].split()[0]) < 6 * 1024**2 or shutil.disk_usage(STATE).free < 15 * 1024**3:
        raise Blocked('CAPACITY_REQUIRED')


def execute_checkpoint(job, binding, directory, release, inventory):
    step = job['step']
    if step == 'RELEASE':
        return
    if step == 'ALLOCATE':
        directory.mkdir(mode=0o700, exist_ok=True)
        trusted(directory)
        desired = render_compose(job, binding, inventory)
        target = directory / 'compose.json'
        if target.exists() and read_json(target) != desired:
            raise ValueError('ALLOCATION_CHANGED')
        if not target.exists():
            atomic_json(target, desired)
        prepare_credentials(directory)
        return
    if read_json(directory / 'compose.json') != render_compose(job, binding, inventory):
        raise ValueError('ALLOCATION_CHANGED')
    if step == 'DATABASE':
        compose(directory, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '80', 'postgres')
    elif step == 'MIGRATE':
        migrate_runtime(directory, job['themeId'])
    elif step == 'SERVICES':
        compose(directory, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '80')
    elif step == 'BOOTSTRAP':
        bootstrap(directory, binding, release)
        verify_admin_and_theme(directory, binding)
    elif step == 'INGRESS':
        check_isolation(directory, inventory, job)
        target = Path('/etc/nginx/conf.d') / ('merchant-' + job['tenantId'] + '.conf')
        desired = nginx_config(job, binding, release)
        if target.exists() and trusted(target).read_text() != desired:
            raise ValueError('INGRESS_CONFIG_CHANGED')
        if not target.exists():
            target.write_text(desired)
            target.chmod(0o644)
        command(['nginx', '-t'])
        command(['systemctl', 'reload', 'nginx'])
    elif step == 'VALIDATE':
        check_isolation(directory, inventory, job)
        verify_admin_and_theme(directory, binding)
        for kind, host in [('storefront', job['storefrontHost']), ('admin', job['adminHost'])]:
            identity = fetch_json('https://' + host + '/__rocento_identity')
            if identity != {'tenantId': job['tenantId'], 'artifactDigest': job['artifactDigest'], 'surface': kind}:
                raise ValueError('PUBLIC_IDENTITY_MISMATCH')
            if fetch_json('https://' + host + '/api/ready').get('status') != 'ready':
                raise ValueError('PUBLIC_RUNTIME_UNHEALTHY')
            verify_public_page('https://' + host + '/')


def public_request(url):
    # Identify the provisioning service transparently; retain default TLS validation.
    return urllib.request.Request(url, headers={'User-Agent': 'RocentoProvisioning/1.0'})


def verify_public_page(url):
    with urllib.request.urlopen(public_request(url), timeout=bounded_timeout(10)) as response:
        if response.geturl() != url or b'<html' not in response.read(1024*1024).lower():
            raise ValueError('PUBLIC_PAGE_INVALID')


def fetch_json(url):
    with urllib.request.urlopen(public_request(url), timeout=bounded_timeout(10)) as response:
        if response.geturl() != url:
            raise ValueError('UNEXPECTED_REDIRECT')
        return json.load(response)


def api_client(binding, password):
    cookie = ''
    def call(method, path, body=None, content_type='application/json'):
        nonlocal cookie
        request = urllib.request.Request(
            'http://127.0.0.1:' + str(binding['gatewayPort']) + path,
            data=body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None, method=method,
            headers={'Content-Type': content_type, 'X-Commerce-Request': '1',
                     'Origin': 'https://' + binding['adminHost'], 'Cookie': cookie})
        with urllib.request.urlopen(request, timeout=bounded_timeout(10)) as response:
            if response.headers.get('Set-Cookie'):
                parsed = http.cookies.SimpleCookie(response.headers['Set-Cookie'])
                cookie = '; '.join(k + '=' + v.value for k, v in parsed.items())
            raw = response.read(1024*1024)
            return json.loads(raw) if raw else None
    call('POST', '/v1/admin/auth/login', {'email': binding['adminEmail'], 'password': password})
    return call


def resolve_starter_theme(directory, release, inventory, selected_theme, configuration, call):
    """Import only the images and categories required by the chosen starter layout."""
    dependency_name = 'themes/' + selected_theme + '.dependencies.json'
    if dependency_name not in inventory.get('files', {}):
        return configuration  # Legacy releases contain a self-contained configuration.
    dependencies = read_json(release / 'artifacts' / dependency_name)
    categories = {}
    if dependencies['categories']:
        categories = {row['slug']: row for row in call('GET', '/v1/catalog/categories')}
        for slug, definition in dependencies['categories'].items():
            if slug not in categories:
                categories[slug] = call('POST', '/v1/admin/catalog/categories', dict(definition, parent_id=None))
    cache_path = directory / 'starter-media.json'
    media = read_json(cache_path) if cache_path.exists() else {}
    resolved = {}
    for asset in dependencies['assets']:
        if not re.fullmatch(re.escape(selected_theme) + r'/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)', asset):
            raise ValueError('INVALID_STARTER_ASSET')
        artifact = 'theme-assets/' + asset
        path = release / 'artifacts' / artifact
        checksum = inventory['files'][artifact]
        if sha(path) != checksum:
            raise ValueError('STARTER_ASSET_CHANGED')
        if checksum not in media:
            payload = trusted(path).read_bytes()
            if len(payload) > 5 * 1024 * 1024:
                raise ValueError('STARTER_ASSET_TOO_LARGE')
            boundary = 'rocento-' + uuid.uuid4().hex
            filename = Path(asset).name
            alt = Path(asset).stem.replace('-', ' ') + ' — illustrative demo image'
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n{alt}\r\n'
                    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
            uploaded = call('POST', '/v1/admin/catalog/media', body, content_type='multipart/form-data; boundary=' + boundary)
            media[checksum] = str(uuid.UUID(uploaded['id']))
            atomic_json(cache_path, media)
        resolved[asset] = media[checksum]
    def resolve(value):
        if isinstance(value, dict): return {key: resolve(item) for key, item in value.items()}
        if isinstance(value, list): return [resolve(item) for item in value]
        if isinstance(value, str):
            if value.startswith('asset:'): return resolved[value[6:]]
            if value.startswith('category:'): return categories[value[9:]]['id']
            if value.startswith('category-link:'): return '/categories/' + categories[value[14:]]['id']
        return value
    return resolve(configuration)


def prepare_credentials(directory):
    private = directory / 'credentials.json'
    if not private.exists():
        atomic_json(private, {key: secrets.token_hex(32) for key in
                    ('DB_PASSWORD', 'MEILI_KEY', 'S3_PASSWORD', 'ANALYTICS_PASSWORD', 'AUTH_SECRET', 'ADMIN_PASSWORD', 'META_CREDENTIAL_KEY')})
    credentials = read_json(private)
    smtp = read_json(CONFIG / 'smtp.json')
    values = {k: v for k, v in credentials.items() if k != 'ADMIN_PASSWORD'}
    values.update(smtp)
    # Compose dotenv single quotes preserve dollar signs; reject control chars.
    if any(not isinstance(v, str) or any(c in v for c in "'\r\n") for v in values.values()):
        raise ValueError('INVALID_RUNTIME_SECRET_ENCODING')
    content = ''.join(k + "='" + v + "'\n" for k, v in sorted(values.items()))
    target = directory / 'runtime.env'
    if target.exists() and trusted(target).read_text() != content:
        raise ValueError('CREDENTIALS_CHANGED')
    if not target.exists():
        target.write_text(content)
        target.chmod(0o600)


def bootstrap(directory, binding, release):
    inventory = read_json(release / 'inventory.json')
    selected_theme = binding['themeId']
    configuration_path = release / 'artifacts' / theme_artifact(inventory, selected_theme)
    password = read_json(directory / 'credentials.json')['ADMIN_PASSWORD']
    count = compose(directory, 'exec', '-T', 'postgres', 'psql', '-U', 'commerce', '-d', 'commerce', '-Atc', 'SELECT count(*) FROM admin_iam.admin_users').decode().strip()
    if count == '0':
        compose(directory, 'exec', '-T', 'api-gateway', 'sh', '-c',
                'read -r BOOTSTRAP_ADMIN_PASSWORD; export BOOTSTRAP_ADMIN_PASSWORD; exec seed-admin --email "$1"',
                'bootstrap', binding['adminEmail'], data=(password + '\n').encode())
    call = api_client(binding, password)
    try:
        themes = call('GET', '/v1/admin/themes')
        name = selected_theme.capitalize() + ' starter'
        matching = [t for t in themes if t['name'] == name and t['owner_channel'] == 'storefront']
        if len(matching) > 1:
            raise ValueError('AMBIGUOUS_THEME')
        assignments = call('GET', '/v1/admin/themes/assignments')
        assignment = next(a for a in assignments if a['channel'] == 'storefront')
        theme = matching[0] if matching else None
        if assignment.get('rules') or assignment.get('theme_id') not in (None, theme['id'] if theme else None):
            raise ValueError('EXISTING_THEME_ASSIGNMENT')
        if theme is None:
            theme = call('POST', '/v1/admin/themes', {'name': name, 'owner_channel': 'storefront'})
        config = read_json(configuration_path)
        if not theme.get('published_version'):
            config = resolve_starter_theme(directory, release, inventory, selected_theme, config, call)
            if theme['revision'] == 1:
                theme = call('PUT', '/v1/admin/themes/' + theme['id'], {'expected_revision': theme['revision'], 'configuration': config})
            elif theme.get('configuration') != config:
                raise ValueError('THEME_EDITED_DURING_BOOTSTRAP')
            call('POST', '/v1/admin/themes/' + theme['id'] + '/publish', {'expected_revision': theme['revision']})
        if assignment.get('theme_id') != theme['id']:
            call('PUT', '/v1/admin/themes/assignments/storefront', {'expected_revision': assignment['revision'], 'theme_id': theme['id'], 'rules': []})
    finally:
        call('POST', '/v1/admin/auth/logout', {})


def verify_admin_and_theme(directory, binding):
    password = read_json(directory / 'credentials.json')['ADMIN_PASSWORD']
    call = api_client(binding, password)
    try:
        who = call('GET', '/v1/admin/me')
        if who['user']['email'] != binding['adminEmail']:
            raise ValueError('ADMIN_IDENTITY_MISMATCH')
        themes = call('GET', '/v1/admin/themes')
        assignment = next(a for a in call('GET', '/v1/admin/themes/assignments') if a['channel'] == 'storefront')
        if not any(t['id'] == assignment.get('theme_id') and t.get('published_version') for t in themes):
            raise ValueError('THEME_NOT_PUBLISHED')
    finally:
        call('POST', '/v1/admin/auth/logout', {})


def database_binding(request):
    job = request.get('job', {})
    if job.get('step') not in STEPS:
        raise ValueError('INVALID_STEP')
    for key in ('id', 'tenantId', 'paymentRequestId', 'leaseToken'):
        if str(uuid.UUID(job[key])) != job[key]:
            raise ValueError('INVALID_ID')
    # Values interpolated below have been parsed and canonicalized as UUIDs.
    query = f"""SELECT json_build_object('tenantId',t.id,'paymentRequestId',p.id,
      'themeId',j.theme_id,'releaseVersion',j.release_version,'artifactDigest',j.artifact_digest,
      'storefrontHost',t.store_slug||'.rocento.com','adminHost',t.store_slug||'-admin.rocento.com',
      'adminEmail',a.email,'gatewayPort',18000,'environment','aws-onboarding-test',
      'hostingProvider',t.hosting_provider,'expiresAt',extract(epoch FROM j.lease_until))
      FROM provisioning_jobs j JOIN tenants t ON t.id=j.tenant_id
      JOIN payment_requests p ON p.id=j.payment_request_id AND p.tenant_id=t.id
      JOIN billing_entitlements b ON b.payment_request_id=p.id AND b.tenant_id=t.id
      JOIN customer_accounts a ON a.org_id=t.org_id
      JOIN storefront_themes s ON s.id=j.theme_id
      WHERE j.id='{job['id']}' AND j.tenant_id='{job['tenantId']}'
      AND p.id='{job['paymentRequestId']}' AND j.lease_token='{job['leaseToken']}'
      AND j.status='RUNNING' AND j.step='{job['step']}' AND j.lease_until>clock_timestamp()
      AND t.management_state='ENABLED' AND p.status='CONFIRMED' AND a.verified AND NOT a.disabled
      AND s.status='APPROVED' AND s.artifact_digest=j.artifact_digest AND s.version=j.release_version;"""
    raw = command(['docker', 'exec', '-i', 'rocento-onboarding-test-postgres-1',
                   'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'onboarding', '-d', 'onboarding', '-At'], data=query.encode())
    if not raw.strip():
        raise Blocked('PAYMENT_OR_LEASE_NOT_AUTHORIZED')
    return json.loads(raw)


def allocate_port(tenant):
    # Called only under the global deployment lock; assignments survive retries.
    path = STATE / 'ports.json'
    ports = read_json(path) if path.exists() else {}
    if tenant not in ports:
        # Each merchant host reserves at most three complete merchant stacks.
        # Idle-memory checks alone cannot reserve future container memory use.
        if len(ports) >= 3:
            raise Blocked('CAPACITY_REQUIRED')
        used = set(ports.values())
        port = next((p for p in range(18000, 19000) if p not in used), None)
        if port is None:
            raise Blocked('CAPACITY_REQUIRED')
        ports[tenant] = port
        atomic_json(path, ports)
    return ports[tenant]


def main():
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('REQUEST_TOO_LARGE')
        request = json.loads(raw, object_pairs_hook=unique)
        binding = database_binding(request)
        # Preserve legacy runtimes; never silently move their database/volumes.
        if not binding.get('hostingProvider') and (STATE / binding['tenantId'] / 'compose.json').exists():
            result = execute_bound(request, binding)
        else:
            import merchant_fleet
            # Remote nodes hold their own deployment lock. The controller uses
            # a per-host lock in fleet.execute, allowing independent hosts to run.
            try:
                result = merchant_fleet.execute(request, sys.modules[__name__])
            except merchant_fleet.Waiting as error:
                print(json.dumps({'blocker': str(error)}))
                return 78
        print(json.dumps(result))
        return 0
    except BlockingIOError:
        print(json.dumps({'blocker': 'HOST_EXECUTION_BUSY'}))
        return 78
    except Blocked as error:
        # Protocol exit 78 means a prerequisite is not ready.
        print(json.dumps({'blocker': str(error)}))
        return 78
    except Exception:
        # Ambiguous external changes are never declared safely retryable.
        return 1


if __name__ == '__main__':
    sys.exit(main())
