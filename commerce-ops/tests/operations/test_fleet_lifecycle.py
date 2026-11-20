"""Exercise controller/node scenarios for each provider without cloud effects."""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/host'))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/controller'))
import merchant_fleet as f
import fleet_node as node
from fleet_providers import ProviderError


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        for module, name in ((f,'host_directory'),(f,'run'),(f,'sql'),(f,'http')):
            guard=patch.object(module,name,side_effect=AssertionError('Unmocked infrastructure I/O'))
            guard.start();self.addCleanup(guard.stop)
        lock_guard = patch.object(f, 'host_execution_lock', return_value=nullcontext())
        lock_guard.start(); self.addCleanup(lock_guard.stop)
        self.host={'id':str(uuid.uuid4()),'provider':'aws','state':'READY','address':'192.0.2.1',
                   'release_digest':'sha256:'+'a'*64,'provider_reference':'123','expired':False}
        self.profile={'maxHosts':2,'minMemoryGiB':16,'environment':'fixture'}
        self.host['profile_digest']=f.profile_digest(self.profile)
        self.cfg={'terraform':{},'providers':{p:self.profile for p in ('aws','gcp','hetzner')}}
        self.job={'id':str(uuid.uuid4()),'tenantId':str(uuid.uuid4()),'leaseToken':str(uuid.uuid4()),
                  'artifactDigest':self.host['release_digest'],'step':'RELEASE'}
        self.binding={'tenantId':self.job['tenantId'],'hostingProvider':'aws','expiresAt':time.time()+175}

    def merchant(self, provider='aws'):
        m=Mock()
        binding=dict(self.binding,hostingProvider=provider)
        m.database_binding.side_effect=lambda request: dict(binding)
        m.validate_request.side_effect=lambda request, bindings: (self.job, dict(binding))
        return m

    def test_every_step_uses_the_selected_provider_and_bound_remote_host(self):
        for provider in ('aws','gcp','hetzner'):
            for step in ('RELEASE','ALLOCATE','DATABASE','MIGRATE','SERVICES','BOOTSTRAP','INGRESS','VALIDATE'):
                with self.subTest(provider=provider,step=step):
                    self.job['step']=step
                    m=self.merchant(provider)
                    host=dict(self.host,provider=provider)
                    evidence={'jobId':self.job['id'],'step':step}
                    with patch.object(f,'configuration',return_value=self.cfg),patch.object(f,'sql',return_value=json.dumps(host)),patch.object(f,'remote',return_value=evidence) as remote,patch.object(f,'dns') as dns:
                        self.assertEqual(f.execute({},m),evidence)
                        self.assertEqual(remote.call_args.args[0]['provider'],provider)
                        self.assertEqual(remote.call_args.args[2]['binding']['environment'],'fixture')
                        self.assertGreater(remote.call_args.kwargs['timeout'],0)
                        self.assertEqual(dns.call_count,1 if step=='VALIDATE' else 0)
                        self.assertEqual(m.database_binding.call_count,2)

    def test_pending_failed_draining_and_host_limit_never_dispatch(self):
        for provider in ('aws','gcp','hetzner'):
            for state in ('REQUESTED','CREATING','BOOTING','FAILED','DRAINING','LIMIT'):
                with self.subTest(provider=provider,state=state):
                    raw='' if state=='LIMIT' else json.dumps(dict(self.host,provider=provider,state=state))
                    with patch.object(f,'configuration',return_value=self.cfg),patch.object(f,'sql',return_value=raw),patch.object(f,'remote') as remote,self.assertRaises(f.Waiting):
                        f.execute({},self.merchant(provider))
                    remote.assert_not_called()

    def test_revocation_between_placement_and_dispatch_stops_remote_execution(self):
        m=self.merchant();m.database_binding.side_effect=[self.binding,ValueError('LEASE_REVOKED')]
        with patch.object(f,'configuration',return_value=self.cfg),patch.object(f,'sql',return_value=json.dumps(self.host)),patch.object(f,'remote') as remote,self.assertRaisesRegex(ValueError,'LEASE_REVOKED'):
            f.execute({},m)
        remote.assert_not_called()

    def test_changed_release_or_profile_never_reuses_assigned_host(self):
        for changes in ({'profile_digest':'b'*64},{'release_digest':'sha256:'+'b'*64}):
            with patch.object(f,'configuration',return_value=self.cfg),patch.object(f,'sql',return_value=json.dumps(dict(self.host,**changes))),patch.object(f,'remote') as remote,self.assertRaises(f.Waiting):
                f.execute({},self.merchant())
            remote.assert_not_called()

    def test_boot_transient_errors_remain_pending_and_definitive_errors_fail(self):
        for state in ('CREATING','BOOTING'):
            for error,terminal in [(ProviderError('PROVIDER_HTTP_503',retryable=True,uncertain=True),False),
                                   (ProviderError('PROVIDER_HTTP_403'),True),
                                   (ValueError('DUPLICATE_PROVIDER_ALLOCATION'),True)]:
                with self.subTest(state=state,error=str(error)):
                    host=dict(self.host,state=state)
                    with patch.object(f,'configuration',return_value=self.cfg),patch.object(f,'sql',side_effect=[json.dumps([host]),state]),patch.object(f,'reconcile_host',side_effect=error),patch.object(f,'update_host') as update:
                        f.reconcile()
                    self.assertEqual(update.call_args.kwargs.get('state')=='FAILED',terminal)

    def test_changed_authorization_before_vm_create_does_not_spend(self):
        for provider in ('aws','gcp','hetzner'):
            host=dict(self.host,provider=provider,state='REQUESTED')
            with patch.object(f,'boot_release',side_effect=f.Waiting('RELEASE_AUTHORIZATION_REQUIRED')),patch.object(f,'host_directory',return_value=Path('/fixture')),patch.object(f,'Provider') as adapter,patch.object(f,'update_host') as update,self.assertRaises(f.Waiting):
                f.reconcile_host(host,self.cfg)
            adapter.return_value.create.assert_not_called();update.assert_not_called()

    def test_boot_authorization_reads_current_evidence_before_create(self):
        merchant=Mock();merchant.Blocked=type('Blocked',(Exception,),{})
        with patch.object(f,'sql',return_value=json.dumps({'artifactDigest':self.host['release_digest']})),patch.object(f,'module',return_value=merchant):
            f.boot_release(self.host,self.profile)
        merchant.authorized_release.assert_called_once()
        self.assertFalse(merchant.authorized_release.call_args.kwargs['runtime'])
        with patch.object(f,'sql',return_value=''),patch.object(f,'module') as load,self.assertRaises(f.Waiting):
            f.boot_release(self.host,self.profile)
        load.assert_not_called()

    def test_bootstrap_attests_code_before_transferring_credentials(self):
        provider=Mock();provider.discover.return_value={'reference':'123','running':True,'address':'192.0.2.1'}
        with patch.object(f,'host_directory',return_value=Path('/fixture')),patch.object(f,'Provider',return_value=provider),patch.object(f,'update_host'),patch.object(f,'expected_tools',return_value={'node':'expected'}),patch.object(f,'remote',return_value={'hostId':self.host['id'],'tools':{'node':'changed'}}) as remote,patch.object(f,'secret') as secret,self.assertRaisesRegex(ValueError,'IDENTITY_MISMATCH'):
            f.reconcile_host(dict(self.host,state='BOOTING'),self.cfg)
        self.assertEqual(remote.call_args.args[2],{'operation':'inspect'})
        secret.assert_not_called()

    def test_bootstrap_success_marks_ready_only_after_both_checks(self):
        provider=Mock();provider.discover.return_value={'reference':'123','running':True,'address':'192.0.2.1'}
        identity={'hostId':self.host['id'],'tools':{'node':'expected'}}
        with patch.object(f,'host_directory',return_value=Path('/fixture')),patch.object(f,'Provider',return_value=provider),patch.object(f,'update_host') as update,patch.object(f,'expected_tools',return_value=identity['tools']),patch.object(f,'remote',side_effect=[identity,dict(identity,ready=True)]) as remote,patch.object(f,'secret',return_value='{}'):
            f.reconcile_host(dict(self.host,state='BOOTING'),self.cfg)
        self.assertEqual([c.args[2]['operation'] for c in remote.call_args_list],['inspect','prepare'])
        self.assertEqual(update.call_args.kwargs,{'state':'READY','error_code':None})

    def test_restrictions_use_control_configuration_even_when_creation_disabled(self):
        item={'tenantId':self.job['tenantId']}
        with patch.object(f,'placement',return_value=self.host),patch.object(f,'configuration',return_value={'enabled':False}) as config,patch.object(f,'remote',return_value={'hostId':self.host['id'],'restricted':item['tenantId']}):
            self.assertTrue(f.restrict(item))
        config.assert_called_once_with(controls=True)

    def test_disabled_control_configuration_needs_no_provider_or_dns_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root);(path/'fleet.json').write_text('{}')
            cfg={'enabled':False,'sshPrivateKey':'/key','sshPublicKey':'/pub'}
            with patch.object(f,'CONFIG',path),patch.object(f,'secret',side_effect=[json.dumps(cfg),'private']),patch.object(f,'trusted',side_effect=Path):
                self.assertEqual(f.configuration(controls=True),cfg)

    def test_node_requires_provider_release_environment_and_unexpired_lease(self):
        merchant=Mock();config={'hostId':self.host['id'],'provider':'aws','releaseDigest':self.host['release_digest'],'environment':'fixture'}
        merchant.read_json.return_value=config
        binding=dict(self.binding,environment='fixture',artifactDigest=self.host['release_digest'])
        for changes in ({'hostingProvider':'gcp'},{'environment':'other'},{'artifactDigest':'sha256:'+'b'*64},{'expiresAt':0},{'expiresAt':time.time()+3600}):
            with self.subTest(changes=changes),patch.object(node,'metadata_firewall') as firewall,self.assertRaisesRegex(ValueError,'AUTHORIZATION'):
                node.handle({'hostId':self.host['id'],'operation':'provision','binding':dict(binding,**changes),'request':{'job':self.job,'operation':'execute'}},merchant)
            firewall.assert_not_called()
        merchant.execution_window.return_value = nullcontext()
        with patch.object(node,'metadata_firewall'):
            node.handle({'hostId':self.host['id'],'operation':'provision','binding':binding,'request':{'job':self.job,'operation':'execute'}},merchant)
        merchant.execute_bound.assert_called_once()

    def test_receipt_reconciliation_never_reserves_capacity_or_changes_dns(self):
        self.job['step'] = 'VALIDATE'
        merchant = self.merchant()
        with patch.object(f, 'configuration', return_value=self.cfg), patch.object(f, 'placement', return_value=self.host), patch.object(f, 'sql') as sql, patch.object(f, 'dns') as dns, patch.object(f, 'remote', return_value={'receipt':'verified'}) as remote:
            result = f.execute({'operation':'reconcile'}, merchant)
            self.assertEqual(result, {'receipt':'verified'})
            sql.assert_not_called(); dns.assert_not_called()
            self.assertLessEqual(remote.call_args.kwargs['timeout'], 15)

    def test_node_receipt_lookup_does_not_change_firewall(self):
        merchant = Mock()
        merchant.read_json.return_value = {'hostId':self.host['id'], 'provider':'aws', 'releaseDigest':self.host['release_digest'], 'environment':'fixture'}
        merchant.execution_window.return_value = nullcontext()
        binding = dict(self.binding, environment='fixture', artifactDigest=self.host['release_digest'])
        request = {'job':self.job, 'operation':'reconcile'}
        with patch.object(node, 'metadata_firewall') as firewall:
            node.handle({'hostId':self.host['id'], 'operation':'provision', 'binding':binding, 'request':request}, merchant)
            firewall.assert_not_called()
            merchant.execute_bound.assert_called_once_with(request, binding)

    def test_inspect_is_read_only(self):
        merchant=Mock();merchant.read_json.return_value={'hostId':self.host['id']}
        result=node.handle({'hostId':self.host['id'],'operation':'inspect'},merchant)
        self.assertEqual(result['hostId'],self.host['id'])
        merchant.command.assert_not_called();merchant.execute_bound.assert_not_called()

    def test_dns_partial_success_is_reconciled_without_duplicate_write(self):
        host=self.host
        binding={'tenantId':self.job['tenantId'],'storefrontHost':'fixture.rocento.com','adminHost':'fixture-admin.rocento.com'}
        records={};writes=[]
        def api(method,url,token,body=None,**kwargs):
            if method=='GET': return {'success':True,'result':records.get(url.split('?name=')[1],[])}
            writes.append(body['name']);records[body['name']]=[body]
            if len(writes)==2: raise ProviderError('PROVIDER_TRANSPORT_FAILED',uncertain=True)
            return {'success':True}
        cfg={'cloudflare':{'zoneId':'a'*32,'tokenFile':'/token'}}
        with patch.object(f,'http',side_effect=api),patch.object(f,'secret',return_value='token'):
            with self.assertRaises(ProviderError):f.dns(host,binding,cfg)
            f.dns(host,binding,cfg)
        self.assertEqual(len(writes),2)

    def test_post_plan_authorization_rechecks_enablement_profile_and_backend(self):
        for name in ('aws', 'gcp', 'hetzner'):
            host = dict(self.host, provider=name)
            with patch.object(f, 'configuration', side_effect=f.Waiting('FLEET_NOT_CONFIGURED')), patch.object(f, 'boot_release') as release:
                with self.assertRaises(f.Waiting): f.authorize_creation(host, self.profile, self.cfg)
                release.assert_not_called()
            for current in (dict(self.cfg, terraform={'bucket':'changed'}), dict(self.cfg, providers={})):
                with patch.object(f, 'configuration', return_value=current), patch.object(f, 'boot_release') as release:
                    with self.assertRaises(f.Waiting): f.authorize_creation(host, self.profile, self.cfg)
                    release.assert_not_called()
            with patch.object(f, 'configuration', return_value=self.cfg), patch.object(f, 'boot_release') as release:
                f.authorize_creation(host, self.profile, self.cfg)
                release.assert_called_once_with(host, self.profile)



