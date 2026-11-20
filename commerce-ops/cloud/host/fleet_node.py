#!/usr/bin/python3
"""Fixed root SSH endpoint on merchant VMs; no cloud or control database access."""
import fcntl
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid
import math
import datetime
import shutil

TOOLS = Path('/usr/local/lib/rocento')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def metadata_firewall(merchant):
    # Cloud-init contains the unique SSH host key. Containers must never reach
    # provider metadata, including GCP metadata and EC2 user-data/credentials.
    merchant.command(['systemctl', 'is-active', 'rocento-metadata-firewall.service'])
    args = ['iptables', '-w', '5', '-C', 'DOCKER-USER', '-d', '169.254.0.0/16', '-j', 'REJECT']
    if subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        merchant.command(['iptables', '-w', '5', '-I', 'DOCKER-USER', '1', '-d', '169.254.0.0/16', '-j', 'REJECT'])


def identity(config, merchant):
    names = {'node': 'fleet-node.py', 'executor': 'merchant-executor.py', 'templates': 'merchant_templates.py',
             'policy': 'release_readiness.py', 'controls': 'tenant-controls.py'}
    return {'hostId': config['hostId'],
            'tools': {name: merchant.sha(TOOLS / filename) for name, filename in names.items()}}


def prepare(envelope, config, merchant):
    # Readiness never grants release approval. Each provision call revalidates
    # the installed packet, source/tool hashes, images and tenant binding.
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if config['minMemoryGiB'] != 16 or not 15 * 1024**2 <= int(memory['MemTotal'].split()[0]) <= 16 * 1024**2:
        raise ValueError('HOST_MEMORY_PROFILE_MISMATCH')
    if os.cpu_count() != 4:
        raise ValueError('HOST_CPU_PROFILE_MISMATCH')
    merchant.command(['docker', 'compose', 'version'])
    metadata_firewall(merchant)
    directory = Path('/opt/rocento-onboarding/config')
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    merchant.trusted(directory)
    for name, content in [('origin.pem', envelope['certificate']), ('origin.key', envelope['privateKey'])]:
        path = directory / name
        if path.exists() and merchant.trusted(path).read_text() != content:
            raise ValueError('TLS_ROTATION_REQUIRES_REVIEW')
        if not path.exists():
            path.write_text(content)
            path.chmod(0o600)
    smtp = merchant.CONFIG / 'smtp.json'
    if smtp.exists() and merchant.read_json(smtp) != envelope['smtp']:
        raise ValueError('SMTP_ROTATION_REQUIRES_REVIEW')
    if not smtp.exists():
        merchant.atomic_json(smtp, envelope['smtp'])
    default = Path('/etc/nginx/conf.d/merchant-default.conf')
    default.write_bytes(merchant.trusted(TOOLS / 'merchant-default.conf').read_bytes())
    default.chmod(0o644)
    merchant.command(['nginx', '-t'])
    merchant.command(['systemctl', 'restart', 'nginx'])
    return dict(identity(config, merchant), ready=True)


