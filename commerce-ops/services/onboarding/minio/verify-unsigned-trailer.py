"""Run benign unsupported-feature denial and signed S3 checks in local MinIO.

No exploit payloads are generated. Credentials are random and remain local.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Already-built local candidate image ID or tag')
parser.add_argument('--output', required=True, type=Path, help='Sanitized JSON report path')
args = parser.parse_args()
if not __debug__:
    parser.error('Python optimization disables required checks; run without -O or PYTHONOPTIMIZE')
IMAGE = args.image
OUT = args.output
report = {'schemaVersion': 1, 'imageId': IMAGE, 'approval': 'NOT_APPROVED', 'checks': {}, 'scope': 'Benign unsupported-feature denial and signed S3 operations in disposable local MinIO; no exploit reproduction, merchant activation, or full Grocery runtime verification'}
container = None
network = None
stage = 'initialization'

def docker(*args):
    r = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise RuntimeError('docker command failed')
    return r.stdout.strip()

try:
    IMAGE = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
    report['imageId'] = IMAGE
    with tempfile.TemporaryDirectory(prefix='minio-security-') as temp:
        access = secrets.token_hex(10)
        secret = secrets.token_hex(24)
        env = Path(temp) / 'runtime.env'
        env.write_text(f'MINIO_ROOT_USER={access}\nMINIO_ROOT_PASSWORD={secret}\nMINIO_BROWSER=off\n')
        env.chmod(0o600)
        suffix = secrets.token_hex(6)
        stage = 'create-fixture'
        network = docker('network', 'create', 'rocento-security-' + suffix)
        container = docker('create', '--name', 'rocento-security-' + suffix, '--network', network,
                           '--read-only', '--memory', '1g', '--pids-limit', '256',
                           '--tmpfs', '/data:rw,size=256m', '--tmpfs', '/tmp:rw,size=64m',
                           '--env-file', str(env), '-p', '127.0.0.1::9000', IMAGE, 'server', '/data')
        docker('start', container)
        info = json.loads(docker('inspect', container))[0]
        binding = info['NetworkSettings']['Ports']['9000/tcp'][0]
        assert binding['HostIp'] == '127.0.0.1'
        assert info['Image'] == IMAGE
        assert not any(m['Type'] == 'volume' for m in info['Mounts'])
        host = '127.0.0.1:' + binding['HostPort']
        base = 'http://' + host
        report['checks']['loopback-only-fixture-no-persistent-volumes'] = True
        stage = 'health'
        for attempt in range(60):
            try:
                with urllib.request.urlopen(base + '/minio/health/ready', timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(0.5)
        else:
            raise RuntimeError('readiness timeout')
        report['checks']['readiness'] = True

        def request(method, path, payload=b'', signed=True, extra_headers=None):
            headers = {}
            if signed:
                now = datetime.datetime.now(datetime.timezone.utc)
                timestamp = now.strftime('%Y%m%dT%H%M%SZ')
                day = now.strftime('%Y%m%d')
                payload_hash = hashlib.sha256(payload).hexdigest()
                canonical_headers = f'host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{timestamp}\n'
                signed_headers = 'host;x-amz-content-sha256;x-amz-date'
                canonical_request = '\n'.join([method, path, '', canonical_headers, signed_headers, payload_hash])
                scope = day + '/us-east-1/s3/aws4_request'
                to_sign = '\n'.join(['AWS4-HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
                key = ('AWS4' + secret).encode()
                for item in [day, 'us-east-1', 's3', 'aws4_request']:
                    key = hmac.new(key, item.encode(), hashlib.sha256).digest()
                signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
                headers = {'x-amz-content-sha256': payload_hash, 'x-amz-date': timestamp,
                           'Authorization': f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed_headers}, Signature={signature}'}
            headers.update(extra_headers or {})
            data = payload if method in ('PUT', 'POST') else None
            req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        stage = 's3-operations'
        assert request('PUT', '/security-fixture')[0] == 200
        payload = b'Rocento disposable storage compatibility fixture\n'
        assert request('PUT', '/security-fixture/object.txt', payload,
                       extra_headers={'Content-Type': 'application/octet-stream'})[0] == 200
        status, content = request('GET', '/security-fixture/object.txt')
        assert status == 200 and content == payload
        assert request('GET', '/security-fixture/object.txt', signed=False)[0] == 403
        stage = 'unsigned-trailer-header-denial'
        for method, path in [
            ('PUT', '/security-fixture/denied.txt'),
            ('GET', '/security-fixture/object.txt'),
            ('POST', '/security-fixture/denied.txt'),
        ]:
            status, body = request(method, path, b'ordinary fixture content', signed=False,
                                   extra_headers={'X-Amz-Content-Sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'})
            assert status == 400 and b'<Code>InvalidRequest</Code>' in body
        report['checks']['unsigned-trailer-header-rejected-put-get-post'] = True
        assert request('GET', '/security-fixture/denied.txt')[0] == 404
        report['checks']['denied-ordinary-put-did-not-create-object'] = True
        stage = 'unsupported-s3-feature-denial'
        for index, path in enumerate([
            '/security-fixture/object.txt?select&select-type=2',
            '/security-fixture/object.txt?select-type=2&%73elect',
            '/security-fixture/object.txt?select=&select-type=2&select=fixture',
        ]):
            status, body = request('POST', path, b'ordinary fixture content', signed=False)
            code = re.search(rb'<Code>([A-Za-z]+)</Code>', body)
            report.setdefault('denialObservations', []).append({
                'check': 'select-route-' + str(index), 'httpStatus': status,
                's3ErrorCode': code[1].decode() if code else None,
            })
            assert status == 501 and b'<Code>NotImplemented</Code>' in body
        report['checks']['s3-select-disabled-before-content-processing'] = True
        for header in [
            'X-Minio-Replication-Server-Side-Encryption-Iv',
            'X-Minio-Replication-Encrypted-Multipart',
            'X-Minio-Replication-Actual-Object-Size',
            'X-Minio-Source-Replication-Request',
        ]:
            status, body = request('PUT', '/security-fixture/replication-denied.txt',
                                   b'ordinary fixture content', signed=False,
                                   extra_headers={header: 'disabled-feature-fixture'})
            assert status == 501 and b'<Code>NotImplemented</Code>' in body
        report['checks']['replication-headers-and-marker-disabled'] = True
        assert request('GET', '/security-fixture/replication-denied.txt')[0] == 404
        report['checks']['denied-replication-request-did-not-create-object'] = True
        status, content = request('GET', '/security-fixture/object.txt')
        assert status == 200 and content == payload
        report['checks']['signed-read-still-works-after-denial'] = True
        stage = 's3-cleanup'
        assert request('DELETE', '/security-fixture/object.txt')[0] == 204
        assert request('GET', '/security-fixture/object.txt')[0] == 404
        assert request('DELETE', '/security-fixture')[0] == 204
        report['checks']['signed-bucket-create-object-write-read-delete'] = True
        report['checks']['anonymous-object-read-denied'] = True
        report['status'] = 'passed'
except Exception as error:
    report.update(status='failed', stage=stage, errorType=type(error).__name__)
finally:
    if container:
        try:
            docker('rm', '-f', container)
            report['checks']['fixture-container-removed'] = True
        except Exception:
            report['checks']['fixture-container-removed'] = False
            report['status'] = 'failed'
    if network:
        try:
            docker('network', 'rm', network)
            report['checks']['fixture-network-removed'] = True
        except Exception:
            report['checks']['fixture-network-removed'] = False
            report['status'] = 'failed'
    report['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    OUT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    raise SystemExit(0 if report.get('status') == 'passed' else 1)