class ConcurrentFleetTests(unittest.TestCase):
    def test_real_host_locks_allow_independent_hosts_and_exclude_same_host(self):
        with tempfile.TemporaryDirectory() as root, patch.object(f, 'STATE', Path(root)), patch.object(f, 'trusted', side_effect=Path):
            first, second = {'id':str(uuid.uuid4())}, {'id':str(uuid.uuid4())}
            with f.host_execution_lock(first):
                with f.host_execution_lock(second):
                    pass
                with self.assertRaisesRegex(f.Waiting, 'HOST_EXECUTION_BUSY'):
                    with f.host_execution_lock(first): pass
            with f.host_execution_lock(first): pass

    def test_host_reconciliation_runs_a_bounded_parallel_batch(self):
        import threading
        barrier = threading.Barrier(2)
        hosts = [{'id':str(uuid.uuid4()), 'expired':False} for _ in range(2)]
        seen = []
        def reconcile(host, cfg):
            seen.append(host['id'])
            barrier.wait(timeout=3)  # Sequential execution would fail this check.
        with patch.object(f, 'configuration', return_value={'reconcileConcurrency':2}), patch.object(f, 'sql', return_value=json.dumps(hosts)) as sql, patch.object(f, 'reconcile_host', side_effect=reconcile), patch.object(f, 'update_host') as update:
            f.reconcile()
            self.assertEqual(set(seen), {h['id'] for h in hosts})
            self.assertIn('LIMIT 2', sql.call_args.args[0])
            update.assert_not_called()
        for invalid in (0, 9, -1, True, '4'):
            with self.assertRaises(ValueError): f.reconcile_concurrency({'reconcileConcurrency':invalid})

    def test_busy_remote_restriction_is_retryable(self):
        host = {'id':str(uuid.uuid4()), 'address':'192.0.2.1'}
        with patch.object(f, 'placement', return_value=host), patch.object(f, 'configuration', return_value={}), patch.object(f, 'remote', return_value={'blocked':True}):
            with self.assertRaisesRegex(f.Waiting, 'HOST_EXECUTION_BUSY'):
                f.restrict({'tenantId':str(uuid.uuid4())})

if __name__ == '__main__': unittest.main()
