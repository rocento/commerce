import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid
from types import SimpleNamespace

HOST_DIR = Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/host'
sys.path.insert(0, str(HOST_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/controller'))
import merchant_fleet as fleet
import fleet_providers as providers
import fleet_node as node


class FleetTests(unittest.TestCase):
    def setUp(self):
        for module, name in ((fleet, 'host_directory'), (fleet, 'run'), (providers, 'command'), (providers, 'http')):
            guard = patch.object(module, name, side_effect=AssertionError('Unexpected infrastructure call'))
            guard.start()
            self.addCleanup(guard.stop)
        self.host = {'id': str(uuid.uuid4()), 'provider': 'aws', 'state': 'REQUESTED',
                     'release_digest': 'sha256:' + 'a'*64, 'address': '192.0.2.1',
                     'provider_reference': None}
        self.profile = {'region': 'fixture', 'launchTemplateId': 'lt-fixture',
                        'launchTemplateVersion': '1', 'environment': 'aws-test',
                        'maxHosts': 2, 'minMemoryGiB': 16}
        self.host['profile_digest'] = fleet.profile_digest(self.profile)
        self.cfg = {'terraform': {}, 'providers': {'aws': self.profile}, 'sshPrivateKey': '/fixture/key',
                    'cloudflare': {'zoneId': 'b'*32, 'tokenFile': '/fixture/token'}}

    def test_node_requires_four_cpus_and_nominal_sixteen_gib(self):
        for cpus, gib, error in ((2, 16, 'HOST_CPU_PROFILE_MISMATCH'),
                                 (8, 16, 'HOST_CPU_PROFILE_MISMATCH'),
                                 (4, 8, 'HOST_MEMORY_PROFILE_MISMATCH'),
                                 (4, 32, 'HOST_MEMORY_PROFILE_MISMATCH')):
            with self.subTest(cpus=cpus, gib=gib), patch.object(node.os, 'cpu_count', return_value=cpus), patch.object(Path, 'read_text', return_value=f'MemTotal: {gib * 1024**2} kB\n'):
                merchant = Mock()
                with self.assertRaisesRegex(ValueError, error):
                    node.prepare({}, {'minMemoryGiB': 16}, merchant)
                merchant.command.assert_not_called()
        # Linux reserves some nominal RAM; a 16-GiB VM may report less.
        with patch.object(node.os, 'cpu_count', return_value=4), patch.object(Path, 'read_text', return_value=f'MemTotal: {int(15.5 * 1024**2)} kB\n'):
            merchant = Mock()
            merchant.command.side_effect = RuntimeError('capacity accepted')
            with self.assertRaisesRegex(RuntimeError, 'capacity accepted'):
                node.prepare({}, {'minMemoryGiB': 16}, merchant)
            merchant.command.assert_called_once_with(['docker', 'compose', 'version'])

    def test_discovery_refuses_duplicate_and_replaced_instances(self):
        p = providers.Provider('aws', self.profile, Mock())
        instance = {'InstanceId': 'i-fixture', 'State': {'Name': 'running'}, 'PublicIpAddress': '192.0.2.1', 'Tags':[{'Key':'rocento-host','Value':self.host['id']}]}
        with patch.object(p, 'aws', return_value={'Reservations': [{'Instances': [instance, instance]}]}):
            with self.assertRaisesRegex(ValueError, 'DUPLICATE'):
                p.discover(self.host)
        with patch.object(p, 'aws', return_value={'Reservations': [{'Instances': [instance]}]}):
            with self.assertRaisesRegex(ValueError, 'IDENTITY'):
                p.discover(dict(self.host, provider_reference='i-other'))

    def test_host_budget_changes_do_not_change_machine_identity(self):
        self.assertEqual(fleet.profile_digest(self.profile), fleet.profile_digest(dict(self.profile, maxHosts=9)))
        self.assertNotEqual(fleet.profile_digest(self.profile), fleet.profile_digest(dict(self.profile, launchTemplateVersion='2')))

    def test_expired_ambiguous_create_is_failed_without_recreation(self):
        host = dict(self.host, state='CREATING', expired=True)
        with patch.object(fleet, 'configuration', return_value=self.cfg), patch.object(fleet, 'sql', return_value=json.dumps([host])), patch.object(fleet, 'update_host') as update, patch.object(fleet, 'reconcile_host') as reconcile:
            fleet.reconcile()
            update.assert_called_once_with(host, state='FAILED', error_code='HOST_BOOT_TIMEOUT')
            reconcile.assert_not_called()

    def test_disabled_or_missing_configuration_cannot_provision(self):
        with tempfile.TemporaryDirectory() as root, patch.object(fleet, 'CONFIG', Path(root)):
            with self.assertRaisesRegex(fleet.Waiting, 'FLEET_NOT_CONFIGURED'):
                fleet.configuration()

    def test_create_intent_precedes_external_request(self):
        events = []
        provider = Mock()
        provider.create.side_effect = lambda *args: events.append('create') or {'reference':'i-fixture','operation':None}
        with patch.object(fleet, 'sql', return_value='acme-shop'), patch.object(fleet, 'boot_release'), patch.object(fleet, 'host_directory', return_value=Path('/fixture')), patch.object(fleet, 'Provider', return_value=provider), patch.object(fleet, 'cloud_init', return_value='fixture'), patch.object(fleet, 'update_host', side_effect=lambda h, **kw: events.append(kw['state'])):
            fleet.reconcile_host(self.host, self.cfg)
        self.assertEqual(events, ['CREATING', 'create', 'BOOTING'])
        self.assertEqual(provider.create.call_args.args[0]['instance_name'], 'merchent-acme-shop')

    def test_uncertain_create_discovers_without_creating_again(self):
        provider = Mock()
        provider.discover.return_value = None
        with patch.object(fleet, 'host_directory', return_value=Path('/fixture')), patch.object(fleet, 'Provider', return_value=provider), patch.object(fleet, 'update_host'):
            fleet.reconcile_host(dict(self.host, state='CREATING'), self.cfg)
        provider.discover.assert_called_once()
        provider.create.assert_not_called()

    def test_changed_profile_cannot_create_a_different_machine(self):
        with patch.object(fleet, 'host_directory', return_value=Path('/fixture')), patch.object(fleet, 'Provider') as provider:
            with self.assertRaisesRegex(ValueError, 'PROFILE_CHANGED'):
                fleet.reconcile_host(dict(self.host, profile_digest='c'*64), self.cfg)
            provider.assert_not_called()

    def test_dns_conflict_never_overwrites_an_unmanaged_record(self):
        binding = {'tenantId': str(uuid.uuid4()), 'storefrontHost': 'test.rocento.com', 'adminHost': 'test-admin.rocento.com'}
        with patch.object(fleet, 'secret', return_value='fixture'), patch.object(fleet, 'http', return_value={'success': True, 'result': [{'type': 'A', 'content': self.host['address'], 'proxied': True}]}) as api:
            with self.assertRaisesRegex(ValueError, 'DNS_RECORD_CONFLICT'):
                fleet.dns(self.host, binding, self.cfg)
            self.assertEqual([c.args[0] for c in api.call_args_list], ['GET'])

    def test_dns_retries_reuse_only_owned_matching_records(self):
        binding = {'tenantId': str(uuid.uuid4()), 'storefrontHost': 'test.rocento.com', 'adminHost': 'test-admin.rocento.com'}
        record = {'type': 'A', 'content': self.host['address'], 'proxied': True, 'comment': 'rocento-tenant:'+binding['tenantId']}
        with patch.object(fleet, 'secret', return_value='fixture'), patch.object(fleet, 'http', return_value={'success': True, 'result': [record]}) as api:
            fleet.dns(self.host, binding, self.cfg)
            self.assertEqual([c.args[0] for c in api.call_args_list], ['GET', 'GET'])

    def test_ssh_checks_exact_host_key_and_uses_fixed_endpoint(self):
        with tempfile.TemporaryDirectory() as root, patch.object(fleet, 'trusted', side_effect=Path), patch.object(fleet, 'host_directory', return_value=Path(root)), patch.object(fleet, 'run', return_value=b'{}') as run:
            (Path(root)/'ssh_host_ed25519_key.pub').write_text('ssh-ed25519 fixture comment')
            fleet.remote(self.host, self.cfg, {'operation': 'prepare'})
            args = run.call_args.args[0]
            self.assertIn('StrictHostKeyChecking=yes', args)
            self.assertNotIn('StrictHostKeyChecking=no', args)
            self.assertEqual(args[-1], '/usr/local/lib/rocento/fleet-node.py')
            self.assertEqual(json.loads(run.call_args.args[1])['hostId'], self.host['id'])

    def test_restriction_targets_assigned_host_even_when_failed(self):
        item = {'tenantId': str(uuid.uuid4())}
        with patch.object(fleet, 'placement', return_value=dict(self.host, state='FAILED')), patch.object(fleet, 'configuration', return_value=self.cfg), patch.object(fleet, 'remote', return_value={'hostId': self.host['id'], 'restricted': item['tenantId']}) as remote:
            self.assertTrue(fleet.restrict(item))
            self.assertEqual(remote.call_args.args[0]['id'], self.host['id'])

    def test_unreachable_reserved_host_cannot_be_marked_restricted(self):
        with patch.object(fleet, 'placement', return_value=dict(self.host, address=None)), patch.object(fleet, 'remote') as remote:
            with self.assertRaises(fleet.Waiting):
                fleet.restrict({'tenantId': str(uuid.uuid4())})
            remote.assert_not_called()

    def test_node_rejects_wrong_host_and_expired_authorization(self):
        merchant = Mock()
        merchant.read_json.return_value = {'hostId': self.host['id'], 'environment': 'test',
            'provider': 'aws', 'releaseDigest': self.host['release_digest']}
        with self.assertRaisesRegex(ValueError, 'HOST_IDENTITY'):
            node.handle({'hostId': 'other'}, merchant)
        with self.assertRaisesRegex(ValueError, 'REMOTE_AUTHORIZATION'):
            node.handle({'hostId': self.host['id'], 'operation': 'provision', 'binding': {
                'environment': 'test', 'hostingProvider': 'aws', 'artifactDigest': self.host['release_digest'],
                'expiresAt': 0}}, merchant)
        merchant.execute_bound.assert_not_called()

    def test_missing_staff_selection_creates_no_host(self):
        merchant = Mock()
        binding = {'tenantId': str(uuid.uuid4()), 'hostingProvider': None}
        merchant.database_binding.return_value = binding
        merchant.validate_request.return_value = ({}, binding)
        with patch.object(fleet, 'sql') as sql:
            with self.assertRaisesRegex(fleet.Waiting, 'HOSTING_PROVIDER_REQUIRED'):
                fleet.execute({}, merchant)
            sql.assert_not_called()

    def test_unapproved_release_cannot_reserve_capacity(self):
        merchant = Mock()
        binding = {'tenantId': str(uuid.uuid4()), 'hostingProvider': 'aws'}
        merchant.database_binding.return_value = binding
        merchant.validate_request.return_value = ({}, binding)
        merchant.authorized_release.side_effect = ValueError('unapproved')
        with patch.object(fleet, 'configuration', return_value=self.cfg), patch.object(fleet, 'sql') as sql:
            with self.assertRaisesRegex(ValueError, 'unapproved'):
                fleet.execute({}, merchant)
            sql.assert_not_called()

    def test_release_scope_rejects_other_tenant_before_reservation(self):
        self.profile['allowedTenantIds'] = [str(uuid.uuid4())]
        merchant = Mock()
        binding = {'tenantId': str(uuid.uuid4()), 'hostingProvider': 'aws'}
        merchant.database_binding.return_value = binding
        merchant.validate_request.return_value = ({}, binding)
        with patch.object(fleet, 'configuration', return_value=self.cfg), patch.object(fleet, 'sql') as sql:
            with self.assertRaisesRegex(fleet.Waiting, 'TENANT_NOT_IN_RELEASE_SCOPE'):
                fleet.execute({}, merchant)
            sql.assert_not_called()
            merchant.authorized_release.assert_not_called()

    def test_allowed_tenant_still_requires_release_approval(self):
        tenant = str(uuid.uuid4())
        self.profile['allowedTenantIds'] = [tenant]
        merchant = Mock()
        binding = {'tenantId': tenant, 'hostingProvider': 'aws'}
        merchant.database_binding.return_value = binding
        merchant.validate_request.return_value = ({}, binding)
        merchant.authorized_release.side_effect = ValueError('unapproved')
        with patch.object(fleet, 'configuration', return_value=self.cfg), patch.object(fleet, 'sql') as sql:
            with self.assertRaisesRegex(ValueError, 'unapproved'):
                fleet.execute({}, merchant)
            sql.assert_not_called()

    def test_invalid_release_scope_fails_closed(self):
        tenant = str(uuid.uuid4())
        for value in (None, [], tenant, [tenant, tenant], ["' OR true --"], [1]):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'INVALID_TENANT_RELEASE_SCOPE'):
                fleet.allowed_tenants({'allowedTenantIds': value})

    def test_boot_authorization_is_limited_to_release_scope(self):
        tenant = str(uuid.uuid4())
        self.profile['allowedTenantIds'] = [tenant]
        with patch.object(fleet, 'sql', return_value='') as sql, patch.object(fleet, 'module') as module:
            with self.assertRaisesRegex(fleet.Waiting, 'FLEET_NO_ELIGIBLE_TENANT'):
                fleet.boot_release(self.host, self.profile)
            self.assertIn("AND t.id IN ('" + tenant + "')", sql.call_args.args[0])
            module.assert_not_called()

    def test_scope_change_invalidates_saved_host_before_apply(self):
        current = dict(self.cfg, providers={'aws': dict(self.profile, allowedTenantIds=[str(uuid.uuid4())])})
        with patch.object(fleet, 'configuration', return_value=current), patch.object(fleet, 'boot_release') as boot:
            with self.assertRaisesRegex(fleet.Waiting, 'HOST_PROFILE_CHANGED'):
                fleet.authorize_creation(self.host, self.profile, self.cfg)
            boot.assert_not_called()

    def test_observation_returns_only_scoped_health_and_latency(self):
        tenant, container = str(uuid.uuid4()), 'a' * 64
        merchant = Mock()
        merchant.STATE = Path('/fixture')
        merchant.trusted.side_effect = lambda value: value
        merchant.read_json.return_value = {'name': 'merchant-' + tenant, 'services': {'api-gateway': {'image': 'sha256:fixture', 'environment': {'SECRET': 'never-return'}}}}
        merchant.compose.return_value = (container + '\n').encode()
        details = [{'Id': container, 'Image': 'sha256:fixture', 'RestartCount': 0,
                    'Config': {'Env': ['SECRET=never-return'], 'Labels': {'com.docker.compose.project': 'merchant-' + tenant, 'com.docker.compose.service': 'api-gateway'}},
                    'State': {'Running': True, 'OOMKilled': False, 'Health': {'Status': 'healthy'}}}]
        logs = [json.dumps({'timestamp': '2026-11-17T23:00:00Z', 'fields': {'message': 'request completed', 'route': '/v1/customer/checkout/place', 'duration_seconds': duration, 'status': status, 'secret': 'never-return'}}) for duration, status in ((.1, 200), (1.5, 500))]
        merchant.command.side_effect = [json.dumps(details).encode(), b'{"status":"ready"}', '\n'.join(logs).encode()]
        with patch.object(node.Path, 'read_text', return_value='MemAvailable: 1234 kB\n'), patch.object(node.shutil, 'disk_usage', return_value=SimpleNamespace(free=999)):
            result = node.observe({'tenantId': tenant}, {'hostId': self.host['id'], 'releaseDigest': self.host['release_digest']}, merchant)
        self.assertTrue(result['ready'])
        self.assertEqual(result['checkoutLast60Seconds']['p99Seconds'], 1.5)
        self.assertEqual(result['checkoutLast60Seconds']['serverErrors'], 1)
        self.assertNotIn('never-return', json.dumps(result))
        self.assertEqual(result['missingServices'], [])
        self.assertEqual(merchant.command.call_args.args[0], ['docker', 'logs', '--since', '60s', '--tail', '50000', container])
        details[0]['State']['Health']['Status'] = 'unhealthy'
        merchant.command.side_effect = [json.dumps(details).encode(), b'{"status":"ready"}', b'']
        with patch.object(node.Path, 'read_text', return_value='MemAvailable: 1234 kB\n'), patch.object(node.shutil, 'disk_usage', return_value=SimpleNamespace(free=999)):
            result = node.observe({'tenantId': tenant}, {'hostId': self.host['id'], 'releaseDigest': self.host['release_digest']}, merchant)
        self.assertFalse(result['ready'])

    def test_observation_rejects_foreign_container_before_reading_logs(self):
        tenant = str(uuid.uuid4())
        merchant = Mock()
        merchant.STATE = Path('/fixture')
        merchant.trusted.side_effect = lambda value: value
        merchant.read_json.return_value = {'name': 'merchant-' + tenant, 'services': {'api-gateway': {'image': 'sha256:fixture'}}}
        merchant.compose.return_value = ('a' * 64).encode()
        merchant.command.return_value = json.dumps([{'Config': {'Labels': {'com.docker.compose.project': 'another-tenant', 'com.docker.compose.service': 'api-gateway'}}}]).encode()
        with self.assertRaisesRegex(ValueError, 'TENANT_RUNTIME_MISMATCH'):
            node.observe({'tenantId': tenant}, {'hostId': self.host['id'], 'releaseDigest': self.host['release_digest']}, merchant)
        merchant.command.assert_called_once()

    def test_observation_without_runtime_does_not_claim_ready_or_latency(self):
        tenant = str(uuid.uuid4())
        merchant = Mock()
        merchant.STATE = Path('/fixture')
        merchant.trusted.side_effect = lambda value: value
        merchant.read_json.return_value = {'name': 'merchant-' + tenant, 'services': {'api-gateway': {}}}
        merchant.compose.return_value = b''
        with patch.object(node.Path, 'read_text', return_value='MemAvailable: 1234 kB\n'), patch.object(node.shutil, 'disk_usage', return_value=SimpleNamespace(free=999)):
            result = node.observe({'tenantId': tenant}, {'hostId': self.host['id'], 'releaseDigest': self.host['release_digest']}, merchant)
        self.assertFalse(result['ready'])
        self.assertIsNone(result['checkoutLast60Seconds']['p99Seconds'])
        self.assertEqual(result['missingServices'], ['api-gateway'])
        merchant.command.assert_not_called()

    def test_observation_cannot_escape_tenant_directory(self):
        merchant = Mock()
        with self.assertRaises(ValueError):
            node.observe({'tenantId': '../other-store'}, self.host, merchant)
        merchant.trusted.assert_not_called()
        merchant.command.assert_not_called()

    def test_controller_observation_checks_identity_with_provisioning_disabled(self):
        tenant = str(uuid.uuid4())
        with patch.object(fleet, 'placement', return_value=self.host), patch.object(fleet, 'configuration', return_value=self.cfg) as cfg, patch.object(fleet, 'remote', return_value={'hostId': self.host['id'], 'tenantId': tenant, 'releaseDigest': self.host['release_digest']}) as remote:
            self.assertEqual(fleet.observe(tenant)['tenantId'], tenant)
            cfg.assert_called_once_with(controls=True)
            remote.return_value = {'hostId': self.host['id'], 'tenantId': str(uuid.uuid4()), 'releaseDigest': self.host['release_digest']}
            with self.assertRaisesRegex(ValueError, 'OBSERVATION_IDENTITY_MISMATCH'):
                fleet.observe(tenant)


if __name__ == '__main__':
    unittest.main()
