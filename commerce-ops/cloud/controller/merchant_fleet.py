#!/usr/bin/python3
"""Central merchant placement, provider reconciliation, pinned SSH and DNS.

Only the central host has cloud/DNS credentials and the onboarding database.
Provider configuration and pinned CI releases must be installed explicitly. Importing
this module, running tests, or applying the schema never provisions cloud resources.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from fleet_providers import ProviderError, http
import fleet_release
from fleet_terraform import Provider, validate_config as terraform_config, module_digest

CONFIG = Path('/etc/rocento/merchant-provisioning')
STATE = Path('/opt/rocento-merchants')
TOOLS = Path('/usr/local/lib/rocento')


class Waiting(Exception):
    pass


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def trusted(path):
    path = Path(path)
    for part in [path, *path.parents]:
        st = part.lstat()
        if part.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('UNTRUSTED_FLEET_FILE')
    return path


def secret(path):
    path = trusted(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_FILE_REQUIRED')
    return path.read_text()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def profile_digest(profile):
    return digest({"engine": "terraform", "modules": {name: module_digest(name) for name in ("aws", "gcp", "hetzner")},
                   "profile": {k: v for k, v in profile.items() if k != "maxHosts"}})


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_CONFIGURATION_KEY')
        result[key] = value
    return result


def allowed_tenants(profile):
    if 'allowedTenantIds' not in profile:
        return None
    values = profile['allowedTenantIds']
    if not isinstance(values, list) or not values or len(values) > 1000:
        raise ValueError('INVALID_TENANT_RELEASE_SCOPE')
    if any(not isinstance(value, str) or not re.fullmatch(
            r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) for value in values):
        raise ValueError('INVALID_TENANT_RELEASE_SCOPE')
    if len(set(values)) != len(values):
        raise ValueError('INVALID_TENANT_RELEASE_SCOPE')
    return values


def configuration(*, controls=False):
    if not (CONFIG / 'fleet.json').exists():
        raise Waiting('FLEET_NOT_CONFIGURED')
    cfg = json.loads(secret(CONFIG / 'fleet.json'), object_pairs_hook=unique)
    # Stopping a deployed store must remain possible when new provisioning is
    # disabled or provider/DNS credentials have been revoked.
    secret(cfg['sshPrivateKey'])
    trusted(cfg['sshPublicKey'])
    if controls:
        return cfg
    if cfg.get('enabled') is not True:
        raise Waiting('FLEET_NOT_CONFIGURED')
    terraform_config(cfg.get('terraform', {}))
    if not isinstance(cfg['providers'], dict) or set(cfg['providers']) - {'aws', 'gcp', 'hetzner'}:
        raise ValueError('INVALID_PROVIDER')
    def field(value, pattern):
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError('INVALID_PROVIDER_PROFILE')
    for name, p in cfg['providers'].items():
        allowed_tenants(p)
        if type(p['maxHosts']) is not int or not 1 <= p['maxHosts'] <= 1000:
            raise ValueError('INVALID_HOST_LIMIT')
        if type(p['minMemoryGiB']) is not int or p['minMemoryGiB'] != 16:
            raise ValueError('HOST_PROFILE_REQUIRES_16_GIB')
        fleet_release.validate(p.get('release'))
        field(p['environment'], r'[a-z0-9-]{1,80}')
        if name == 'aws':
            field(p['region'], r'[a-z][a-z0-9-]{1,60}')
            field(p['launchTemplateId'], r'lt-[a-f0-9]{8,32}')
            field(p['launchTemplateVersion'], r'[1-9][0-9]*')
        elif name == 'gcp':
            field(p['project'], r'[a-z][a-z0-9-]{4,62}')
            field(p['zone'], r'[a-z][a-z0-9-]{1,60}')
            field(p['instanceTemplate'], r'https://(?:www|compute)\.googleapis\.com/compute/v1/projects/[a-z0-9-]+/(?:global|regions/[a-z0-9-]+)/instanceTemplates/[a-z0-9-]+')
        else:
            field(p['serverType'], r'[a-z][a-z0-9-]{1,40}')
            field(p['location'], r'[a-z][a-z0-9-]{1,40}')
            if type(p['image']) is not int or p['image'] < 1 or not isinstance(p['firewalls'], list) or not p['firewalls'] or any(type(x) is not int or x < 1 for x in p['firewalls']):
                raise ValueError('PIN_HETZNER_IMAGE_AND_FIREWALLS')
            if not secret(p['tokenFile']).strip():
                raise ValueError('PROVIDER_TOKEN_REQUIRED')
    secret(cfg['githubTokenFile'])
    field(cfg['cloudflare']['zoneId'], r'[a-f0-9]{32}')
    if not secret(cfg['cloudflare']['tokenFile']).strip():
        raise ValueError('DNS_TOKEN_REQUIRED')
    return cfg


def run(args, data=None, timeout=45):
    r = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, check=False)
    if r.returncode:
        raise RuntimeError('FLEET_COMMAND_FAILED')
    return r.stdout


def sql(query):
    return run(['docker', 'exec', '-i', 'rocento-onboarding-test-postgres-1',
                'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'onboarding', '-d', 'onboarding', '-At'],
               query.encode()).decode().strip()


def literal(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def host_directory(host):
    identity = str(uuid.UUID(host['id']))
    path = STATE / 'fleet' / identity
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    return trusted(path)


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)


def cloud_init(host, cfg):
    directory = host_directory(host)
    key = directory / 'ssh_host_ed25519_key'
    if not key.exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
    public = trusted(cfg['sshPublicKey']).read_text().strip()
    actual_public = run(['ssh-keygen', '-y', '-f', str(trusted(cfg['sshPrivateKey']))]).decode().strip()
    if actual_public.split()[:2] != public.split()[:2]:
        raise ValueError('CONTROLLER_SSH_KEY_MISMATCH')
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\n]*)?', public):
        raise ValueError('ED25519_CONTROLLER_KEY_REQUIRED')
    profile = cfg['providers'][host['provider']]
    fleet_release.validate(profile['release'])
    if profile['release']['inventoryDigest'] != host['release_digest']:
        raise ValueError('HOST_RELEASE_PIN_MISMATCH')
    node = {'release': profile['release'], 'hostId': host['id'], 'provider': host['provider'], 'environment': profile['environment'],
            'minMemoryGiB': profile['minMemoryGiB'], 'releaseDigest': host['release_digest']}
    # JSON is YAML-compatible. Host keys are unique per VM and known before first SSH.
    body = {'ssh_deletekeys': True, 'ssh_keys': {'ed25519_private': secret(key),
            'ed25519_public': trusted(str(key) + '.pub').read_text()},
            'disable_root': False, 'ssh_pwauth': False, 'allow_public_ssh_keys': False,
            'users': [{'name': 'root', 'lock_passwd': True, 'ssh_authorized_keys': ['restrict,command="/usr/local/lib/rocento/fleet-bootstrap.py" ' + public]}],
            'write_files': [{'path': '/etc/rocento/fleet-node.json', 'owner': 'root:root',
                             'permissions': '0600', 'content': json.dumps(node)},
                            {'path': '/root/.ssh/authorized_keys', 'owner': 'root:root', 'permissions': '0600',
                             'content': 'restrict,command="/usr/local/lib/rocento/fleet-bootstrap.py" ' + public + '\n'}]}
    assets = TOOLS / 'fleet-bootstrap-assets'
    body['write_files'].extend([
        # Inventories pin Docker config IDs; keep import identity consistent
        # with CI even when a newer Docker package defaults to containerd.
        {'path': '/etc/docker/daemon.json', 'owner': 'root:root', 'permissions': '0644',
         'content': json.dumps({'features': {'containerd-snapshotter': False},
                                'log-driver': 'json-file',
                                'log-opts': {'max-size': '20m', 'max-file': '5'}})},
        {'path': '/usr/local/lib/rocento/fleet-bootstrap.py', 'owner': 'root:root',
         'permissions': '0755', 'content': trusted(TOOLS / 'fleet-bootstrap.py').read_text()},
        {'path': '/etc/rocento/metadata-firewall.nft', 'permissions': '0644',
         'content': trusted(assets / 'metadata-firewall.nft').read_text()},
        {'path': '/etc/systemd/system/rocento-metadata-firewall.service', 'permissions': '0644',
         'content': trusted(assets / 'metadata-firewall.service').read_text()},
        {'path': '/etc/systemd/system/docker.service.d/rocento-metadata.conf', 'permissions': '0644',
         'content': '[Unit]\nRequires=rocento-metadata-firewall.service\nAfter=rocento-metadata-firewall.service\n'}])
    # Install firewall prerequisites first. Docker's dependency blocks startup if
    # the metadata firewall cannot start, including package post-install startup.
    body['runcmd'] = [['bash', '-ec', '\n'.join([
        '. /etc/os-release; test "$ID:$VERSION_ID" = ubuntu:24.04',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update',
        'apt-get install -y nftables iptables nginx python3',
        'systemctl daemon-reload',
        'systemctl enable --now rocento-metadata-firewall.service',
        'apt-get install -y docker.io docker-compose-v2',
        'systemctl enable --now docker',
        'docker compose version',
        'touch /etc/rocento/bootstrap-packages-ready'])]]
    payload = '#cloud-config\n' + json.dumps(body)
    if host['provider'] == 'aws' and len(payload.encode()) > 16384:
        raise ValueError('CLOUD_INIT_TOO_LARGE')
    return payload


def ssh_args(host, cfg):
    address = str(ipaddress.IPv4Address(host['address']))
    directory = host_directory(host)
    public = trusted(directory / 'ssh_host_ed25519_key.pub').read_text().split()
    known = directory / 'known_hosts'
    known.write_text(address + ' ' + ' '.join(public[:2]) + '\n')
    known.chmod(0o600)
    return ['ssh', '-T', '-i', str(trusted(cfg['sshPrivateKey'])),
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known),
        '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'PasswordAuthentication=no',
        'root@' + address, '/usr/local/lib/rocento/fleet-node.py']


def remote(host, cfg, envelope, timeout=100):
    result = json.loads(run(ssh_args(host, cfg),
        json.dumps(dict(envelope, hostId=host['id'])).encode(), timeout=timeout))
    if not isinstance(result, dict):
        raise ValueError('INVALID_NODE_RESPONSE')
    if result.get('error'):
        code = result['error']
        raise ValueError(code if isinstance(code, str) and re.fullmatch(r'[A-Z_]+', code) else 'NODE_EXECUTION_FAILED')
    return result


def update_host(host, **fields):
    allowed = {'state', 'provider_reference', 'provider_operation', 'address', 'error_code'}
    if set(fields) - allowed:
        raise ValueError('INVALID_HOST_UPDATE')
    deadline = ",boot_deadline_at=clock_timestamp()+interval '30 minutes'" if fields.get('state') == 'CREATING' else ''
    sql('UPDATE merchant_hosts SET ' + ','.join(k + '=' + literal(v) for k, v in fields.items()) + deadline
        + ',updated_at=clock_timestamp() WHERE id=' + literal(host['id']))


def boot_query(host, profile=None):
    # Reservations can outlive payment/account/release authorization. Recheck
    # immediately before creating a billable VM, without needing a merchant lease.
    scope = allowed_tenants(profile or {})
    scope_sql = ' AND t.id IN (' + ','.join(literal(value) for value in scope) + ')' if scope is not None else ''
    query = """SELECT json_build_object('themeId',s.id,'releaseVersion',s.version,'artifactDigest',s.artifact_digest)
      FROM merchant_placements p JOIN tenants t ON t.id=p.tenant_id
      JOIN provisioning_jobs j ON j.tenant_id=t.id
      JOIN payment_requests r ON r.id=j.payment_request_id AND r.tenant_id=t.id
      JOIN payment_confirmations c ON c.payment_request_id=r.id
      JOIN billing_entitlements b ON b.payment_request_id=r.id AND b.tenant_id=t.id
      JOIN customer_accounts a ON a.org_id=t.org_id
      JOIN onboarding_drafts d ON d.tenant_id=t.id
      JOIN storefront_themes s ON s.id=d.theme
      WHERE p.host_id=""" + literal(host['id']) + """ AND t.management_state='ENABLED'
      AND t.hosting_provider=""" + literal(host['provider']) + """ AND a.verified AND NOT a.disabled
      AND r.status='CONFIRMED' AND c.amount_minor=r.amount_minor AND c.currency=r.currency
      AND c.service_days=r.service_days AND b.service_days=r.service_days
      AND j.status IN ('QUEUED','BLOCKED','RETRY','RUNNING') AND j.step='RELEASE'
      AND s.status='APPROVED' AND j.theme_id=s.id AND j.release_version=s.version
      AND j.artifact_digest=s.artifact_digest AND s.artifact_digest=""" + literal(host['release_digest']) + scope_sql + ' LIMIT 1'
    return query


def boot_release(host, profile):
    raw = sql(boot_query(host, profile))
    if not raw:
        raise Waiting('FLEET_NO_ELIGIBLE_TENANT')
    merchant = module('fleet_release', 'merchant-executor.py')
    try:
        merchant.authorized_release(json.loads(raw), {'environment': profile['environment']}, runtime=False)
    except merchant.Blocked as error:
        raise Waiting('RELEASE_AUTHORIZATION_REQUIRED') from error


def expected_tools():
    return {name: hashlib.sha256(trusted(TOOLS / filename).read_bytes()).hexdigest()
            for name, filename in NODE_TOOLS.items()}


def authorize_creation(host, profile, cfg):
    # Planning may outlive the operator's fleet/provider configuration.
    current = configuration()
    if current['terraform'] != cfg['terraform']:
        raise Waiting('TERRAFORM_BINDING_CHANGED')
    selected = current['providers'].get(host['provider'])
    if not selected or profile_digest(selected) != host['profile_digest']:
        raise Waiting('HOST_PROFILE_CHANGED')
    boot_release(host, profile)


def reconcile_host(host, cfg):
    p = cfg['providers'].get(host['provider'])
    if not p or profile_digest(p) != host['profile_digest']:
        raise ValueError('HOST_PROFILE_CHANGED')
    provider = Provider(host['provider'], p, secret, terraform=cfg['terraform'],
                        directory=host_directory(host), trusted=trusted, authorize=lambda: authorize_creation(host, p, cfg))
    if host['state'] == 'REQUESTED':
        boot_release(host, p)
        slug = sql("SELECT t.store_slug FROM merchant_placements p JOIN tenants t ON t.id=p.tenant_id WHERE p.host_id="
                   + literal(host['id']) + " ORDER BY p.slot LIMIT 1").strip()
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,38}[a-z0-9]', slug):
            raise ValueError('INVALID_INSTANCE_SUBDOMAIN')
        host = dict(host, instance_name='merchent-' + slug)
        payload = cloud_init(host, cfg)
        # Persist intent BEFORE the external request. A crash can only discover.
        update_host(host, state='CREATING')
        result = provider.create(host, payload, host_directory(host) / 'create.json')
        update_host(host, state='BOOTING', provider_reference=result['reference'], provider_operation=result['operation'], error_code=None)
        return
    discovered = provider.discover(host)
    if not discovered or not discovered['running'] or not discovered['address']:
        # Rotate pending hosts fairly; preserve the original boot deadline.
        update_host(host, error_code='HOST_BOOT_PENDING')
        return
    host = dict(host, address=str(ipaddress.IPv4Address(discovered['address'])))
    update_host(host, state='BOOTING', provider_reference=discovered['reference'], address=host['address'])
    # Verify installed code before transmitting any TLS/SMTP credentials.
    try:
        identity = remote(host, cfg, {'operation': 'inspect'}, timeout=15)
        if 'bootstrap' in identity:
            expected_bootstrap = hashlib.sha256(trusted(TOOLS / 'fleet-bootstrap.py').read_bytes()).hexdigest()
            if identity != {'hostId': host['id'], 'bootstrap': expected_bootstrap}:
                raise ValueError('HOST_BOOTSTRAP_IDENTITY_MISMATCH')
            boot_release(host, p)
            bundle = fleet_release.download(p['release'], host_directory(host), secret(cfg['githubTokenFile']))
            fleet_release.transfer(ssh_args(host, cfg), bundle, host['id'])
            identity = remote(host, cfg, {'operation': 'inspect'}, timeout=15)
        expected = expected_tools()
        if identity != {'hostId': host['id'], 'tools': expected}:
            raise ValueError('HOST_BOOTSTRAP_IDENTITY_MISMATCH')
        result = remote(host, cfg, {'operation': 'prepare',
            'certificate': secret('/opt/rocento-onboarding/config/origin.pem'),
            'privateKey': secret('/opt/rocento-onboarding/config/origin.key'),
            'smtp': json.loads(secret(CONFIG / 'smtp.json'))}, timeout=40)
    except (RuntimeError, subprocess.TimeoutExpired):
        return  # cloud-init/sshd may still be starting; bounded overall deadline below
    if result != {'hostId': host['id'], 'ready': True, 'tools': expected}:
        raise ValueError('HOST_BOOTSTRAP_IDENTITY_MISMATCH')
    update_host(host, state='READY', error_code=None)


NODE_TOOLS = {'node': 'fleet-node.py', 'executor': 'merchant-executor.py', 'templates': 'merchant_templates.py',
              'policy': 'release_readiness.py', 'controls': 'tenant-controls.py'}


def reconcile_concurrency(cfg):
    value = cfg.get('reconcileConcurrency', 4)
    if type(value) is not int or not 1 <= value <= 8:
        raise ValueError('INVALID_RECONCILE_CONCURRENCY')
    return value


def reconcile_one(host, cfg):
    if host['expired']:
        update_host(host, state='FAILED', error_code='HOST_BOOT_TIMEOUT')
        return
    try:
        reconcile_host(host, cfg)
    except Waiting as error:
        update_host(host, error_code=str(error))
    except Exception as error:
        # Discover-only retries for an uncertain CREATE; failed boot is never replaced.
        current = sql('SELECT state FROM merchant_hosts WHERE id=' + literal(host['id']))
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'HOST_REQUIRES_REVIEW'
        if isinstance(error, ProviderError):
            code = str(error)
            pending = error.uncertain if current == 'CREATING' else error.retryable
        else:
            pending = current == 'CREATING' and not isinstance(error, ValueError)
        if pending:
            update_host(host, error_code='CREATE_OUTCOME_UNCERTAIN' if current == 'CREATING' else code)
        else:
            update_host(host, state='FAILED', error_code=code)
        print(json.dumps({'hostId': host['id'], 'error': code}), file=sys.stderr)


def reconcile():
    cfg = configuration()
    concurrency = reconcile_concurrency(cfg)
    # The existing fleet.lock owns this bounded batch; no second controller can
    # reconcile the same hosts. Each Terraform workspace keeps its own lock.
    hosts = json.loads(sql("SELECT COALESCE(json_agg(h),'[]') FROM (SELECT *,COALESCE(boot_deadline_at<=clock_timestamp(),false) AS expired FROM merchant_hosts WHERE state IN ('REQUESTED','CREATING','BOOTING') ORDER BY updated_at,id LIMIT " + str(concurrency) + ") h"))
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        list(pool.map(lambda host: reconcile_one(host, cfg), hosts))


@contextmanager
def host_execution_lock(host):
    directory = host_directory(host)
    with (directory / 'execution.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Waiting('HOST_EXECUTION_BUSY') from None
        yield


def placement(tenant):
    raw = sql('SELECT row_to_json(h) FROM merchant_placements p JOIN merchant_hosts h ON h.id=p.host_id WHERE p.tenant_id=' + literal(str(uuid.UUID(tenant))))
    return json.loads(raw) if raw else None


def dns(host, binding, cfg):
    cf = cfg['cloudflare']
    base = 'https://api.cloudflare.com/client/v4/zones/' + cf['zoneId'] + '/dns_records'
    token = secret(cf['tokenFile']).strip()
    for name in (binding['storefrontHost'], binding['adminHost']):
        # validate_request has already bounded the exact paired rocento.com names.
        result = http('GET', base + '?name=' + name, token, timeout=8)
        if not result.get('success'):
            raise ValueError('DNS_LOOKUP_FAILED')
        records = result['result']
        marker = 'rocento-tenant:' + binding['tenantId']
        desired = {'type': 'A', 'name': name, 'content': host['address'],
                   'ttl': 1, 'proxied': True, 'comment': marker}
        if records:
            if len(records) != 1 or any(records[0].get(k) != desired[k] for k in ('type', 'content', 'proxied', 'comment')):
                raise ValueError('DNS_RECORD_CONFLICT')
        elif not http('POST', base, token, desired, timeout=8).get('success'):
            raise ValueError('DNS_CREATE_FAILED')


def execute(request, merchant):
    deadline = time.monotonic() + 120
    reconcile_only = request.get("operation") == "reconcile"
    binding = merchant.database_binding(request)
    job, binding = merchant.validate_request(request, {binding['tenantId']: binding})
    provider_name = binding.get('hostingProvider')
    if not provider_name:
        raise Waiting('HOSTING_PROVIDER_REQUIRED')
    cfg = configuration()
    profile = cfg['providers'].get(provider_name)
    if not profile:
        raise Waiting('FLEET_NOT_CONFIGURED')
    scope = allowed_tenants(profile)
    if scope is not None and binding['tenantId'] not in scope:
        raise Waiting('TENANT_NOT_IN_RELEASE_SCOPE')
    binding['environment'] = profile['environment']
    # Check reviewed release on the controller before spending money. Runtime
    # architecture/images are checked again on the selected merchant host.
    merchant.authorized_release(job, binding, runtime=False)
    if reconcile_only:
        host = placement(job['tenantId'])
        if host is None:
            raise ValueError('CHECKPOINT_RECEIPT_MISSING')
    else:
        raw = sql('SELECT reserve_merchant_host(' + ','.join([
            literal(job['id']), literal(job['leaseToken']), literal(profile_digest(profile)),
            str(profile['maxHosts']), literal(str(uuid.uuid4()))]) + ')')
        if not raw:
            raise Waiting('FLEET_HOST_LIMIT')
        host = json.loads(raw)
    if host['state'] != 'READY':
        raise Waiting('FLEET_HOST_REQUIRES_REVIEW' if host['state'] in ('FAILED','DRAINING') else 'FLEET_HOST_PREPARING')
    if host['profile_digest'] != profile_digest(profile) or host['release_digest'] != job['artifactDigest']:
        raise Waiting('FLEET_HOST_REQUIRES_REVIEW')
    with host_execution_lock(host):
        # Recheck after acquiring the host lock: suspension/revocation must win
        # over any execution that waited for another tenant on this host.
        fresh = merchant.database_binding(request)
        if fresh.get('hostingProvider') != provider_name:
            raise ValueError('PROVIDER_CHANGED')
        binding['expiresAt'] = fresh['expiresAt']
        if job['step'] == 'VALIDATE' and not reconcile_only:
            dns(host, binding, cfg)
        remaining = min(deadline - time.monotonic(), binding['expiresAt'] - time.time() - 5)
        if remaining < 5:
            raise Waiting('FLEET_HOST_PREPARING')
        result = remote(host, cfg, {'operation': 'provision', 'request': request, 'binding': binding},
                        timeout=min(15 if reconcile_only else 110, remaining))
        if result.get('blocked'):
            raise Waiting(result.get('reason', 'HOST_EXECUTION_BUSY'))
        return result


def restrict(item):
    host = placement(item['tenantId'])
    if host is None:
        return False
    # Even a non-ready host can contain a partially deployed merchant. Never
    # mark a command applied until the assigned host acknowledges the stop.
    if not host.get('address'):
        raise Waiting('HOST_NOT_REACHABLE')
    result = remote(host, configuration(controls=True), {'operation': 'restrict', 'command': item})
    if result.get('blocked'):
        raise Waiting('HOST_EXECUTION_BUSY')
    if result != {'hostId': host['id'], 'restricted': item['tenantId']}:
        raise ValueError('REMOTE_CONTROL_FAILED')
    return True


def observe(tenant):
    if str(uuid.UUID(tenant)) != tenant:
        raise ValueError('INVALID_TENANT_ID')
    host = placement(tenant)
    if host is None or not host.get('address'):
        raise Waiting('HOST_NOT_REACHABLE')
    result = remote(host, configuration(controls=True), {'operation': 'observe', 'tenantId': tenant})
    if (result.get('hostId') != host['id'] or result.get('tenantId') != tenant
            or result.get('releaseDigest') != host['release_digest']):
        raise ValueError('OBSERVATION_IDENTITY_MISMATCH')
    return result


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == 'observe':
        print(json.dumps(observe(sys.argv[2])))
        return
    if len(sys.argv) != 1:
        raise ValueError('INVALID_FLEET_OPERATION')
    STATE.mkdir(mode=0o700, exist_ok=True)
    trusted(STATE)
    # Terraform may wait for VM creation; do not block merchant suspension/deployment.
    with (STATE / 'fleet.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            reconcile()
        except Waiting:
            return


if __name__ == '__main__':
    main()
