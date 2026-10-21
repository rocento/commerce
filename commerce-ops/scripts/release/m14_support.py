"""Shared isolated provider stack for M14 fault drills; no development service mutations."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import copy
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        # Commands can contain credentials, so do not echo argv or resolved config.
        raise RuntimeError(result.stderr.decode(errors='replace')[-3000:])
    return result.stdout


def wait_for(fn, seconds=90):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            if fn():
                return
        except (OSError, RuntimeError) as error:
            last = error
        time.sleep(.2)
    raise RuntimeError(f'Timed out waiting for recovery: {last}')


class Client:
    def __init__(self, url):
        self.url = url
        self.token = None
        self.http = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None):
        headers = {'Content-Type': 'application/json', 'X-Commerce-Request': '1'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(self.url + path, method=method, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
        with self.http.open(request, timeout=150) as response:
            return json.load(response)


class Stack:
    def __init__(self):
        self.project = 'commerce-m14-' + uuid.uuid4().hex[:12]
        self.directory = ROOT / '.local' / 'm14' / self.project
        self.directory.mkdir(parents=True, mode=0o700)
        self.api = None
        self.log = None
        self.analytics = self.analytics_log = None
        self.config = json.loads(run(['docker', 'compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'config', '--format', 'json'], cwd=ROOT))
        targets = {'postgres': [5432], 'engagement-postgres': [5432], 'clickhouse': [8123], 'nats': [4222, 8222],
                   'meilisearch': [7700], 'minio': [9000]}
        services = {}
        volumes = {}
        self.allocated_ports = set()
        for name, ports in targets.items():
            service = copy.deepcopy(self.config['services'][name])
            service.pop('networks', None)
            service.pop('container_name', None)
            service['restart'] = 'no'
            service['ports'] = [{'target': port, 'host_ip': '127.0.0.1', 'published': str(self.free_port())} for port in ports]
            for volume in service.get('volumes', []):
                if volume['type'] != 'volume':
                    raise RuntimeError('Provider has unexpected non-volume storage')
                volumes[volume['source']] = {}
            services[name] = service
        self.spec = {'services': services, 'volumes': volumes}
        self.path = self.directory / 'compose.json'
        self.base = ['docker', 'compose', '-p', self.project, '-f', str(self.path)]

    def free_port(self):
        while True:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            if port not in self.allocated_ports:
                self.allocated_ports.add(port)
                return port

    def save(self):
        # Create with restrictive permissions before writing credentials.
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(self.spec, output)

    def compose(self, *args):
        return run(self.base + list(args))

    def port(self, service, target):
        return self.compose('port', service, str(target)).decode().strip().rsplit(':', 1)[1]

    def sql(self, query, service='postgres', database=None):
        database = database or self.spec['services']['postgres']['environment']['POSTGRES_DB']
        return self.compose('exec', '-T', service, 'sh', '-c',
                            'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -Atc "$2"',
                            'sh', database, query).decode().strip()

    def ch(self, query):
        return self.compose('exec', '-T', 'clickhouse', 'sh', '-c',
                            'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"',
                            'sh', query).decode().strip()

    def database_url(self, service='postgres'):
        pg = self.spec['services']['postgres']['environment']
        quote = lambda value: urllib.parse.quote(value, safe='')
        return f"postgres://{quote(pg['POSTGRES_USER'])}:{quote(pg['POSTGRES_PASSWORD'])}@127.0.0.1:{self.port(service, 5432)}/{quote(pg['POSTGRES_DB'])}"

    def start(self):
        self.save()
        self.compose('up', '-d', '--wait', '--wait-timeout', '150')
        self.env = dict(os.environ)
        for key in ('DATABASE_URL', 'LOKI_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'ASSISTANT_ENABLED', 'ASSISTANT_TENANT_ID'):
            self.env.pop(key, None)
        self.env.update(self.config['services']['api-gateway']['environment'])
        self.env['DATABASE_URL'] = self.database_url()
        pg = self.spec['services']['engagement-postgres']['environment']
        self.env['ENGAGEMENT_DATABASE_URL'] = f"postgres://engagement:{urllib.parse.quote(pg['POSTGRES_PASSWORD'], safe='')}@127.0.0.1:{self.port('engagement-postgres',5432)}/engagement"
        for key, service, port, scheme in [('NATS_URL', 'nats', 4222, 'nats'),
                ('CLICKHOUSE_URL', 'clickhouse', 8123, 'http'), ('S3_ENDPOINT', 'minio', 9000, 'http'),
                ('MEILI_URL', 'meilisearch', 7700, 'http')]:
            self.env[key] = f'{scheme}://127.0.0.1:{self.port(service, port)}'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.api_port = sock.getsockname()[1]
        self.env['BIND_ADDRESS'] = f'127.0.0.1:{self.api_port}'
        self.env['RESERVATION_TTL_SECONDS'] = '3600'
        self.url = 'http://' + self.env['BIND_ADDRESS']
        self.start_api()

    def start_api(self):
        self.stop_analytics()
        self.log = (self.directory / 'gateway.log').open('ab')
        self.api = subprocess.Popen([str(ROOT / 'commerce-api/rocento-api/target/debug/api-gateway')], env=self.env,
                                    stdout=self.log, stderr=subprocess.STDOUT)
        def ready():
            if self.api.poll() is not None:
                raise RuntimeError(f'Gateway exited; inspect {self.directory / "gateway.log"}')
            return urllib.request.urlopen(self.url + '/ready', timeout=2).status == 200
        wait_for(ready)
        analytics_address = f'127.0.0.1:{self.free_port()}'
        self.analytics_log = (self.directory / 'analytics.log').open('ab')
        self.analytics = subprocess.Popen([str(ROOT / 'commerce-api/rocento-api/target/debug/analytics-worker')],
            env=dict(self.env, ANALYTICS_BIND_ADDRESS=analytics_address),
            stdout=self.analytics_log, stderr=subprocess.STDOUT)
        wait_for(lambda: urllib.request.urlopen('http://' + analytics_address + '/ready', timeout=3).status == 200)

    def stop_analytics(self):
        if self.analytics and self.analytics.poll() is None:
            self.analytics.terminate()
            self.analytics.wait(timeout=15)
        if self.analytics_log:
            self.analytics_log.close()

    def stop_api(self, kill=False):
        if self.api and self.api.poll() is None:
            self.api.kill() if kill else self.api.terminate()
            self.api.wait(timeout=45)
        if self.log:
            self.log.close()

    def close(self):
        self.stop_analytics()
        self.stop_api()
        if self.path.exists():
            (self.directory / 'providers.log').write_bytes(self.compose('logs', '--no-color'))
        self.compose('down')
        print(f'Retained isolated volumes and evidence for {self.project}: {self.directory}', flush=True)
