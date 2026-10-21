"""Failure reporting and isolation protections for the synthetic baseline."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import commerce_reliability as baseline


class FaultStack:
    """Model dependency state so acceptance must inspect effects before recovery."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.url = 'http://127.0.0.1:1'
        self.api = Mock(pid=1)
        self.api.poll.return_value = None
        self.env = {'NOTIFICATION_MODE': 'console'}
        self.worker_running = self.clickhouse_running = self.nats_running = True
        self.orders = 2
        self.console_order_events = ['00000000-0000-0000-0000-000000000001',
                                     '00000000-0000-0000-0000-000000000002']
        self.observed_confirmations = []
        self.restored_clickhouse = False
        self.blocked_during = None
        self.missing_job = False
        self.replayed = False
        self.duplicate_physical_fact = False
        self.blocked_ack = None
        self.acknowledged = []

    def sql(self, query):
        if query == 'SELECT count(*) FROM orders.orders':
            return str(self.orders)
        if query.startswith('SELECT COALESCE(json_agg(id)'):
            return json.dumps(self.console_order_events)
        if query.startswith('SELECT json_build_object('):
            return json.dumps({'id': '00000000-0000-0000-0000-000000000003',
                               'payload': {'order_id': '00000000-0000-0000-0000-000000000004'}})
        if 'platform.outbox WHERE published_at IS NULL' in query:
            return '0' if self.nats_running else str(self.orders)
        if 'platform.consumer_receipts' in query:
            if baseline.ORDER_NOTIFICATION_RECEIPT in query:
                unavailable = ((self.blocked_during == 'worker' and not self.worker_running)
                               or (self.blocked_during == 'clickhouse' and not self.clickhouse_running))
                return str(self.orders - int(unavailable))
            if baseline.ORDER_ANALYTICS_RECEIPT in query:
                return str(self.orders)
        if "platform.notification_jobs WHERE purpose='order'" in query:
            return str(self.orders - len(self.console_order_events))
        if query.startswith('SELECT count(*) FROM platform.outbox event'):
            for event in self.console_order_events:
                assert event in query, 'Only the exact drained console events may be excluded'
            assert 'job.id=event.id' in query, 'Counts alone can mask a missing order confirmation'
            self.observed_confirmations.append((self.worker_running, self.clickhouse_running, self.orders))
            return str(int(self.missing_job))
        raise AssertionError(f'Unexpected SQL: {query}')

    def ch(self, query):
        assert self.clickhouse_running
        if 'FINAL' in query:
            return str(self.orders)
        return '2' if self.replayed and self.duplicate_physical_fact else '1'

    def compose(self, *args):
        service = args[-1]
        running = args[0] != 'stop'
        if service == 'clickhouse':
            self.clickhouse_running = running
            self.restored_clickhouse = running
        elif service == 'nats':
            self.nats_running = running
        else:
            raise AssertionError(args)

    def stop_analytics(self, kill=False):
        self.worker_running = False

    def start_analytics(self, wait=True):
        self.worker_running = True

    def analytics_ready(self):
        return self.worker_running and self.clickhouse_running

    def analytics_metrics(self, name):
        return 'commerce_reporting_last_success_seconds 1'

    def stop_api(self, kill=False):
        pass

    def start_api(self):
        self.api.pid += 1

    def purchase(self, stack, users, concurrency, iterations, name):
        self.orders += concurrency * iterations
        return {'passed': True, 'name': name}

    def admin_call(self, method, path, body=None):
        if '/reports/' not in path:
            return {}
        if not self.clickhouse_running:
            raise urllib.error.HTTPError(self.url, 503, 'unavailable', {'Retry-After': '3'}, None)
        return {'run': 'complete'}

    def nats_request(self, stack, subject, payload):
        if subject == 'commerce.order.placed':
            self.replayed = True
            return {'seq': 42}
        consumer = subject.removeprefix('$JS.API.CONSUMER.INFO.COMMERCE_EVENTS.')
        assert self.replayed
        self.acknowledged.append(consumer)
        return {'ack_floor': {'stream_seq': 41 if consumer == self.blocked_ack else 42}}


