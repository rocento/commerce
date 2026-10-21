"""DUR-02/04–08: real checkout fault/replay/restore drill on isolated providers.

Build first: cargo build --manifest-path commerce-api/rocento-api/Cargo.toml -p api-gateway
  --bin api-gateway --bin seed-admin --offline
All identities, data and notifications are synthetic; no development services are changed.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import concurrent.futures
import http.client
import http.server
import json
import socket
import threading
import uuid
from m14_support import Client, ROOT, Stack, run, wait_for


def nats_request(stack, subject, payload):
    """Minimal request/reply protocol; publishing without Nats-Msg-Id forces real replay."""
    data = json.dumps(payload).encode()
    inbox = '_INBOX.' + uuid.uuid4().hex
    with socket.create_connection(('127.0.0.1', int(stack.port('nats', 4222))), timeout=10) as sock:
        stream = sock.makefile('rb')
        assert stream.readline().startswith(b'INFO ')
        sock.sendall((f'CONNECT {{"verbose":false}}\r\nSUB {inbox} 1\r\nPUB {subject} {inbox} {len(data)}\r\n').encode() + data + b'\r\n')
        while True:
            line = stream.readline()
            if line.startswith(b'MSG '):
                result = json.loads(stream.read(int(line.split()[-1])))
                if 'error' in result:
                    raise RuntimeError(str(result['error']))
                return result
            if line == b'PING\r\n':
                sock.sendall(b'PONG\r\n')
            if not line or line.startswith(b'-ERR'):
                raise RuntimeError(f'NATS request failed: {line!r}')


def snapshot(stack):
    tables = ['orders.orders', 'orders.order_items', 'payments.payment_transactions',
              'orders.order_status_history', 'inventory.order_allocations',
              'inventory.source_items', 'inventory.reservations', 'inventory.reservation_allocations',
              'cart_checkout.items', 'fulfillment.shipments', 'fulfillment.shipment_items']
    result = {table: json.loads(stack.sql(
        f"SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t")) for table in tables}
    result['placed_events'] = json.loads(stack.sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'payload',payload) ORDER BY id),'[]') FROM platform.outbox WHERE event_type='order.placed'"))
    return result


def lost_response(customer, body):
    observed = {}

    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            observed['body'] = customer.call('POST', self.path, request)
            # Simulate a proxy failure after the upstream committed, before forwarding success.
            self.close_connection = True

        def log_message(self, *args):
            pass

    with http.server.HTTPServer(('127.0.0.1', 0), Proxy) as server:
        worker = threading.Thread(target=server.handle_request)
        worker.start()
        try:
            Client(f'http://127.0.0.1:{server.server_port}').call('POST', '/v1/customer/checkout/place', body)
        except http.client.RemoteDisconnected:
            pass
        else:
            raise AssertionError('Proxy unexpectedly delivered a response')
        finally:
            worker.join(timeout=160)
    assert 'body' in observed
    retry = customer.call('POST', '/v1/customer/checkout/place', body)
    assert retry == observed['body'], 'Idempotent retry changed the response'
    return retry


def exercise(stack):
    password = uuid.uuid4().hex + '!'
    env = dict(stack.env, BOOTSTRAP_ADMIN_PASSWORD=password)
    run([str(ROOT / 'commerce-api/rocento-api/target/debug/seed-admin'), '--email', 'm14-admin@example.test'], env=env)
    admin = Client(stack.url)
    admin.call('POST', '/v1/admin/auth/login', {'email': 'm14-admin@example.test', 'password': password})
    customer = Client(stack.url)
    credentials = {'identifier': 'm14@example.test', 'password': password}
    customer.call('POST', '/v1/customer/auth/register', credentials)
    stack.sql("UPDATE customers.customers SET verified=true WHERE email='m14@example.test'")
    customer.token = customer.call('POST', '/v1/customer/auth/login', credentials)['access_token']
    location = customer.call('POST', '/v1/customer/locations',
                             {'label': 'home', 'latitude': 30, 'longitude': 31, 'formatted_address': 'M14 synthetic address'})
    category = admin.call('POST', '/v1/admin/catalog/categories', {'name': 'M14', 'slug': 'm14', 'parent_id': None})
    product = admin.call('POST', '/v1/admin/catalog/products', {'sku': 'M14', 'name': 'M14 fixture', 'slug': 'm14',
         'description': 'Synthetic durability fixture', 'price': '1.20', 'currency': 'USD', 'unit': 'lb',
         'category_id': category['id'], 'attributes': {}, 'media_ids': [], 'active': True, 'in_stock': True})
    admin.call('PUT', '/v1/admin/inventory/' + product['id'], {'on_hand': 30, 'reason': 'M14 isolated stock'})

    def review():
        customer.call('POST', '/v1/cart')
        customer.call('POST', '/v1/cart/items', {'product_id': product['id'], 'quantity': 2})
        quote = customer.call('POST', '/v1/customer/checkout/quote', {'location_id': location['id']})
        return {'quote_id': quote['id'], 'idempotency_key': str(uuid.uuid4())}

    original = customer.call('POST', '/v1/customer/checkout/place', review())
    assert original['items'] and original['payment']
    for scenario in ('DUR-02', 'DUR-04'):
        body = review()
        before = snapshot(stack)
        stack.sql("""CREATE OR REPLACE FUNCTION platform.m14_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.event_type='order.placed' THEN
            PERFORM pg_sleep(10); END IF; RETURN NEW; END $$;
          CREATE TRIGGER m14_barrier BEFORE INSERT ON platform.outbox FOR EACH ROW EXECUTE FUNCTION platform.m14_barrier();""")
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            request = executor.submit(customer.call, 'POST', '/v1/customer/checkout/place', body)
            wait_for(lambda: stack.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO platform.outbox%'") == '1', 20)
            if scenario == 'DUR-02':
                stack.compose('restart', 'postgres')
                stack.compose('up', '-d', '--wait', '--wait-timeout', '90', 'postgres')
            else:
                stack.stop_api(kill=True)
            try:
                request.result(timeout=20)
            except (OSError, http.client.HTTPException):
                pass
            else:
                raise AssertionError('Interrupted checkout unexpectedly returned success')
        wait_for(lambda: stack.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep'") == '0')
        stack.sql('DROP TRIGGER m14_barrier ON platform.outbox; DROP FUNCTION platform.m14_barrier()')
        assert snapshot(stack) == before, f'{scenario}: partial checkout or prior data changed'
        if scenario == 'DUR-04':
            stack.start_api()
        restored = customer.call('POST', '/v1/customer/checkout/place', body)
        assert restored['order']['id'] != original['order']['id']
        assert customer.call('POST', '/v1/customer/checkout/place', body) == restored
        print(f'PASS {scenario}: real checkout interrupted at outbox barrier; all business state rolled back; retry creates exactly one full order', flush=True)

    # A bounded test delay gives SIGTERM a real in-flight transaction to drain.
    body = review()
    stack.sql("""CREATE FUNCTION platform.m14_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='order.placed' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$;
      CREATE TRIGGER m14_barrier BEFORE INSERT ON platform.outbox FOR EACH ROW EXECUTE FUNCTION platform.m14_barrier();""")
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        request = executor.submit(customer.call, 'POST', '/v1/customer/checkout/place', body)
        wait_for(lambda: stack.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO platform.outbox%'") == '1', 10)
        stack.stop_api()
        drained = request.result(timeout=10)
        assert stack.api.returncode == 0
    stack.sql('DROP TRIGGER m14_barrier ON platform.outbox; DROP FUNCTION platform.m14_barrier()')
    stack.start_api()
    assert customer.call('POST', '/v1/customer/checkout/place', body) == drained
    print('PASS M14-SIGNAL: SIGTERM drained a real checkout, closed workers and exited 0; retry preserved its order', flush=True)

    # Commit while the publisher cannot reach NATS; kill its owning API process.
    body = review()
    stack.compose('stop', 'nats')
    order = customer.call('POST', '/v1/customer/checkout/place', body)
    oid = order['order']['id']
    assert stack.sql(f"SELECT count(*) FROM platform.outbox WHERE event_type='order.placed' AND payload->>'order_id'='{oid}' AND published_at IS NULL") == '1'
    stack.stop_api(kill=True)
    stack.compose('start', 'nats')
    stack.start_api()
    assert customer.call('POST', '/v1/customer/checkout/place', body) == order
    wait_for(lambda: stack.sql(f"SELECT count(*) FROM platform.outbox WHERE payload->>'order_id'='{oid}' AND published_at IS NOT NULL") == '1')
    wait_for(lambda: stack.ch(f"SELECT count() FROM commerce_analytics.order_facts FINAL WHERE order_id='{oid}'") == '1')
    print('PASS DUR-05: committed outbox event delivered after publisher process kill/restart', flush=True)

    # Force a second JetStream message with the same event ID, bypassing publisher dedup.
    envelope = json.loads(stack.sql(f"SELECT jsonb_build_object('id',id,'event_type',event_type,'schema_version',1,'payload',payload) FROM platform.outbox WHERE payload->>'order_id'='{oid}' AND event_type='order.placed'"))
    event_id = envelope['id']
    consumers = {'order-facts-v1': 'order-analytics-v2',
                 'order-notifications-v1': 'order-notifications-v1'}
    for receipt in consumers.values():
        wait_for(lambda: stack.sql(f"SELECT count(*) FROM platform.consumer_receipts WHERE event_id='{event_id}' AND consumer_name='{receipt}'") == '1')
    physical = stack.ch(f"SELECT count() FROM commerce_analytics.order_facts WHERE order_id='{oid}'")
    sequence = nats_request(stack, 'commerce.order.placed', envelope)['seq']
    for consumer, receipt in consumers.items():
        info_subject = f'$JS.API.CONSUMER.INFO.COMMERCE_EVENTS.{consumer}'
        wait_for(lambda: nats_request(stack, info_subject, {})['ack_floor']['stream_seq'] >= sequence)
        assert stack.sql(f"SELECT count(*) FROM platform.consumer_receipts WHERE event_id='{event_id}' AND consumer_name='{receipt}'") == '1'
    assert stack.ch(f"SELECT count() FROM commerce_analytics.order_facts WHERE order_id='{oid}'") == physical == '1'
    print('PASS DUR-06: both consumers acknowledged replay with one receipt each and no second physical fact', flush=True)

    lost = lost_response(customer, review())
    assert stack.sql(f"SELECT count(*) FROM orders.orders WHERE idempotency_key='{lost['order']['idempotency_key']}'") == '1'
    print('PASS DUR-07: proxy discarded committed response; retry returned identical body and one order', flush=True)

    expected = int(stack.sql('SELECT count(*) FROM orders.orders'))
    wait_for(lambda: int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL')) == expected)
    stack.stop_api()
    backup = stack.compose('exec', '-T', 'postgres', 'sh', '-c', 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"')
    backup_path = stack.directory / 'commerce.dump'
    backup_path.write_bytes(backup)
    backup_path.chmod(0o600)
    stack.sql('CREATE DATABASE m14_restore')
    run(stack.base + ['exec', '-T', 'postgres', 'sh', '-c',
        'exec pg_restore --exit-on-error -U "$POSTGRES_USER" -d m14_restore'], input=backup)
    assert int(stack.sql('SELECT count(*) FROM orders.orders', database='m14_restore')) == expected
    for table in ('orders.orders', 'orders.order_items', 'payments.payment_transactions', 'inventory.order_allocations', 'platform.outbox'):
        query = f"SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text),'')) FROM {table} t"
        assert stack.sql(query) == stack.sql(query, database='m14_restore'), table
    assert int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL')) == expected
    print(f'PASS DUR-08 logical drill: restored {expected} orders with exact business/outbox hashes and matching ClickHouse facts', flush=True)
    return {'customer': customer, 'review': review, 'orders': expected}


def main():
    stack = Stack()
    try:
        stack.start()
        exercise(stack)
    finally:
        stack.close()


if __name__ == '__main__':
    main()