def observe(envelope, config, merchant):
    tenant = envelope['tenantId']
    if not isinstance(tenant, str) or str(uuid.UUID(tenant)) != tenant:
        raise ValueError('INVALID_TENANT_ID')
    directory = merchant.trusted(merchant.STATE / tenant)
    spec = merchant.read_json(directory / 'compose.json')
    project = 'merchant-' + tenant
    if spec.get('name') != project:
        raise ValueError('TENANT_RUNTIME_MISMATCH')
    ids = merchant.compose(directory, 'ps', '--all', '-q').decode().split()
    if any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in ids):
        raise ValueError('INVALID_CONTAINER_ID')
    details = json.loads(merchant.command(['docker', 'inspect', *ids])) if ids else []
    containers, gateway = [], None
    for item in details:
        labels = item['Config'].get('Labels') or {}
        service = labels.get('com.docker.compose.service')
        if (labels.get('com.docker.compose.project') != project or service not in spec['services']
                or item['Image'] != spec['services'][service]['image']):
            raise ValueError('TENANT_RUNTIME_MISMATCH')
        state = item['State']
        containers.append({'service': service, 'running': state['Running'],
                           'health': state.get('Health', {}).get('Status'),
                           'oom': state['OOMKilled'], 'restarts': item['RestartCount']})
        if service == 'api-gateway' and state['Running']:
            gateway = item['Id']
    ready, samples, errors, latest, truncated = False, [], 0, None, False
    if gateway:
        try:
            ready = json.loads(merchant.command(['docker', 'exec', gateway, 'curl', '-fsS',
                                                '--max-time', '5', 'http://localhost:8080/ready']))['status'] == 'ready'
        except (ValueError, KeyError):
            ready = False
        raw = merchant.command(['docker', 'logs', '--since', '60s', '--tail', '50000', gateway])
        lines = raw.splitlines()
        truncated = len(lines) >= 50000
        for line in lines:
            try:
                record = json.loads(line)
                fields = record.get('fields', {})
                if fields.get('message') != 'request completed' or fields.get('route') != '/v1/customer/checkout/place':
                    continue
                duration, status = fields['duration_seconds'], fields['status']
                if type(duration) not in (float, int) or not math.isfinite(duration) or duration < 0 or type(status) is not int:
                    continue
                samples.append(duration)
                errors += int(status >= 500)
                timestamp = record.get('timestamp')
                if isinstance(timestamp, str) and re.fullmatch(r'[0-9T:.+Z-]{10,40}', timestamp):
                    latest = max(latest or timestamp, timestamp)
            except (ValueError, TypeError, KeyError):
                continue
    samples.sort()
    percentile = lambda fraction: samples[math.ceil(len(samples) * fraction) - 1] if samples else None
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    ready = ready and len(containers) == len(spec['services']) and all(
        item['running'] and not item['oom'] and item['health'] in (None, 'healthy') for item in containers)
    return {'hostId': config['hostId'], 'tenantId': tenant, 'releaseDigest': config['releaseDigest'],
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'ready': ready, 'containers': containers,
            'missingServices': sorted(set(spec['services']) - {item['service'] for item in containers}),
            'memoryAvailableKiB': int(memory['MemAvailable'].split()[0]),
            'diskFreeBytes': shutil.disk_usage(directory).free,
            'checkoutLast60Seconds': {'samples': len(samples), 'serverErrors': errors,
                                      'p95Seconds': percentile(.95), 'p99Seconds': percentile(.99),
                                      'latestRequestAt': latest, 'truncated': truncated},
            'limitations': ['No checkout samples means unmeasured, not a latency pass.',
                            'Application logs do not measure failures before the gateway; pair with external HTTPS probes.']}


def handle(envelope, merchant):
    config = merchant.read_json('/etc/rocento/fleet-node.json')
    if envelope['hostId'] != config['hostId']:
        raise ValueError('HOST_IDENTITY_MISMATCH')
    operation = envelope['operation']
    if operation == 'inspect':
        return identity(config, merchant)
    if operation == 'observe':
        return observe(envelope, config, merchant)
    if operation == 'prepare':
        return prepare(envelope, config, merchant)
    if operation == 'provision':
        binding = envelope['binding']
        if (binding['environment'] != config['environment']
                or binding['hostingProvider'] != config['provider']
                or binding['artifactDigest'] != config['releaseDigest']
                or not time.time() < binding['expiresAt'] <= time.time() + 180):
            raise ValueError('REMOTE_AUTHORIZATION_EXPIRED_OR_MISMATCHED')
        request = envelope['request']
        # Validate the protocol before side effects; receipt reconciliation is read-only.
        merchant.validate_request(request, {request['job']['tenantId']: binding})
        with merchant.execution_window(binding, 15 if request['operation'] == 'reconcile' else 100):
            if request['operation'] == 'execute':
                metadata_firewall(merchant)
            return merchant.execute_bound(request, binding)
    if operation == 'restrict':
        controls = load('controls', 'tenant-controls.py')
        merchant.STATE.mkdir(mode=0o700, exist_ok=True)
        with (merchant.STATE / 'deployment.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            controls.restrict_runtime(envelope['command'])
        return {'hostId': config['hostId'], 'restricted': envelope['command']['tenantId']}
    raise ValueError('INVALID_NODE_OPERATION')


def main():
    os.umask(0o077)
    merchant = load('merchant', 'merchant-executor.py')
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('REQUEST_TOO_LARGE')
        result = handle(json.loads(raw, object_pairs_hook=merchant.unique), merchant)
    except BlockingIOError:
        result = {'blocked': True}
    except merchant.Blocked as error:
        result = {'blocked': True, 'reason': str(error)}
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'NODE_EXECUTION_FAILED'
        result = {'error': code}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