def check_wait(predicate, seconds=90):
    if not predicate():
        raise RuntimeError('test wait timed out')


class ReliabilityTests(unittest.TestCase):
    def test_private_environment_cannot_inherit_application_or_remote_docker_settings(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'secret', 'AUTH_SECRET': 'secret',
             'OTEL_EXPORTER_OTLP_ENDPOINT': 'remote', 'COMPOSE_FILE': 'production.yaml',
             'DOCKER_HOST': 'tcp://remote:2375'}, clear=True):
            self.assertEqual(baseline.host_environment(), {})

    def test_remote_context_is_rejected_before_any_provider_is_created(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(baseline, 'command', return_value=b'ssh://production') as command:
            with self.assertRaisesRegex(RuntimeError, 'local Unix-socket'):
                baseline.BaselineStack(Path(directory), 'debug')
            self.assertEqual(command.call_count, 1)

    def test_failures_are_not_disguised_as_fast_successful_requests(self):
        result = baseline.summarize([
            {'operation': 'checkout_place', 'status': 200, 'seconds': 1.2},
            {'operation': 'checkout_place', 'status': 503, 'seconds': .01},
            {'operation': 'checkout_place', 'status': 0, 'seconds': 35},
        ])['checkout_place']
        self.assertEqual(result['success_p95_seconds'], 1.2)
        self.assertEqual(result['successful_requests'], 1)
        self.assertEqual(result['statuses'], {'200': 1, '503': 1, 'transport_error': 1})
        self.assertEqual(result['all_max_seconds'], 35)
        failed = baseline.summarize([{'operation':'cart_add','status':503,'seconds':.1}])['cart_add']
        self.assertIsNone(failed['success_p99_seconds'])

    def test_http_failure_is_recorded_and_never_retried(self):
        client = baseline.Client('http://127.0.0.1:1')
        samples = []
        with patch.object(client.http, 'open', side_effect=urllib.error.HTTPError(client.url, 503, 'busy', {}, None)) as opened:
            with self.assertRaises(urllib.error.HTTPError):
                baseline.measured_call(client, samples, 'checkout_place', 'POST', '/checkout', {})
            self.assertEqual(opened.call_count, 1)
        self.assertEqual(samples[0]['status'], 503)

    def test_workload_limits_reject_unbounded_or_ambiguous_runs(self):
        for raw in ('', '0', '17', '4,1', '1,1', '1,x', '1,2,3,4,5,6,7'):
            with self.subTest(raw=raw), self.assertRaises(argparse.ArgumentTypeError):
                baseline.concurrency_levels(raw)
        self.assertEqual(baseline.concurrency_levels('1,4,8'), [1,4,8])

    def test_existing_output_directory_is_never_reused(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(baseline, 'command') as command:
            with self.assertRaises(FileExistsError):
                baseline.main(['--output', directory])
            command.assert_not_called()

    def test_invalid_persisted_state_fails_even_when_http_succeeds(self):
        class FakeStack:
            def metrics(self, name):
                pass
        with tempfile.TemporaryDirectory() as directory:
            stack = FakeStack()
            stack.directory = Path(directory)
            before = {'orders': 0, 'invalid_payments': 0}
            after = {'orders': 1, 'invalid_payments': 1}
            responses = [{}, {}, {}, {'id': 'quote'}, {'order': {'id': 'order'}}]
            with patch.object(baseline, 'invariants', side_effect=[before, after]), patch.object(baseline, 'measured_call', side_effect=responses):
                result = baseline.run_stage(stack, [(object(), 'location', 'product')], 1, 1, 'test')
            self.assertFalse(result['passed'])
            self.assertEqual(result['completed_orders'], 1)

    def test_console_orders_are_drained_before_queue_adapter_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            stack = FaultStack(directory)
            with patch.object(baseline, 'wait_until', side_effect=check_wait):
                result = baseline.enable_queued_order_confirmations(stack)
            self.assertEqual(result, {'console_bootstrap_orders': 2, 'external_delivery_verified': False})
            self.assertEqual(stack.env['NOTIFICATION_MODE'], 'mailpit')
            self.assertEqual(stack.env['MAILPIT_URL'], 'http://127.0.0.1:1')
            stack.env['NOTIFICATION_MODE'] = 'console'
            stack.worker_running = False
            stack.blocked_during = 'worker'
            with patch.object(baseline, 'wait_until', side_effect=check_wait), self.assertRaisesRegex(RuntimeError, 'timed out'):
                baseline.enable_queued_order_confirmations(stack)
            self.assertEqual(stack.env['NOTIFICATION_MODE'], 'console')

    def test_confirmations_are_required_during_both_analytics_outages(self):
        with tempfile.TemporaryDirectory() as directory:
            stack = FaultStack(directory)
            admin = Mock()
            admin.call.side_effect = stack.admin_call
            with patch.object(baseline, 'Client', return_value=admin), \
                 patch.object(baseline, 'run_stage', side_effect=stack.purchase), \
                 patch.object(baseline, 'wait_until', side_effect=check_wait):
                result = baseline.analytics_faults(stack, [object()], 'synthetic')
            self.assertTrue(result['passed'])
            self.assertEqual(stack.observed_confirmations[:2], [(False, True, 4), (True, False, 6)])
            self.assertEqual([stage['confirmations_during_outage']['notification_jobs']
                              for stage in result['stages']], [2, 4])
            self.assertEqual(result['analytics_receipts'], 6)
            self.assertEqual(result['notification_receipts'], 6)
            self.assertFalse(result['external_delivery_verified'])

    def test_analytics_recovery_cannot_mask_a_missing_outage_confirmation(self):
        for dependency in ('worker', 'clickhouse', 'job'):
            with self.subTest(dependency=dependency), tempfile.TemporaryDirectory() as directory:
                stack = FaultStack(directory)
                stack.blocked_during = dependency
                stack.missing_job = dependency == 'job'
                admin = Mock()
                admin.call.side_effect = stack.admin_call
                with patch.object(baseline, 'Client', return_value=admin), \
                     patch.object(baseline, 'run_stage', side_effect=stack.purchase), \
                     patch.object(baseline, 'wait_until', side_effect=check_wait), \
                     self.assertRaisesRegex(RuntimeError, 'timed out'):
                    baseline.analytics_faults(stack, [object()], 'synthetic')
                self.assertFalse(stack.restored_clickhouse)
                self.assertFalse((stack.directory / 'analytics-isolation.json').exists())

    def test_duplicate_replay_requires_both_consumers_and_no_physical_duplicate(self):
        for failure in (None, 'duplicate-fact', 'notification-ack'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                stack = FaultStack(directory)
                stack.duplicate_physical_fact = failure == 'duplicate-fact'
                if failure == 'notification-ack':
                    stack.blocked_ack = 'order-notifications-v1'
                with patch.object(baseline, 'run_stage', side_effect=stack.purchase), \
                     patch.object(baseline, 'wait_until', side_effect=check_wait), \
                     patch.object(baseline, 'nats_request', side_effect=stack.nats_request):
                    if failure:
                        message = 'second physical order fact' if failure == 'duplicate-fact' else 'timed out'
                        with self.assertRaisesRegex(RuntimeError, message):
                            baseline.async_faults(stack, [object()])
                        self.assertFalse((stack.directory / 'async-recovery.json').exists())
                    else:
                        result = baseline.async_faults(stack, [object()])
                        self.assertTrue(result['passed'])
                        self.assertEqual(result['duplicate_acknowledged_consumers'], list(baseline.ORDER_CONSUMERS))
                self.assertEqual(stack.acknowledged, list(baseline.ORDER_CONSUMERS))


if __name__ == '__main__':
    unittest.main()
