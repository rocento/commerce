"""Provider contract matrix. Network/SDK calls are forbidden unless mocked."""
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/controller'))
import fleet_providers as p


class ProviderMatrix(unittest.TestCase):
    def setUp(self):
        self.host = dict(id=str(uuid.uuid4()), provider_reference=None, provider_operation=None)
        for target in ('http', 'command'):
            guard = patch.object(p, target, side_effect=AssertionError('Unmocked provider I/O'))
            guard.start()
            self.addCleanup(guard.stop)

    def item(self, provider, **changes):
        if provider == 'aws':
            item = {'InstanceId': 'i-fixture', 'State': {'Name': 'running'},
                    'PublicIpAddress': '192.0.2.1', 'Tags': [{'Key':'rocento-host','Value':self.host['id']}]}
        else:
            item = {'id': '123', 'name': 'merchant-'+self.host['id'], 'labels': {'rocento-host':self.host['id']},
                    'status': 'RUNNING' if provider == 'gcp' else 'running',
                    'networkInterfaces': [{'accessConfigs':[{'natIP':'192.0.2.1'}]}],
                    'public_net': {'ipv4': {'ip':'192.0.2.1'}}}
        return dict(item, **changes)

    def page(self, provider, items, next_page=None):
        if provider == 'aws':
            return {'Reservations':[{'Instances':items}], 'NextToken':next_page}
        if provider == 'gcp':
            return {'items':items, 'nextPageToken':next_page}
        return {'servers':items, 'meta':{'pagination':{'next_page':next_page}}}

    def adapter(self, provider):
        return p.Provider(provider, {}, Mock())

    def call(self, adapter, pages):
        return patch.object(adapter, {'aws':'aws','gcp':'google','hetzner':'hetzner'}[adapter.name], side_effect=pages)

    def test_all_providers_running_and_absent(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[self.item(provider)])]):
                    result = adapter.discover(self.host)
                self.assertTrue(result['running'])
                self.assertEqual(result['address'],'192.0.2.1')
                with self.call(adapter,[self.page(provider,[])]):
                    self.assertIsNone(adapter.discover(self.host))

    def test_subdomain_instance_name_is_verified(self):
        for provider in ('gcp', 'hetzner'):
            adapter = self.adapter(provider)
            host = dict(self.host, instance_name='merchent-acme')
            with self.call(adapter, [self.page(provider, [self.item(provider, name='merchent-acme')])]):
                self.assertTrue(adapter.discover(host)['running'])
            with self.call(adapter, [self.page(provider, [self.item(provider, name='merchent-other')])]):
                with self.assertRaisesRegex(ValueError, 'IDENTITY_CHANGED'):
                    adapter.discover(host)

    def test_all_providers_booting_and_no_address(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                item = self.item(provider)
                if provider == 'aws':
                    item.update(State={'Name':'pending'},PublicIpAddress=None)
                elif provider == 'gcp':
                    item.update(status='PROVISIONING',networkInterfaces=[])
                else:
                    item.update(status='initializing',public_net={'ipv4':None})
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[item])]):
                    result = adapter.discover(self.host)
                self.assertFalse(result['running'])
                self.assertIsNone(result['address'])

    def test_all_providers_terminal_instances_fail(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                item = self.item(provider)
                if provider == 'aws': item['State']['Name']='terminated'
                else: item['status']='TERMINATED' if provider == 'gcp' else 'deleting'
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[item])]), self.assertRaisesRegex(p.ProviderError,'INSTANCE_STOPPED'):
                    adapter.discover(self.host)

    def test_all_providers_follow_empty_first_page(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[],2),self.page(provider,[self.item(provider)])]) as api:
                    self.assertTrue(adapter.discover(self.host)['running'])
                    self.assertEqual(api.call_count,2)

    def test_duplicates_on_later_page_are_rejected(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[self.item(provider)],2),self.page(provider,[self.item(provider)])]), self.assertRaisesRegex(ValueError,'DUPLICATE'):
                    adapter.discover(self.host)

    def test_pagination_loops_fail_closed(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[],2)]*2), self.assertRaisesRegex(ValueError,'PAGINATION_INVALID'):
                    adapter.discover(self.host)

    def test_all_providers_identity_replacement_and_wrong_labels(self):
        for provider in ('aws','gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                with self.call(adapter,[self.page(provider,[self.item(provider)])]), self.assertRaisesRegex(ValueError,'IDENTITY'):
                    adapter.discover(dict(self.host,provider_reference='replaced'))
                item = self.item(provider)
                if provider == 'aws': item['Tags']=[]
                else: item['labels']={}
                with self.call(adapter,[self.page(provider,[item])]), self.assertRaisesRegex(ValueError,'IDENTITY'):
                    adapter.discover(self.host)

    def test_gcp_recreated_same_name_rejected_by_numeric_identity(self):
        adapter = self.adapter('gcp')
        with self.call(adapter,[self.page('gcp',[self.item('gcp',id='124')])]), self.assertRaisesRegex(ValueError,'IDENTITY'):
            adapter.discover(dict(self.host,provider_reference='123'))

    def test_gcp_operation_identity_is_used_when_create_did_not_return_target_id(self):
        adapter = self.adapter('gcp')
        with self.call(adapter,[{'status':'DONE','targetId':'122'},self.page('gcp',[self.item('gcp',id='123')])]), self.assertRaisesRegex(ValueError,'IDENTITY'):
            adapter.discover(dict(self.host,provider_operation='operation'))

    def test_gcp_and_hetzner_pending_and_failed_async_operations(self):
        for provider in ('gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                host = dict(self.host,provider_reference='123',provider_operation='99')
                pending = {'status':'RUNNING'} if provider=='gcp' else {'action':{'status':'running'}}
                failed = {'status':'DONE','error':{'errors':[{'code':'QUOTA_EXCEEDED'}]}} if provider=='gcp' else {'action':{'status':'error'}}
                with self.call(adapter,[pending]) as api:
                    self.assertIsNone(adapter.discover(host))
                    self.assertEqual(api.call_count,1)
                with self.call(adapter,[failed]), self.assertRaisesRegex(p.ProviderError,'CREATE_FAILED'):
                    adapter.discover(host)

    def test_successful_async_operations_proceed_to_discovery(self):
        for provider in ('gcp','hetzner'):
            with self.subTest(provider=provider):
                adapter = self.adapter(provider)
                done = {'status':'DONE','targetId':'123'} if provider=='gcp' else {'action':{'status':'success'}}
                with self.call(adapter,[done,self.page(provider,[self.item(provider)])]):
                    self.assertTrue(adapter.discover(dict(self.host,provider_reference='123',provider_operation='99'))['running'])

    def test_unknown_provider_is_not_treated_as_hetzner(self):
        with self.assertRaisesRegex(ValueError,'INVALID_PROVIDER'):
            self.adapter('other')


class TransportTests(unittest.TestCase):
    def test_http_error_classification_for_reads_and_creates(self):
        for method in ('GET','POST'):
            for status in (400,401,403,404,409,429,500,503):
                with self.subTest(method=method,status=status):
                    opener = Mock()
                    opener.open.side_effect = urllib.error.HTTPError('https://fixture',status,'private provider body',{},None)
                    with patch.object(p.urllib.request,'build_opener',return_value=opener), self.assertRaises(p.ProviderError) as error:
                        p.http(method,'https://fixture','private-token',{})
                    self.assertNotIn('private',str(error.exception))
                    self.assertEqual(error.exception.retryable,status==429 or status>=500)
                    self.assertEqual(error.exception.uncertain,method=='POST' and (status==409 or status==429 or status>=500))

    def test_timeout_and_malformed_response_have_bounded_retry_semantics(self):
        for failure in (TimeoutError(),urllib.error.URLError('private')):
            opener=Mock();opener.open.side_effect=failure
            with patch.object(p.urllib.request,'build_opener',return_value=opener),self.assertRaises(p.ProviderError) as error:
                p.http('POST','https://fixture','private')
            self.assertTrue(error.exception.uncertain)
        opener=Mock();opener.open.return_value.__enter__=Mock(return_value=io.BytesIO(b'not-json'))
        opener.open.return_value.__exit__=Mock(return_value=False)
        with patch.object(p.urllib.request,'build_opener',return_value=opener),self.assertRaises(p.ProviderError) as error:
            p.http('GET','https://fixture','private')
        self.assertTrue(error.exception.retryable)

    def test_aws_permission_rejection_is_definitive_and_sanitized(self):
        result=subprocess.CompletedProcess([],1,b'',b'UnauthorizedOperation private credentials')
        with patch.object(p.subprocess,'run',return_value=result),self.assertRaises(p.ProviderError) as error:
            p.command(['aws'])
        self.assertFalse(error.exception.uncertain)
        self.assertNotIn('private',str(error.exception))

    def test_sdk_timeout_is_uncertain(self):
        with patch.object(p.subprocess,'run',side_effect=subprocess.TimeoutExpired('aws',40)),self.assertRaises(p.ProviderError) as error:
            p.command(['aws'])
        self.assertTrue(error.exception.uncertain)


if __name__ == '__main__': unittest.main()
