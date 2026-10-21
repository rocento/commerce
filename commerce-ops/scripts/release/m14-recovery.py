"""Run checkout matrix plus verified physical/WAL restore and fenced standby promotion.
Uses the actual opt-in durability deployment scripts on isolated synthetic data.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import copy
import json
import os
import time
import uuid
from m14_support import ROOT, Stack, run, wait_for
from m14_checkout import exercise


class RecoveryStack(Stack):
    def __init__(self):
        super().__init__()
        env = dict(os.environ, REPLICATION_PASSWORD=uuid.uuid4().hex)
        resolved = json.loads(run(['docker', 'compose', '-f', 'commerce-ops/compose/compose.yaml', '-f', 'commerce-ops/compose/compose.durability.yaml',
                                  'config', '--format', 'json'], cwd=ROOT, env=env))
        for name in ('postgres', 'postgres-standby', 'postgres-sync', 'postgres-backup'):
            service = copy.deepcopy(resolved['services'][name])
            service.pop('networks', None)
            service.pop('container_name', None)
            service['restart'] = 'no'
            if name == 'postgres':
                service['ports'] = self.spec['services']['postgres']['ports']
            elif name == 'postgres-standby':
                service['ports'] = [{'target': 5432, 'host_ip': '127.0.0.1', 'published': str(self.free_port())}]
            for volume in service.get('volumes', []):
                if volume['type'] == 'volume':
                    self.spec['volumes'][volume['source']] = {}
            self.spec['services'][name] = service


def main():
    stack = RecoveryStack()
    try:
        stack.start()
        assert stack.sql("SELECT count(*) FROM pg_stat_replication WHERE sync_state='sync' AND application_name='m14_standby'") == '1'
        # Pausing standby proves commits wait for remote flush instead of silently degrading.
        stack.sql('CREATE TABLE public.m14_sync_probe(id integer PRIMARY KEY)')
        stack.compose('pause', 'postgres-standby')
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(stack.sql, 'INSERT INTO public.m14_sync_probe VALUES (1)')
            try:
                wait_for(lambda: stack.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='SyncRep'") != '0', 15)
                assert not pending.done(), 'Write was acknowledged without standby'
            finally:
                stack.compose('unpause', 'postgres-standby')
            pending.result(timeout=30)
        print('PASS synchronous partition: acknowledgement blocked until standby resumed', flush=True)

        context = exercise(stack)
        # Take a physical backup, then write another real order that only WAL can recover.
        result = stack.compose('exec', '-T', 'postgres-backup', 'sh', '/opt/durability/backup.sh').decode()
        backup_id = result.strip().split('Verified base backup: ')[-1]
        assert '/' not in backup_id and '\n' not in backup_id
        stack.start_api()
        final_order = context['customer'].call('POST', '/v1/customer/checkout/place', context['review']())
        expected = context['orders'] + 1
        wait_for(lambda: int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL')) == expected)
        stack.stop_api()
        target = 'm14_' + uuid.uuid4().hex
        stack.sql(f"SELECT pg_create_restore_point('{target}')")
        segment = stack.sql('SELECT pg_walfile_name(pg_current_wal_lsn())')
        stack.sql('SELECT pg_switch_wal()')
        wait_for(lambda: stack.compose('exec', '-T', 'postgres', 'test', '-s', '/archive/' + segment) == b'')
        restore = {
            'image': 'postgres:16-bookworm', 'restart': 'no',
            'entrypoint': ['sh', '/opt/durability/restore.sh'],
            'environment': {'PGDATA': '/var/lib/postgresql/data', 'BACKUP_ID': backup_id, 'RECOVERY_TARGET_NAME': target,
                            'POSTGRES_USER': stack.spec['services']['postgres']['environment']['POSTGRES_USER'],
                            'POSTGRES_DB': stack.spec['services']['postgres']['environment']['POSTGRES_DB']},
            'volumes': [
                {'type': 'volume', 'source': 'postgres-restored-data', 'target': '/var/lib/postgresql/data'},
                {'type': 'volume', 'source': 'postgres-backups', 'target': '/backups', 'read_only': True},
                {'type': 'volume', 'source': 'postgres-archive', 'target': '/archive', 'read_only': True},
                {'type': 'bind', 'source': str(ROOT / 'commerce-ops/deploy/durability'), 'target': '/opt/durability', 'read_only': True}],
        }
        stack.spec['services']['postgres-restore'] = restore
        stack.spec['volumes']['postgres-restored-data'] = {}
        stack.save()
        stack.compose('up', '-d', 'postgres-restore')
        wait_for(lambda: stack.sql('SELECT pg_is_in_recovery()', 'postgres-restore') == 'f')
        for table in ('orders.orders', 'orders.order_items', 'payments.payment_transactions', 'inventory.order_allocations', 'platform.outbox'):
            query = f"SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text),'')) FROM {table} t"
            assert stack.sql(query) == stack.sql(query, 'postgres-restore'), table
        assert int(stack.sql('SELECT count(*) FROM orders.orders', 'postgres-restore')) == expected
        assert int(stack.ch('SELECT count() FROM commerce_analytics.order_facts FINAL')) == expected
        assert stack.sql(f"SELECT count(*) FROM orders.orders WHERE id='{final_order['order']['id']}'", 'postgres-restore') == '1'
        print(f'PASS DUR-08 physical/PITR: verified base backup + archived WAL restored {expected} orders, including post-backup order, exact hashes and matching facts', flush=True)

        # Fence before promotion: kill, disable automatic restart, disconnect all networks.
        primary_id = stack.compose('ps', '-q', 'postgres').decode().strip()
        primary = json.loads(run(['docker', 'inspect', primary_id]))[0]
        assert primary['HostConfig']['RestartPolicy']['Name'] == 'no'
        started = time.monotonic()
        stack.compose('kill', '-s', 'SIGKILL', 'postgres')
        for network in primary['NetworkSettings']['Networks']:
            run(['docker', 'network', 'disconnect', '-f', network, primary_id])
        fenced = json.loads(run(['docker', 'inspect', primary_id]))[0]
        assert not fenced['State']['Running'] and not fenced['NetworkSettings']['Networks']
        assert stack.sql('SELECT pg_promote(true, 30)', 'postgres-standby') == 't'
        assert stack.sql('SELECT pg_is_in_recovery()', 'postgres-standby') == 'f'
        assert int(stack.sql('SELECT count(*) FROM orders.orders', 'postgres-standby')) == expected
        stack.sql('INSERT INTO public.m14_sync_probe VALUES (2)', 'postgres-standby')
        database_rto = time.monotonic() - started
        assert database_rto < 60, database_rto
        # Route the real API to the promoted standby and prove an HTTP checkout succeeds.
        from urllib.parse import urlsplit, urlunsplit
        url = urlsplit(stack.env['DATABASE_URL'])
        credentials = url.netloc.rsplit('@', 1)[0]
        stack.env['DATABASE_URL'] = urlunsplit((url.scheme, credentials + '@127.0.0.1:' + stack.port('postgres-standby', 5432), url.path, '', ''))
        stack.start_api()
        context['customer'].call('POST', '/v1/customer/checkout/place', context['review']())
        api_rto = time.monotonic() - started
        assert api_rto < 90, api_rto
        assert int(stack.sql('SELECT count(*) FROM orders.orders', 'postgres-standby')) == expected + 1
        print(f'PASS DUR-09: primary fenced, zero acknowledged orders lost; database write RTO {database_rto:.2f}s (<60s), HTTP checkout RTO {api_rto:.2f}s (<90s)', flush=True)
        (stack.directory / 'recovery-result.json').write_text(json.dumps({
            'backup_id': backup_id, 'restore_point': target, 'restored_orders': expected,
            'database_rto_seconds': database_rto, 'http_rto_seconds': api_rto}, indent=2))
    finally:
        stack.close()


if __name__ == '__main__':
    main()
