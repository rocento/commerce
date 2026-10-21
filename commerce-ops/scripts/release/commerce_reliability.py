"""Repeatable synthetic commerce evidence; never accepts a target URL or database.

Uses local Docker providers and freshly built native Rust binaries. Debug results
are correctness/development evidence, not production capacity measurements.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import concurrent.futures
import copy
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import socket
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

from m14_support import Client, ROOT, Stack

ORDER_ANALYTICS_RECEIPT = 'order-analytics-v2'
ORDER_NOTIFICATION_RECEIPT = 'order-notifications-v1'
ORDER_CONSUMERS = ('order-facts-v1', 'order-notifications-v1')


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def host_environment():
    # Do not inherit application credentials, Compose overrides, or telemetry URLs.
    return {key: os.environ[key] for key in
            ('PATH', 'HOME', 'TMPDIR', 'LANG', 'RUSTUP_HOME', 'CARGO_HOME') if key in os.environ}


def command(args, *, env=None, timeout=180):
    result = subprocess.run(args, cwd=ROOT, env=env or host_environment(),
                            capture_output=True, timeout=timeout)
    if result.returncode:
        # Neither argv nor provider output are safe to include in the public report.
        raise RuntimeError(f'{Path(args[0]).name} failed with exit {result.returncode}')
    return result.stdout


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    path.chmod(0o600)


def source_manifest():
    files = {}
    for directory, names, filenames in os.walk(ROOT / 'commerce-api/rocento-api'):
        names[:] = sorted(name for name in names if name not in ('target', '.git'))
        for name in sorted(filenames):
            path = Path(directory) / name
            if path.suffix in ('.rs', '.sql', '.toml', '.lock', '.json'):
                files[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ('commerce-ops/compose/compose.yaml', 'commerce-ops/scripts/commerce_reliability.py',
                 'commerce-ops/scripts/commerce-reliability.py', 'commerce-ops/scripts/commerce_release.py', 'commerce-ops/scripts/commerce-release.py',
                 'commerce-ops/scripts/commerce_image.py', 'commerce-api/rocento-api/Dockerfile', 'commerce-api/rocento-api/.dockerignore',
                 'commerce-ops/scripts/system-qa-http.py', 'commerce-ops/scripts/m14_support.py',
                 'commerce-ops/scripts/release/commerce_reliability.py', 'commerce-ops/scripts/release/commerce-reliability.py',
                 'commerce-ops/scripts/release/commerce_release.py', 'commerce-ops/scripts/release/commerce-release.py',
                 'commerce-ops/scripts/release/commerce_image.py', 'commerce-ops/scripts/release/system-qa-http.py',
                 'commerce-ops/scripts/release/m14_support.py'):
        files[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return {'sha256': digest, 'files': files}


def wait_until(fn, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if fn():
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError('Timed out waiting for isolated service readiness')


class BaselineStack(Stack):
    """Reuse SQL/port helpers, but resolve providers with private synthetic settings."""
    def __init__(self, directory, profile):
        self.directory = directory
        self.profile = profile
        self.project = 'commerce-reliability-' + uuid.uuid4().hex[:12]
        self.api = self.log = None
        self.analytics_process = self.analytics_log = None
        self.console_order_events = []
        self.sql_profiling = False
        self.binary_directory = None
        self.engagement_process = self.engagement_log = None
        self.allocated_ports = set()
        endpoint = command(['docker', 'context', 'inspect', '--format',
                            '{{.Endpoints.docker.Host}}']).decode().strip()
        check(endpoint.startswith('unix://'), 'Baseline requires a local Unix-socket Docker context')
        self.empty_env = directory / 'empty.env'
        self.empty_env.touch(mode=0o600)
        private = dict(host_environment(), POSTGRES_PASSWORD=uuid.uuid4().hex,
                       CLICKHOUSE_PASSWORD=uuid.uuid4().hex, MEILI_MASTER_KEY=uuid.uuid4().hex,
                       MINIO_ROOT_PASSWORD=uuid.uuid4().hex, AUTH_SECRET=uuid.uuid4().hex * 2)
        self.config = json.loads(command(['docker', 'compose', '--env-file', str(self.empty_env),
            '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'config', '--format', 'json'], env=private))
        targets = {'postgres': [5432], 'engagement-postgres': [5432], 'clickhouse': [8123],
                   'nats': [4222, 8222], 'meilisearch': [7700], 'minio': [9000]}
        services, volumes = {}, {}
        for name, ports in targets.items():
            service = copy.deepcopy(self.config['services'][name])
            for key in ('networks', 'container_name', 'depends_on', 'build'):
                service.pop(key, None)
            service['restart'] = 'no'
            service['cpus'] = '1.0'
            service['mem_limit'] = '1g' if name in ('postgres', 'clickhouse', 'meilisearch') else '512m'
            service['ports'] = [{'target': port, 'host_ip': '127.0.0.1',
                                 'published': str(self.free_port())} for port in ports]
            for volume in service.get('volumes', []):
                check(volume['type'] == 'volume', 'Baseline providers require project-owned volumes')
                volumes[volume['source']] = {}
            services[name] = service
        self.spec = {'services': services, 'volumes': volumes}
        self.path = directory / 'compose.json'
        self.base = ['docker', 'compose', '--env-file', str(self.empty_env),
                     '-p', self.project, '-f', str(self.path)]

    def compose(self, *args):
        return command(self.base + list(args))

    def start(self):
        if self.sql_profiling:
            self.spec['services']['postgres']['command'] += ['-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all']
        self.save()
        self.compose('up', '-d', '--wait', '--wait-timeout', '150')
        if self.sql_profiling:
            self.sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
        self.env = dict(host_environment(), **self.config['services']['api-gateway']['environment'])
        self.env['DATABASE_URL'] = self.database_url()
        engagement = self.spec['services']['engagement-postgres']['environment']
        self.env['ENGAGEMENT_DATABASE_URL'] = (
            f"postgres://engagement:{engagement['POSTGRES_PASSWORD']}@127.0.0.1:"
            f"{self.port('engagement-postgres', 5432)}/engagement")
        for key, service, port, scheme in [('NATS_URL', 'nats', 4222, 'nats'),
                ('CLICKHOUSE_URL', 'clickhouse', 8123, 'http'), ('S3_ENDPOINT', 'minio', 9000, 'http'),
                ('MEILI_URL', 'meilisearch', 7700, 'http')]:
            self.env[key] = f'{scheme}://127.0.0.1:{self.port(service, port)}'
        # Explicit development adapters: never external email, models, or telemetry.
        self.env.update(APP_ENV='development', NOTIFICATION_MODE='console',
                        COOKIE_SECURE='false', RESERVATION_TTL_SECONDS='3600',
                        REPORTING_INTERVAL_SECONDS='1800', DB_MAX_CONNECTIONS='10')
        self.env.pop('ASSISTANT_TENANT_ID', None)
        self.env['BIND_ADDRESS'] = f'127.0.0.1:{self.free_port()}'
        self.url = 'http://' + self.env['BIND_ADDRESS']
        self.start_api()
        self.analytics_url = f'http://127.0.0.1:{self.free_port()}'
        self.start_analytics()

    def start_analytics(self, wait=True):
        self.analytics_log = (self.directory / 'analytics.log').open('ab')
        environment = dict(self.env, ANALYTICS_BIND_ADDRESS=self.analytics_url.removeprefix('http://'))
        self.analytics_process = subprocess.Popen([str(self.binary('analytics-worker'))], env=environment,
            stdout=self.analytics_log, stderr=subprocess.STDOUT)
        if wait:
            wait_until(lambda: self.analytics_ready(), 90)

    def analytics_ready(self):
        check(self.analytics_process.poll() is None, 'Analytics worker exited; inspect private analytics.log')
        try:
            with urllib.request.urlopen(self.analytics_url + '/ready', timeout=3) as response:
                return response.status == 200
        except urllib.error.HTTPError as error:
            if error.code == 503:
                return False
            raise

    def stop_analytics(self, kill=False):
        if self.analytics_process and self.analytics_process.poll() is None:
            self.analytics_process.kill() if kill else self.analytics_process.terminate()
            self.analytics_process.wait(timeout=15)
        if self.analytics_log:
            self.analytics_log.close()

    def analytics_metrics(self, name):
        with urllib.request.urlopen(self.analytics_url + '/metrics', timeout=4) as response:
            text = response.read().decode()
        (self.directory / f'{name}-analytics.prom').write_text(text)
        return text

    def binary(self, name):
        if self.binary_directory is not None:
            return self.binary_directory / name
        return ROOT / 'commerce-api' / 'target' / self.profile / name

    def start_api(self):
        self.log = (self.directory / 'gateway.log').open('ab')
        self.api = subprocess.Popen([str(self.binary('api-gateway'))], env=self.env,
                                    stdout=self.log, stderr=subprocess.STDOUT)
        def ready():
            check(self.api.poll() is None, 'Gateway exited; inspect private gateway.log')
            with urllib.request.urlopen(self.url + '/ready', timeout=2) as response:
                return response.status == 200
        wait_until(ready)

    def metrics(self, name):
        with urllib.request.urlopen(self.url + '/metrics', timeout=3) as response:
            text = response.read().decode()
        (self.directory / f'{name}.prom').write_text(text)
        return text

    def start_engagement(self):
        self.engagement_log = (self.directory / 'engagement.log').open('ab')
        self.engagement_process = subprocess.Popen([str(self.binary('engagement-worker'))], env=self.env,
            stdout=self.engagement_log, stderr=subprocess.STDOUT)
        wait_until(self.engagement_ready)

    def engagement_ready(self):
        check(self.engagement_process.poll() is None, 'Engagement worker exited; inspect private engagement.log')
        result = subprocess.run([str(self.binary('engagement-worker')), '--health'], env=self.env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        return result.returncode == 0

    def stop_engagement(self):
        if self.engagement_process and self.engagement_process.poll() is None:
            self.engagement_process.terminate()
            try:
                self.engagement_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.engagement_process.kill()
                self.engagement_process.wait(timeout=15)
        if self.engagement_log:
            self.engagement_log.close()

    def close(self):
        errors = []
        for stop in (self.stop_engagement, self.stop_analytics, self.stop_api):
            try:
                stop()
            except Exception as error:
                errors.append(error)
        if self.path.exists():
            try:
                (self.directory / 'providers.log').write_bytes(self.compose('logs', '--no-color'))
            except Exception as error:
                errors.append(error)
            finally:
                # This exact generated project owns all volumes; no external targets accepted.
                self.compose('down', '--volumes', '--remove-orphans')
        if errors:
            raise RuntimeError('Service cleanup failed') from errors[0]


def load_qa():
    spec = importlib.util.spec_from_file_location('baseline_http_qa', ROOT / 'commerce-ops/scripts/system-qa-http.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def summarize(samples):
    groups = {}
    for sample in samples:
        groups.setdefault(sample['operation'], []).append(sample)
    result = {}
    for operation, rows in groups.items():
        successful = [row['seconds'] for row in rows if 200 <= row['status'] < 300]
        statuses = {}
        for row in rows:
            key = str(row['status']) if row['status'] else 'transport_error'
            statuses[key] = statuses.get(key, 0) + 1
        result[operation] = {
            'requests': len(rows), 'statuses': statuses, 'successful_requests': len(successful),
            'success_p50_seconds': percentile(successful, .50),
            'success_p95_seconds': percentile(successful, .95),
            'success_p99_seconds': percentile(successful, .99),
            'all_max_seconds': max(row['seconds'] for row in rows),
        }
    return result


def measured_call(client, samples, operation, method, path, body=None):
    headers = {'Content-Type': 'application/json', 'X-Commerce-Request': '1'}
    if client.token:
        headers['Authorization'] = 'Bearer ' + client.token
    request = urllib.request.Request(client.url + path, method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    started, status = time.perf_counter(), 0
    try:
        with client.http.open(request, timeout=35) as response:
            status = response.status
            return json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        raise
    finally:
        samples.append({'operation': operation, 'status': status,
                        'seconds': time.perf_counter() - started})


def fixtures(stack, count, qa, password):
    admin = Client(stack.url)
    admin.call('POST', '/v1/admin/auth/login', {'email': 'http-qa-admin@example.test', 'password': password})
    category = admin.call('POST', '/v1/admin/catalog/categories',
                         {'name': 'Reliability', 'slug': 'reliability', 'parent_id': None})
    users = []
    for index in range(count):
        client = Client(stack.url)
        _, location = qa.verified_customer(stack, client, f'baseline-{index}@example.test', password)
        product = admin.call('POST', '/v1/admin/catalog/products', {
            'sku': f'BASELINE-{index}', 'name': f'Baseline {index}', 'slug': f'baseline-{index}',
            'description': 'Synthetic reliability fixture', 'price': '1.20', 'currency': 'USD',
            'unit': 'each', 'category_id': category['id'], 'attributes': {},
            'media_ids': [], 'active': True, 'in_stock': True})
        admin.call('PUT', '/v1/admin/inventory/' + product['id'],
                   {'on_hand': 10000, 'reason': 'Isolated reliability baseline'})
        client.call('POST', '/v1/cart')
        users.append((client, location['id'], product['id']))
    return users


def invariants(stack):
    return json.loads(stack.sql("""SELECT json_build_object(
        'orders', (SELECT count(*) FROM orders.orders),
        'invalid_payments', (SELECT count(*) FROM orders.orders o LEFT JOIN payments.payment_transactions p ON p.order_id=o.id
            WHERE p.order_id IS NULL OR p.amount_due<>o.total OR p.currency<>o.currency),
        'invalid_allocations', (SELECT count(*) FROM orders.order_items i WHERE i.quantity<>
            COALESCE((SELECT sum(a.quantity) FROM inventory.order_allocations a WHERE a.order_id=i.order_id AND a.product_id=i.product_id),0)),
        'invalid_order_events', (SELECT count(*) FROM orders.orders o WHERE 1<>
            (SELECT count(*) FROM platform.outbox e WHERE e.event_type='order.placed' AND e.payload->>'order_id'=o.id::text)),
        'negative_stock', (SELECT count(*) FROM inventory.source_items WHERE quantity<0),
        'stock_mismatch', (SELECT count(*) FROM catalog.products p JOIN inventory.stock s ON s.product_id=p.id
            WHERE p.sku LIKE 'BASELINE-%' AND s.on_hand <> 10000-COALESCE(
                (SELECT sum(i.quantity) FROM orders.order_items i WHERE i.product_id=p.id),0)),
        'remaining_cart_lines', (SELECT count(*) FROM cart_checkout.items))"""))


def run_stage(stack, users, concurrency, iterations, name):
    before = invariants(stack)
    stack.metrics(name + '-before')
    if getattr(stack, 'sql_profiling', False):
        stack.sql('SELECT pg_stat_statements_reset()')
    barrier = threading.Barrier(concurrency)
    def shopper(fixture):
        client, location, product = fixture
        samples, orders, failure = [], [], None
        barrier.wait(timeout=15)
        try:
            for _ in range(iterations):
                measured_call(client, samples, 'browse_product', 'GET', '/v1/catalog/products/' + product)
                measured_call(client, samples, 'cart_read', 'POST', '/v1/cart')
                measured_call(client, samples, 'cart_add', 'POST', '/v1/cart/items', {'product_id': product, 'quantity': 1})
                quote = measured_call(client, samples, 'checkout_quote', 'POST',
                    '/v1/customer/checkout/quote', {'location_id': location})
                order = measured_call(client, samples, 'checkout_place', 'POST',
                    '/v1/customer/checkout/place', {'quote_id': quote['id'], 'idempotency_key': str(uuid.uuid4())})
                orders.append(order['order']['id'])
        except Exception as error:
            # An uncertain write is never automatically replayed with a new key.
            failure = type(error).__name__
        return samples, orders, failure
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        outcomes = list(executor.map(shopper, users[:concurrency]))
    ended = time.time()
    samples = [sample for rows, _, _ in outcomes for sample in rows]
    orders = [order for _, rows, _ in outcomes for order in rows]
    failures = [failure for _, _, failure in outcomes if failure]
    after = invariants(stack)
    correct = (not failures and len(orders) == concurrency * iterations
               and len(set(orders)) == len(orders)
               and after['orders'] - before['orders'] == len(orders)
               and all(value == 0 for key, value in after.items() if key != 'orders'))
    if getattr(stack, 'sql_profiling', False):
        profile = json.loads(stack.sql("""SELECT COALESCE(json_agg(s),'[]'::json) FROM
            (SELECT queryid::text,query,calls,total_exec_time,mean_exec_time,rows,shared_blks_hit,shared_blks_read
             FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
             ORDER BY total_exec_time DESC LIMIT 100) s"""))
        write_json(stack.directory / f'{name}-sql-profile.json', profile)
    stack.metrics(name + '-after')
    write_json(stack.directory / f'{name}-samples.json', samples)
    return {'name': name, 'concurrency': concurrency, 'iterations_per_shopper': iterations,
            'started_unix': started, 'ended_unix': ended, 'duration_seconds': ended - started,
            'completed_orders': len(orders), 'orders_per_second': len(orders) / (ended - started),
            'operations': summarize(samples), 'invariants': after, 'failures': failures,
            'passed': correct}


def reporting_stage(stack, users, concurrency, iterations):
    stopped, started = threading.Event(), threading.Event()
    refreshes = []
    def refresh():
        with (stack.directory / 'reporting.log').open('ab') as output:
            while not stopped.is_set():
                begin = time.time()
                process = subprocess.Popen([str(stack.binary('sync-reports'))], env=stack.env,
                    stdout=output, stderr=subprocess.STDOUT)
                started.set()
                try:
                    code = process.wait(timeout=90)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    code = -1
                refreshes.append({'started_unix': begin, 'ended_unix': time.time(), 'exit_code': code})
                if code:
                    return
                stopped.wait(.1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(refresh)
        try:
            check(started.wait(10), 'Reporting process did not start')
            result = run_stage(stack, users, concurrency, iterations, 'with-reporting')
        finally:
            stopped.set()
            future.result()
    overlap = [row for row in refreshes if row['started_unix'] < result['ended_unix']
               and row['ended_unix'] > result['started_unix']]
    result['reporting_refreshes'] = refreshes
    result['passed'] = result['passed'] and bool(overlap) and all(row['exit_code'] == 0 for row in refreshes)
    return result


def enable_queued_order_confirmations(stack):
    """Keep console authentication acceptance, then queue later synthetic orders."""
    stack.console_order_events = json.loads(stack.sql(
        "SELECT COALESCE(json_agg(id),'[]') FROM platform.outbox WHERE event_type='order.placed'"))
    expected = len(stack.console_order_events)
    check(expected == int(stack.sql('SELECT count(*) FROM orders.orders')),
          'Console bootstrap orders must each have one outbox event')
    wait_until(lambda: int(stack.sql(
        f"SELECT count(*) FROM platform.consumer_receipts WHERE consumer_name='{ORDER_NOTIFICATION_RECEIPT}'")) == expected)
    # All bootstrap order events are receipted before changing adapters, so the
    # exemption cannot include a later purchase that fails to queue a job.
    stack.stop_api()
    stack.env.update(NOTIFICATION_MODE='mailpit', MAILPIT_URL='http://127.0.0.1:1')
    stack.start_api()
    return {'console_bootstrap_orders': expected, 'external_delivery_verified': False}


def confirmation_state(stack, expected):
    console_events = getattr(stack, 'console_order_events', [])
    excluded = ','.join(f"'{uuid.UUID(event)}'" for event in console_events)
    eligible = f'AND event.id NOT IN ({excluded})' if excluded else ''
    return {
        'expected_receipts': expected,
        'expected_notification_jobs': expected - len(console_events),
        'notification_receipts': int(stack.sql(
            f"SELECT count(*) FROM platform.consumer_receipts WHERE consumer_name='{ORDER_NOTIFICATION_RECEIPT}'")),
        'notification_jobs': int(stack.sql("SELECT count(*) FROM platform.notification_jobs WHERE purpose='order'")),
        'orders_missing_notification_jobs': int(stack.sql(
            "SELECT count(*) FROM platform.outbox event WHERE event.event_type='order.placed' "
            f"{eligible} AND NOT EXISTS (SELECT 1 FROM platform.notification_jobs job "
            "WHERE job.id=event.id AND job.purpose='order')")),
    }


def confirmations_complete(state):
    return (state['notification_receipts'] == state['expected_receipts']
            and state['notification_jobs'] == state['expected_notification_jobs']
            and state['orders_missing_notification_jobs'] == 0)


def wait_for_confirmations(stack):
    expected = int(stack.sql('SELECT count(*) FROM orders.orders'))
    observed = {}
    def complete():
        observed.update(confirmation_state(stack, expected))
        return confirmations_complete(observed)
    wait_until(complete, 90)
    return observed


def analytics_faults(stack, users, password):
    """Faults target only the runner-owned process and provider project."""
    result = {'stages': []}
    original_gateway = stack.api.pid
    print('Killing analytics worker; verifying commerce remains available.', flush=True)
    stack.stop_analytics(kill=True)
    stage = run_stage(stack, users, min(2, len(users)), 2, 'analytics-worker-down')
    result['stages'].append(stage)
    check(stage['passed'] and stack.api.pid == original_gateway and stack.api.poll() is None,
          'Worker failure affected commerce')
    stage['confirmations_during_outage'] = wait_for_confirmations(stack)
    print('Stopping ClickHouse and restarting gateway; verifying independent startup.', flush=True)
    stack.compose('stop', '-t', '3', 'clickhouse')
    stack.stop_api()
    stack.start_api()  # /ready must succeed even while ClickHouse is stopped.
    result['gateway_started_without_clickhouse'] = True
    admin = Client(stack.url)
    admin.call('POST', '/v1/admin/auth/login', {'email': 'http-qa-admin@example.test', 'password': password})
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    try:
        admin.call('GET', f'/v1/admin/reports/dashboard?from={today}&to={today}')
    except urllib.error.HTTPError as error:
        check(error.code == 503 and error.headers.get('Retry-After') == '3',
              'Reporting outage must return retryable 503')
        result['reporting_outage_status'] = error.code
    else:
        raise RuntimeError('Reporting unexpectedly succeeded without ClickHouse')
    stack.start_analytics(wait=False)
    wait_until(lambda: not stack.analytics_ready())
    result['worker_started_unready_without_clickhouse'] = True
    stage = run_stage(stack, users, min(2, len(users)), 2, 'clickhouse-down')
    result['stages'].append(stage)
    check(stage['passed'], 'ClickHouse outage affected commerce')
    stage['confirmations_during_outage'] = wait_for_confirmations(stack)
    current_gateway = stack.api.pid
    print('Restoring ClickHouse; verifying replay, report recovery and notification receipts.', flush=True)
    stack.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'clickhouse')
    wait_until(stack.analytics_ready, 120)
    expected = int(stack.sql('SELECT count(*) FROM orders.orders'))
    def recovered():
        facts = int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL'))
        receipts = int(stack.sql(f"SELECT count(*) FROM platform.consumer_receipts WHERE consumer_name='{ORDER_ANALYTICS_RECEIPT}'"))
        return facts == receipts == expected and confirmations_complete(confirmation_state(stack, expected))
    wait_until(recovered, 150)
    wait_until(lambda: any(line.startswith('commerce_reporting_last_success_seconds ') and float(line.split()[-1]) > 0
                          for line in stack.analytics_metrics('recovered').splitlines()), 90)
    report = admin.call('GET', f'/v1/admin/reports/dashboard?from={today}&to={today}')
    check(bool(report.get('run')), 'Reporting did not recover a complete generation')
    stack.stop_analytics()
    stack.start_analytics()
    wait_until(recovered, 150)
    check(stack.api.pid == current_gateway and stack.api.poll() is None,
          'Recovery restarted commerce')
    result.update(passed=True, recovered_orders=expected, **confirmation_state(stack, expected),
                  logical_order_facts=expected, analytics_receipts=expected,
                  external_delivery_verified=False,
                  gateway_unchanged_during_worker_recovery=True)
    write_json(stack.directory / 'analytics-isolation.json', result)
    return result


def nats_request(stack, subject, payload):
    """Request/reply only against this runner's fresh loopback NATS provider."""
    data = json.dumps(payload).encode()
    inbox = '_INBOX.' + uuid.uuid4().hex
    with socket.create_connection(('127.0.0.1', int(stack.port('nats', 4222))), timeout=5) as connection:
        with connection.makefile('rb') as stream:
            check(stream.readline().startswith(b'INFO '), 'Missing NATS greeting')
            connection.sendall(b'CONNECT {"verbose":false}\r\n' +
                f'SUB {inbox} 1\r\nPUB {subject} {inbox} {len(data)}\r\n'.encode() + data + b'\r\n')
            while True:
                line = stream.readline()
                if line == b'PING\r\n':
                    connection.sendall(b'PONG\r\n')
                elif line.startswith(b'MSG '):
                    size = int(line.split()[-1])
                    check(0 <= size <= 1048576, 'Unexpected NATS reply size')
                    reply = json.loads(stream.read(size))
                    check(stream.read(2) == b'\r\n' and 'error' not in reply, 'NATS request failed')
                    return reply
                else:
                    check(bool(line) and not line.startswith(b'-ERR'), 'NATS request disconnected or rejected')


