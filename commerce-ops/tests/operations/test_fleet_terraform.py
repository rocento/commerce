"""Terraform orchestration tests: every cloud/CLI call is intercepted."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/controller'))
import fleet_terraform as tf
from fleet_providers import ProviderError


class TerraformTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.real_runner = tf.run_terraform
        self.guard = patch.object(tf, 'run_terraform', side_effect=AssertionError('Unmocked Terraform call'))
        self.guard.start()
        plan_guard = patch.object(tf.Provider, 'plan_checksum', return_value='fixture-plan-digest')
        plan_guard.start()
        self.addCleanup(plan_guard.stop)
        self.addCleanup(self.guard.stop)
        self.host = {'instance_name': 'merchent-acme', 'id': str(uuid.uuid4()), 'profile_digest': 'a'*64, 'release_digest': 'sha256:'+'b'*64}
        self.backend = {'bucket': 'fixture-state', 'region': 'eu-west-1', 'keyPrefix': 'fleet/test'}

    def provider(self, name):
        return tf.Provider(name, {'tokenFile': '/token', 'maxHosts': 2},
            lambda path: 'fixture-token' if str(path) == '/token' else Path(path).read_text(),
            terraform=self.backend, directory=self.directory, trusted=Path, authorize=Mock())

    def state(self, name):
        return {'values': {'root_module': {'resources': [{'address': tf.RESOURCES[name]+'.merchant',
            'mode': 'managed', 'values': {'id': '42', 'instance_id': '42',
                'tags': {'rocento-host': self.host['id']}, 'labels': {'rocento-host': self.host['id']}}}]}}}

    def plan(self, name):
        return {'complete': True, 'resource_changes': [{'mode': 'managed',
            'address': tf.RESOURCES[name]+'.merchant', 'change': {'actions': ['create']}}]}

    def test_all_providers_apply_only_saved_single_create_after_authorization(self):
        for name in tf.RESOURCES:
            with self.subTest(provider=name), tempfile.TemporaryDirectory() as root:
                p = self.provider(name); p.root = Path(root)
                events = []
                def command(*args, **kw):
                    events.append(args)
                    if args == ('show', '-json', 'create.tfplan'): return json.dumps(self.plan(name))
                    if args == ('show', '-json'): return json.dumps(self.state(name) if any(x[0]=='apply' for x in events) else {})
                    return b''
                p.authorize.side_effect = lambda: events.append(('authorized',))
                with patch.object(p, 'workspace'), patch.object(p, 'command', side_effect=command):
                    result = p.create(self.host, 'synthetic-cloud-init')
                self.assertEqual(result, {'reference':'42','operation':None})
                self.assertEqual(events[-3][0], 'authorized')
                self.assertEqual(events[-2][-1], 'create.tfplan')
                self.assertNotIn('-auto-approve', events[-2])
                self.assertTrue((p.root/'apply-intent.json').exists())

    def test_plan_rejects_update_delete_replace_extra_resource_and_incomplete(self):
        for name in tf.RESOURCES:
            good = self.plan(name)
            tf.creation_plan(good,name)
            bad = []
            for actions in (['update'], ['delete'], ['delete','create'], ['no-op'], ['read']):
                plan = copy.deepcopy(good); plan['resource_changes'][0]['change']['actions']=actions;bad.append(plan)
            for field,value in [('complete',False),('errored',True),('deferred_changes',[{}])]:
                bad.append(dict(good,**{field:value}))
            bad.append({'resource_changes': good['resource_changes']})
            bad.append(dict(good, resource_drift=[{}]))
            imported = copy.deepcopy(good); imported['resource_changes'][0]['change']['importing'] = {'id': 'foreign'}; bad.append(imported)
            bad.extend([dict(good,resource_changes=[]),dict(good,resource_changes=good['resource_changes']*2)])
            for plan in bad:
                with self.subTest(provider=name,plan=plan),self.assertRaisesRegex(ValueError,'SINGLE_CREATE'):
                    tf.creation_plan(plan,name)

    def test_revocation_after_planning_prevents_apply(self):
        p=self.provider('aws');p.root.mkdir()
        p.authorize.side_effect=ValueError('REVOKED')
        with patch.object(p,'workspace'),patch.object(p,'state_reference',return_value=None),patch.object(p,'command',return_value=json.dumps(self.plan('aws'))) as command:
            with self.assertRaisesRegex(ValueError,'REVOKED'):p.create(self.host,'fixture')
        self.assertNotIn('apply',[c.args[0] for c in command.call_args_list])
        self.assertFalse((p.root/'apply-intent.json').exists())

    def test_timeout_is_never_automatically_reapplied(self):
        p=self.provider('aws');p.root.mkdir()
        def command(*args,**kwargs):
            if args[0]=='apply':raise ProviderError('TERRAFORM_COMMAND_INTERRUPTED',uncertain=True)
            return json.dumps(self.plan('aws'))
        with patch.object(p,'workspace'),patch.object(p,'state_reference',return_value=None),patch.object(p,'command',side_effect=command) as run:
            with self.assertRaises(ProviderError):p.create(self.host,'fixture')
            with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):p.create(self.host,'fixture')
            self.assertEqual(sum(c.args[0]=='apply' for c in run.call_args_list),1)
            self.assertIsNone(p.discover(self.host))

    def test_recovery_requires_state_and_live_provider_identity(self):
        for name in tf.RESOURCES:
            p=self.provider(name)
            p.secret = Mock(return_value=json.dumps({'instance_name': 'merchent-acme'}))
            with patch.object(p,'workspace'),patch.object(p,'command',return_value=json.dumps(self.state(name))) as run,patch.object(p.reader,'discover',return_value={'reference':'42'}) as reader:
                self.assertEqual(p.discover(self.host),{'reference':'42'})
                self.assertEqual(reader.call_args.args[0]['provider_reference'],'42')
                self.assertEqual(reader.call_args.args[0]['instance_name'],'merchent-acme')
                self.assertEqual([c.args for c in run.call_args_list],[('show','-json')])

    def test_state_refuses_foreign_extra_missing_or_replaced_identity(self):
        for name in tf.RESOURCES:
            p=self.provider(name)
            bad=[]
            state=self.state(name);state['values']['root_module']['resources'][0]['values']['tags']['rocento-host']='foreign';state['values']['root_module']['resources'][0]['values']['labels']['rocento-host']='foreign';bad.append(state)
            state=self.state(name);state['values']['root_module']['resources']*=2;bad.append(state)
            state=self.state(name);state['values']['root_module']['child_modules']=[{}];bad.append(state)
            state=self.state(name);state['values']['root_module']['resources'][0]['values']['id']=None;state['values']['root_module']['resources'][0]['values']['instance_id']=None;bad.append(state)
            for state in bad:
                with patch.object(p,'command',return_value=json.dumps(state)),self.assertRaises(ValueError):p.state_reference(self.host)
            with patch.object(p,'command',return_value=json.dumps(self.state(name))),self.assertRaisesRegex(ValueError,'IDENTITY_CHANGED'):
                p.state_reference(dict(self.host,provider_reference='different'))

    def test_workspace_uses_locked_encrypted_remote_state_without_credentials(self):
        for name in tf.RESOURCES:
            with tempfile.TemporaryDirectory() as root:
                p=self.provider(name);p.root=Path(root)/'terraform'
                with patch.object(p,'command') as command:
                    p.workspace(self.host,'synthetic-cloud-init')
                    p.workspace(self.host)
                backend=json.loads((p.root/'backend.json').read_text())
                self.assertTrue(backend['encrypt']);self.assertTrue(backend['use_lockfile'])
                self.assertEqual(backend['key'],f"fleet/test/{name}/{self.host['id']}.tfstate")
                variables=json.loads((p.root/'merchant.auto.tfvars.json').read_text())
                self.assertEqual(variables['instance_name'], 'merchent-acme')
                self.assertNotIn('tokenFile',variables['profile'])
                self.assertNotIn('maxHosts',variables['profile'])
                self.assertEqual((p.root/'backend.json').stat().st_mode & 0o777,0o600)
                self.assertIn('-lockfile=readonly',command.call_args.args)
                p.backend=dict(self.backend,bucket='changed-state')
                with self.assertRaisesRegex(ValueError,'BINDING_CHANGED'):p.workspace(self.host)

    def test_missing_or_changed_workspace_is_not_adopted(self):
        p=self.provider('aws');p.root.mkdir()
        with self.assertRaisesRegex(ValueError,'WORKSPACE_MISSING'):p.workspace(self.host)
        (p.root/'foreign').write_text('fixture')
        with self.assertRaisesRegex(ValueError,'UNBOUND'):p.workspace(self.host,'fixture')

    def test_cli_strips_override_flags_and_sanitizes_failure(self):
        p=self.provider('hetzner')
        with patch.dict(os.environ,{'TF_CLI_ARGS':'-destroy','TF_VAR_host_id':'foreign','TF_WORKSPACE':'foreign','HCLOUD_TOKEN':'wrong'}),patch.object(tf,'run_terraform',return_value=Mock(returncode=1,stderr=b'PRIVATE',stdout=b'PRIVATE')) as run:
            with self.assertRaisesRegex(ProviderError,'^TERRAFORM_COMMAND_FAILED$'):p.command('plan')
            env=run.call_args.args[1]
            self.assertNotIn('TF_CLI_ARGS',env);self.assertNotIn('TF_VAR_host_id',env)
            self.assertEqual(env['TF_WORKSPACE'],'default');self.assertEqual(env['HCLOUD_TOKEN'],'fixture-token')
        with patch.object(tf,'run_terraform',side_effect=subprocess.TimeoutExpired('terraform',1)),self.assertRaises(ProviderError) as error:p.command('apply')
        self.assertTrue(error.exception.uncertain)

    def test_backend_rejects_missing_values_overrides_and_unsafe_prefix(self):
        tf.validate_config(self.backend)
        for cfg in ({},dict(self.backend,keyPrefix='../other'),dict(self.backend,use_lockfile=False),dict(self.backend,bucket='')):
            with self.assertRaises(ValueError):tf.validate_config(cfg)

    def test_native_adapter_has_no_creation_fallback(self):
        self.assertFalse(hasattr(tf.CloudReader,'create'))

    def test_tainted_state_stops_recovery_for_every_provider(self):
        for name in tf.RESOURCES:
            p = self.provider(name)
            state = self.state(name)
            state['values']['root_module']['resources'][0]['tainted'] = True
            with patch.object(p, 'workspace'), patch.object(p, 'command', return_value=json.dumps(state)), patch.object(p.reader, 'discover') as cloud:
                with self.assertRaisesRegex(ValueError, 'STATE_REQUIRES_REVIEW'):
                    p.discover(self.host)
                cloud.assert_not_called()

    def test_sealed_inputs_and_unexpected_overrides_cannot_reach_terraform(self):
        for name in tf.RESOURCES:
            for filename in ('merchant.auto.tfvars.json', 'override.tf', 'extra.auto.tfvars.json'):
                with self.subTest(provider=name, file=filename), tempfile.TemporaryDirectory() as root:
                    p = self.provider(name); p.root = Path(root) / 'terraform'
                    with patch.object(p, 'command'):
                        p.workspace(self.host, 'fixture')
                    (p.root / filename).write_text('{}')
                    with patch.object(p, 'command') as command:
                        with self.assertRaisesRegex(ValueError, 'INPUT_CHANGED|UNEXPECTED_CONFIGURATION'):
                            p.workspace(self.host)
                        command.assert_not_called()

    def test_existing_state_and_changed_saved_plan_never_apply(self):
        for name in tf.RESOURCES:
            p = self.provider(name)
            with patch.object(p, 'workspace'), patch.object(p, 'state_reference', return_value='existing'), patch.object(p, 'command') as command:
                with self.assertRaisesRegex(ValueError, 'STATE_ALREADY_EXISTS'):
                    p.create(self.host, 'fixture')
                command.assert_not_called()
            with patch.object(p, 'workspace'), patch.object(p, 'state_reference', return_value=None), patch.object(p, 'command', return_value=json.dumps(self.plan(name))) as command, patch.object(p, 'plan_checksum', side_effect=['before', 'changed']):
                with self.assertRaisesRegex(ValueError, 'PLAN_CHANGED'):
                    p.create(self.host, 'fixture')
                self.assertNotIn('apply', [c.args[0] for c in command.call_args_list])

    def test_each_cli_failure_phase_never_replays_apply_on_recovery(self):
        for name in tf.RESOURCES:
            for phase in ('init', 'prestate', 'plan', 'showplan', 'apply', 'poststate'):
                with self.subTest(provider=name, phase=phase), tempfile.TemporaryDirectory() as root:
                    p = self.provider(name); p.root = Path(root) / 'terraform'
                    applied = False
                    def command(*args, **kwargs):
                        nonlocal applied
                        step = args[0]
                        if args == ('show', '-json'):
                            step = 'poststate' if applied else 'prestate'
                        elif args == ('show', '-json', 'create.tfplan'):
                            step = 'showplan'
                        if step == 'apply': applied = True
                        if step == phase:
                            raise ProviderError('TERRAFORM_COMMAND_FAILED', retryable=True, uncertain=True)
                        if step == 'showplan': return json.dumps(self.plan(name))
                        if step in ('prestate', 'poststate'): return '{}'
                        return b''
                    with patch.object(p, 'command', side_effect=command) as run:
                        with self.assertRaises(ProviderError): p.create(self.host, 'fixture')
                        calls_before = sum(c.args[0] == 'apply' for c in run.call_args_list)
                        try: p.discover(self.host)
                        except ProviderError: pass
                        self.assertEqual(sum(c.args[0] == 'apply' for c in run.call_args_list), calls_before)
                        self.assertLessEqual(calls_before, 1)

    def test_apply_intent_prevents_input_overwrite(self):
        p = self.provider('aws')
        with patch.object(p, 'command'):
            p.workspace(self.host, 'original')
        tf.write(p.root / 'apply-intent.json', {'hostId': self.host['id']})
        original = (p.root / 'merchant.auto.tfvars.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'ALREADY_ATTEMPTED'):
            p.workspace(self.host, 'changed')
        self.assertEqual((p.root / 'merchant.auto.tfvars.json').read_bytes(), original)

    def test_timeout_terminates_the_cli_and_provider_process_group(self):
        process = Mock(pid=123, returncode=-9)
        process.communicate.side_effect = [subprocess.TimeoutExpired('terraform', 1), (b'', b'')]
        process.__enter__ = Mock(return_value=process)
        process.__exit__ = Mock(return_value=False)
        with patch.object(tf.subprocess, 'Popen', return_value=process) as launch, patch.object(tf.os, 'killpg') as kill:
            # Call the real helper despite the suite's external-call guard.
            with self.assertRaises(subprocess.TimeoutExpired):
                self.real_runner(['terraform'], {}, 1)
            self.assertTrue(launch.call_args.kwargs['start_new_session'])
            kill.assert_called_once_with(123, tf.signal.SIGKILL)
            self.assertEqual(process.communicate.call_count, 2)

    def test_real_timeout_does_not_leave_a_provider_child_running(self):
        # Synthetic local processes only: no Terraform binary or cloud connection.
        ready = self.directory / 'child-ready'
        finished = self.directory / 'child-finished'
        child = ("from pathlib import Path; import time; "
                 f"Path({str(ready)!r}).touch(); time.sleep(1.5); Path({str(finished)!r}).touch()")
        parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(10)"
        with self.assertRaises(subprocess.TimeoutExpired):
            self.real_runner([sys.executable, '-c', parent], os.environ.copy(), 1)
        self.assertTrue(ready.exists(), 'The child must have started before timeout')
        time.sleep(1)
        self.assertFalse(finished.exists(), 'The provider child survived the group timeout')


if __name__=='__main__':unittest.main()