def async_faults(stack, users):
    print('Stopping NATS; verifying committed orders survive publisher restart.', flush=True)
    stack.compose('stop', '-t', '3', 'nats')
    stage = run_stage(stack, users, min(2, len(users)), 2, 'broker-down')
    check(stage['passed'], 'Broker outage affected purchases')
    pending = int(stack.sql("SELECT count(*) FROM platform.outbox WHERE published_at IS NULL"))
    check(pending > 0, 'Broker outage did not leave a durable backlog')
    stack.stop_api(kill=True)
    stack.start_api()
    check(int(stack.sql("SELECT count(*) FROM platform.outbox WHERE published_at IS NULL")) >= pending,
          'Publisher restart lost committed backlog')
    restarted_stage = run_stage(stack, users, min(2, len(users)), 1, 'publisher-restarted-broker-down')
    check(restarted_stage['passed'], 'Restarted gateway could not purchase with broker down')
    stack.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'nats')
    expected = int(stack.sql('SELECT count(*) FROM orders.orders'))
    def recovered():
        return (int(stack.sql("SELECT count(*) FROM platform.outbox WHERE published_at IS NULL")) == 0
            and int(stack.sql(f"SELECT count(*) FROM platform.consumer_receipts WHERE consumer_name='{ORDER_ANALYTICS_RECEIPT}'")) == expected
            and confirmations_complete(confirmation_state(stack, expected))
            and int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL')) == expected)
    wait_until(recovered, 180)
    wait_until(stack.analytics_ready)
    # Bypass the publisher's Nats-Msg-Id window to prove durable consumer dedup,
    # rather than merely observing JetStream discard a repeated publication.
    event = json.loads(stack.sql("SELECT json_build_object('id',id,'event_type',event_type,'schema_version',1,'payload',payload) FROM platform.outbox WHERE event_type='order.placed' ORDER BY created_at DESC LIMIT 1"))
    order_id = str(uuid.UUID(event['payload']['order_id']))
    physical_query = f"SELECT count() FROM commerce_analytics.order_facts WHERE order_id='{order_id}'"
    physical = stack.ch(physical_query)
    ack = nats_request(stack, 'commerce.order.placed', event)
    sequence = ack['seq']
    for consumer in ORDER_CONSUMERS:
        info_subject = f'$JS.API.CONSUMER.INFO.COMMERCE_EVENTS.{consumer}'
        wait_until(lambda: nats_request(stack, info_subject, {})['ack_floor']['stream_seq'] >= sequence, 90)
    check(recovered(), 'Duplicate delivery changed logical orders, facts, receipts or notification jobs')
    check(stack.ch(physical_query) == physical == '1', 'Duplicate delivery inserted a second physical order fact')
    result = {'passed': True, 'stage': stage, 'after_restart_stage': restarted_stage, 'backlog_during_outage': pending,
              'recovered_orders': expected, 'consumer_duplicate_acknowledged': True,
              'duplicate_acknowledged_consumers': list(ORDER_CONSUMERS),
              'one_confirmation_per_queued_order': True, 'external_delivery_verified': False,
              'unpublished_after_recovery': 0, **confirmation_state(stack, expected)}
    write_json(stack.directory / 'async-recovery.json', result)
    return result


def concurrency_levels(raw):
    try:
        levels = [int(value) for value in raw.split(',')]
    except ValueError as error:
        raise argparse.ArgumentTypeError('Use comma-separated integers') from error
    if not levels or len(levels) > 6 or levels != sorted(set(levels)) or not all(1 <= n <= 16 for n in levels):
        raise argparse.ArgumentTypeError('Use up to six increasing unique levels between 1 and 16')
    return levels


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('debug', 'release'), default='debug')
    parser.add_argument('--concurrency', type=concurrency_levels, default=[1, 4, 8])
    parser.add_argument('--iterations', type=int, default=5)
    parser.add_argument('--analytics-faults', action='store_true',
                        help='Kill/restart analytics and interrupt ClickHouse on the isolated stack')
    parser.add_argument('--async-faults', action='store_true', help='Interrupt the isolated broker, restart the publisher and replay a consumed order')
    parser.add_argument('--sql-profile', action='store_true', help='Collect private per-stage pg_stat_statements on the isolated provider')
    parser.add_argument('--candidate-bundle', type=Path, help='Verify a packaged native release without rebuilding')
    parser.add_argument('--candidate-image', type=Path, help='Verify an immutable release image on isolated providers')
    parser.add_argument('--output', type=Path, help='New private evidence directory; must not already exist')
    args = parser.parse_args(argv)
    if args.candidate_bundle and args.candidate_image:
        parser.error('Choose a native bundle or a container image')
    image = None
    if args.candidate_image:
        from commerce_image import ImageStack, load_image
        image = load_image(args.candidate_image)
        check(args.profile == 'release', 'Image verification requires release profile')
    bundle = None
    if args.candidate_bundle:
        from commerce_release import load_bundle
        bundle = load_bundle(args.candidate_bundle)
        check(bundle['profile'] == args.profile, 'Bundle profile mismatch')
        args.candidate_bundle = args.candidate_bundle.resolve()
    if not 1 <= args.iterations <= 100:
        parser.error('--iterations must be between 1 and 100')
    if os.environ.get('PYTHONOPTIMIZE') or not __debug__:
        parser.error('Assertions must remain enabled for the reused HTTP acceptance suite')
    directory = (args.output.resolve() if args.output else
                 ROOT / '.local' / 'commerce-reliability' / uuid.uuid4().hex)
    directory.mkdir(parents=True, mode=0o700)
    directory.chmod(0o700)
    report = {'schema_version': 1, 'status': 'running', 'started_unix': time.time(),
        'profile': args.profile, 'workload': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}, 'stages': [],
        'scope': 'Synthetic native gateway and isolated Docker providers; no AI, frontend, ingress or production capacity claim',
        'host': {'system': platform.system(), 'release': platform.release(), 'architecture': platform.machine(),
                 'logical_cpus': os.cpu_count(), 'python': platform.python_version()},
        'performance_targets': 'Uncalibrated; observations only. Correctness and scenario completion are required.'}
    stack = None
    phase = 'build'
    try:
        if image:
            manifest = json.loads((args.candidate_image / 'image-source-manifest.json').read_text())
            write_json(directory / 'source-manifest.json', manifest)
            report.update(source_sha256=image['source_sha256'], git_revision=image['git_revision'],
                          binaries=image['binaries'], release_image=image,
                          scope='Release container image with disposable providers; no frontend, ingress, AI or external delivery')
            verifier_manifest = source_manifest()
            report['verifier_source_sha256'] = verifier_manifest['sha256']
            write_json(directory / 'verifier-source-manifest.json', verifier_manifest)
        elif bundle:
            manifest = json.loads((args.candidate_bundle / 'source-manifest.json').read_text())
            write_json(directory / 'source-manifest.json', manifest)
            report.update(source_sha256=bundle['source_sha256'], git_revision=bundle['git_revision'],
                          binaries=bundle['binaries'], release=bundle)
            verifier_manifest = source_manifest()
            report['verifier_source_sha256'] = verifier_manifest['sha256']
            write_json(directory / 'verifier-source-manifest.json', verifier_manifest)
        else:
            manifest = source_manifest()
            write_json(directory / 'source-manifest.json', manifest)
            report['source_sha256'] = manifest['sha256']
            report['git_revision'] = command(['git', 'rev-parse', 'HEAD']).decode().strip()
            build = ['cargo', '+1.94.0', 'build', '--manifest-path', str(ROOT / 'commerce-api/rocento-api/Cargo.toml'),
                     '--locked', '-p', 'api-gateway', '--bin', 'api-gateway', '--bin', 'seed-admin', '--bin', 'sync-reports', '--bin', 'analytics-worker']
            if args.profile == 'release':
                build.append('--release')
            report['build_command'] = build
            print(f'Building {args.profile} candidate; evidence: {directory}', flush=True)
            with (directory / 'build.log').open('wb') as output:
                result = subprocess.run(build, cwd=ROOT, env=host_environment(), stdout=output,
                                        stderr=subprocess.STDOUT, timeout=1800)
            check(result.returncode == 0, 'Build failed; inspect private build.log')
            report['binaries'] = {name: hashlib.sha256((ROOT / 'commerce-api/rocento-api/target' / args.profile / name).read_bytes()).hexdigest()
                                  for name in ('api-gateway', 'seed-admin', 'sync-reports', 'analytics-worker')}
        phase = 'provider-startup'
        stack = ImageStack(directory, args.profile, image['image_id']) if image else BaselineStack(directory, args.profile)
        stack.binary_directory = args.candidate_bundle
        stack.sql_profiling = args.sql_profile
        report['sql_profiling'] = args.sql_profile
        stack.start()
        if bundle or image:
            stack.start_engagement()
            report['engagement_startup'] = 'passed'
            migration_query = 'SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations WHERE success'
            report['applied_migrations'] = {
                'commerce': json.loads(stack.sql(migration_query)),
                'engagement': json.loads(stack.sql(migration_query, service='engagement-postgres', database='engagement'))}
        if image:
            stack.start_export()
            report['export_health_faults'] = stack.verify_export_faults()
        report['project'] = stack.project
        report['providers'] = {name: {'image': service['image'], 'cpus': service['cpus'],
                                      'memory': service['mem_limit']}
                               for name, service in stack.spec['services'].items()}
        report['docker_resources'] = command(['docker', 'info', '--format', '{{.NCPU}} CPUs; {{.MemTotal}} bytes']).decode().strip()
        report['docker_engine'] = command(['docker', 'info', '--format', '{{.ServerVersion}}']).decode().strip()
        report['provider_image_ids'] = json.loads(stack.compose('images', '--format', 'json'))
        phase = 'existing-http-acceptance'
        print('Running existing HTTP acceptance: identity, stock contention, checkout replay.', flush=True)
        qa = load_qa()
        fixture_password = uuid.uuid4().hex + '!'
        qa.exercise(stack, password=fixture_password, seed_admin=stack.binary('seed-admin'))
        report['http_acceptance'] = 'passed'
        phase = 'fixture-setup'
        users = fixtures(stack, max(args.concurrency), qa, fixture_password)
        if args.analytics_faults or args.async_faults:
            report['notification_queue_acceptance'] = enable_queued_order_confirmations(stack)
        report['dataset'] = json.loads(stack.sql("""SELECT json_build_object(
            'customers',(SELECT count(*) FROM customers.customers),
            'products',(SELECT count(*) FROM catalog.products),
            'source_items',(SELECT count(*) FROM inventory.source_items),
            'initial_orders',(SELECT count(*) FROM orders.orders))"""))
        # Exclude the automatic first reporting refresh from nominal measurements.
        wait_until(lambda: any(line.startswith('commerce_reporting_last_success_seconds ') and float(line.split()[-1]) > 0
                              for line in stack.analytics_metrics('warmup').splitlines()))
        for concurrency in args.concurrency:
            phase = f'concurrency-{concurrency}'
            print(f'Measuring {concurrency} concurrent shoppers, {args.iterations} purchases each.', flush=True)
            stage = run_stage(stack, users, concurrency, args.iterations, phase)
            report['stages'].append(stage)
            write_json(directory / 'report.json', report)
            check(stage['passed'], f'{phase} failed; inspect report.json')
        phase = 'reporting-interference'
        print('Measuring checkout while reporting refreshes run.', flush=True)
        stage = reporting_stage(stack, users, max(args.concurrency), args.iterations)
        report['stages'].append(stage)
        check(stage['passed'], 'Reporting interference scenario failed')
        if args.analytics_faults:
            phase = 'analytics-faults'
            report['analytics_isolation'] = analytics_faults(stack, users, fixture_password)
        if args.async_faults:
            phase = 'async-faults'
            report['async_recovery'] = async_faults(stack, users)
        phase = 'telemetry-verification'
        expected_metrics = ('commerce_db_pool_acquire_seconds_count',
            'commerce_inventory_lock_wait_seconds_count', 'commerce_inventory_transaction_seconds_count',
            'commerce_cart_snapshot_seconds_count', 'commerce_queue_pending')
        metrics = stack.metrics('final')
        report['telemetry'] = {name: any(line.startswith(name) for line in metrics.splitlines())
                               for name in expected_metrics}
        report['telemetry']['queue_sample_success'] = 'commerce_reliability_sample_success 1\n' in metrics
        report['telemetry']['analytics_ready'] = 'commerce_analytics_worker_ready 1\n' in stack.analytics_metrics('final')
        check(all(report['telemetry'].values()), 'Baseline telemetry incomplete or queue collection unavailable')
        phase = 'candidate-verification'
        if bundle or image:
            check(stack.engagement_ready(), 'Engagement worker is not healthy')
            report['engagement_final'] = 'passed'
            if image:
                check(stack.export_ready(), 'Export worker is not healthy')
                report['export_final'] = 'passed'
                check(load_image(args.candidate_image) == image, 'Image manifest changed during verification')
            else:
                check(load_bundle(args.candidate_bundle) == bundle, 'Bundle changed during verification')
            check(source_manifest() == verifier_manifest, 'Verifier source changed during run')
        else:
            check(source_manifest()['sha256'] == manifest['sha256'], 'Source changed during run; rerun the baseline')
        if not image:
            check(all(hashlib.sha256(stack.binary(name).read_bytes()).hexdigest() == digest
                      for name, digest in report['binaries'].items()), 'Binaries changed during run; rerun the baseline')
        report['status'] = 'passed'
    except Exception as error:
        (directory / 'failure.log').write_text(traceback.format_exc())
        report.update(status='failed', failure_phase=phase, failure_type=type(error).__name__)
        print(f'Baseline failed during {phase}; inspect evidence in {directory}', flush=True)
    finally:
        if stack is not None:
            try:
                stack.close()
                report['cleanup'] = 'owned containers and volumes removed'
            except Exception as error:
                report.update(status='failed', cleanup='failed', cleanup_error=type(error).__name__)
        report['ended_unix'] = time.time()
        write_json(directory / 'report.json', report)
    print(f"{report['status'].upper()}: {directory / 'report.json'}", flush=True)
    return 0 if report['status'] == 'passed' else 1
