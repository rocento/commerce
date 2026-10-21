import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

ROOT = Path(__file__).parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/(name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

server, collector = module('server'), module('collector')
IDENTITY = {'user': {'email': 'info@rocento.com', 'active': True}}

class HealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:'+str(cls.http.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
    def request(self, path, body=None, token=None, origin=server.ORIGIN):
        headers = {'Origin': origin, 'Content-Type': 'application/json'}
        if token:
            headers['Cookie'] = server.COOKIE+'='+token
        req = urllib.request.Request(self.url+path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            r = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            r = e
        with r:
            return r.status, r.headers, r.read()
    def test_anonymous_cannot_read_snapshot(self):
        with patch.object(server, 'upstream') as auth:
            self.assertEqual(self.request('/api/health')[0], 401)
            auth.assert_not_called()
    def test_wrong_account_or_revoked_session_denied(self):
        for identity in [{'user': {'email': 'other@example.com', 'active': True}}, {'user': {'email': 'info@rocento.com', 'active': False}}, {}]:
            with patch.object(server, 'upstream', return_value=(200, identity, [])):
                self.assertEqual(self.request('/api/health', token='test')[0], 401)
    def test_login_uses_existing_auth_and_host_only_secure_cookie(self):
        with patch.object(server, 'upstream', return_value=(200, IDENTITY, ['admin_session=opaque-token; Path=/'])) as auth:
            code, headers, body = self.request('/api/login', {'email': server.ACCOUNT, 'password': 'fixture'})
            self.assertEqual(code, 200)
            self.assertIn('__Host-rocento_health=opaque-token;', headers['Set-Cookie'])
            self.assertIn('Secure;', headers['Set-Cookie'])
            self.assertIn('HttpOnly;', headers['Set-Cookie'])
            self.assertNotIn('Domain=', headers['Set-Cookie'])
            self.assertNotIn(b'opaque-token', body)
            auth.assert_called_once_with('/v1/admin/auth/login', body={'email': server.ACCOUNT, 'password': 'fixture'})
    def test_csrf_and_other_login_account_rejected(self):
        with patch.object(server, 'upstream') as auth:
            self.assertEqual(self.request('/api/login', {}, origin='https://evil.example')[0], 403)
            self.assertEqual(self.request('/api/login', {'email': 'other@example.com', 'password': 'fixture'})[0], 401)
            auth.assert_not_called()
    def test_stale_data_cannot_look_healthy(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'STATE', Path(directory)), patch.object(server, 'upstream', return_value=(200, IDENTITY, [])):
            (Path(directory)/'snapshot.json').write_text(json.dumps({'checked_at': time.time()-181, 'status': 'healthy'}))
            code, headers, body = self.request('/api/health', token='test')
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)['status'], 'unknown')
            self.assertEqual(headers['Cache-Control'], 'no-store')
    def test_auth_outage_is_not_logged_out_or_success(self):
        with patch.object(server, 'upstream', return_value=(503, {}, [])):
            self.assertEqual(self.request('/api/health', token='test')[0], 503)
    def test_logout_revokes_upstream_and_clears_cookie(self):
        with patch.object(server, 'upstream', return_value=(200, {}, [])) as auth:
            code, headers, _ = self.request('/api/logout', {}, token='test')
            self.assertEqual(code, 200)
            self.assertIn('Max-Age=0', headers['Set-Cookie'])
            auth.assert_called_once_with('/v1/admin/auth/logout', 'test', {})
    def test_incident_retains_start_and_records_recovery(self):
        bad = [{'id': 'worker', 'ok': False, 'detail': 'Worker unhealthy'}]
        first = collector.incidents({}, bad, 10)
        ongoing = collector.incidents({'incidents': first}, bad, 20)
        self.assertEqual(ongoing[0]['started_at'], 10)
        recovered = collector.incidents({'incidents': ongoing}, [dict(bad[0], ok=True)], 30)
        self.assertEqual(recovered[0]['resolved_at'], 30)
    def test_metric_parser_rejects_non_finite_and_comments(self):
        self.assertEqual(collector.metrics('# HELP hi\nfoo 1\nbar NaN\nbaz +Inf\nx nope'), {'foo': 1})
    def test_no_arbitrary_paths(self):
        self.assertEqual(self.request('/../../server.py')[0], 404)

class PublisherHealthTests(unittest.TestCase):
    def sample(self, data=None, lines='', sql_error=False, log_error=False):
        from subprocess import CompletedProcess, CalledProcessError
        data = data or {'pending': 0, 'oldest_seconds': 0, 'retrying': 0}
        with patch.object(collector, 'run', side_effect=CalledProcessError(1, 'psql') if sql_error else None,
                          return_value=json.dumps(data)), patch.object(collector.subprocess, 'run',
                          side_effect=CalledProcessError(1, 'docker') if log_error else None,
                          return_value=CompletedProcess([], 0, '', lines)):
            return collector.engagement_publisher('grocery')

    def test_idle_healthy_publisher(self):
        self.assertEqual(self.sample()['status'], 'healthy')

    def test_original_missing_columns_defect_is_unknown_even_when_idle(self):
        p = self.sample(sql_error=True)
        self.assertEqual(p['status'], 'unknown')
        self.assertIsNone(p['pending'])
        self.assertIn('retry columns', p['reasons'][0])

    def test_reconnect_warning_fails_with_empty_queue(self):
        line = json.dumps({'fields': {'message': 'outbox publisher reconnecting; events remain durable', 'secret': 'never-return'}})
        p = self.sample(lines=line)
        self.assertEqual(p['status'], 'attention')
        self.assertEqual(p['reconnect_warnings'], 1)
        self.assertNotIn('never-return', json.dumps(p))

    def test_delivery_failure_and_retry_are_detected(self):
        line = json.dumps({'fields': {'message': 'outbox delivery deferred; event retained'}})
        p = self.sample({'pending': 1, 'oldest_seconds': 5, 'retrying': 1}, line)
        self.assertEqual(p['status'], 'attention')
        self.assertEqual(p['delivery_warnings'], 1)

    def test_old_backlog_fails_but_fresh_work_is_allowed(self):
        for seconds, status in [(5, 'healthy'), (119, 'healthy'), (120, 'attention')]:
            self.assertEqual(self.sample({'pending': 1, 'oldest_seconds': seconds, 'retrying': 0})['status'], status)

    def test_diagnostics_failure_cannot_look_healthy(self):
        self.assertEqual(self.sample(log_error=True)['status'], 'unknown')
        self.assertEqual(self.sample(lines='unrecognized log format')['status'], 'unknown')
        self.assertEqual(self.sample(lines='{}\n'*2000)['status'], 'unknown')

    def test_functional_health_overrides_healthy_container_and_recovers(self):
        store = {'name': 'grocery', 'engagement_publisher': self.sample(sql_error=True)}
        containers = [{'name': 'rocento-grocery-engagement-worker-1', 'status': 'healthy'}]
        collector.apply_publisher_health(containers, [store])
        self.assertEqual(containers[0]['status'], 'publisher unknown')
        self.assertEqual(containers[0]['docker_status'], 'healthy')
        self.assertEqual(sum(c['status'] == 'healthy' for c in containers), 0)
        failed = [{'id': 'grocery:engagement-publisher', 'ok': False, 'detail': 'Publisher unavailable'}]
        history = collector.incidents({}, failed, 1)
        store['engagement_publisher'] = self.sample()
        fresh = [{'name': 'rocento-grocery-engagement-worker-1', 'status': 'healthy'}]
        collector.apply_publisher_health(fresh, [store])
        self.assertEqual(fresh[0]['status'], 'healthy')
        recovered = collector.incidents({'incidents': history}, [dict(failed[0], ok=True)], 2)
        self.assertEqual(recovered[0]['resolved_at'], 2)

    def test_stopped_container_never_becomes_healthy(self):
        containers = [{'name': 'rocento-grocery-engagement-worker-1', 'status': 'exited'}]
        collector.apply_publisher_health(containers, [{'name': 'grocery', 'engagement_publisher': self.sample()}])
        self.assertEqual(containers[0]['status'], 'exited')

class OtherWorkerTests(unittest.TestCase):
    def consumers(self, pending=0, ack=5):
        return {'account_details': [{'stream_detail': [{'name': 'COMMERCE_EVENTS', 'consumer_detail': [
            {'name': name, 'created': 'fixture', 'num_pending': pending, 'num_ack_pending': 0,
             'num_redelivered': 0, 'ack_floor': {'stream_seq': ack}}
            for name in ('cart-analytics-v1', 'order-facts-v1')]}]}]}
    def analytics(self, pending=0, previous=None, now=1000, logs=0, data=None, metrics=None, ack=5):
        with patch.object(collector.time, 'time', return_value=now), patch.object(collector, 'worker_log_failures', return_value=logs), patch.object(collector, 'run', return_value=json.dumps(self.consumers(pending, ack) if data is None else data)):
            return collector.analytics_health('grocery', metrics if metrics is not None else {'commerce_analytics_worker_ready': 1, 'commerce_reporting_last_success_seconds': now}, previous, now-60)
    def test_retry_logs_fail_even_with_ready_and_idle(self):
        self.assertEqual(self.analytics(logs=1)['status'], 'attention')
    def test_idle_consumer_is_not_stalled(self):
        self.assertEqual(self.analytics()['status'], 'healthy')
    def test_backlog_without_progress_fails_then_recovers(self):
        first = self.analytics(pending=2)
        self.assertEqual(first['status'], 'healthy')
        second = self.analytics(pending=2, previous=first, now=1060)
        failed = self.analytics(pending=2, previous=second, now=1120)
        self.assertEqual(failed['status'], 'attention')
        self.assertEqual(self.analytics(pending=2, previous=failed, now=1180, ack=6)['status'], 'healthy')
        self.assertEqual(self.analytics(previous=failed, now=1180)['status'], 'healthy')
    def test_missing_and_unavailable_consumer_diagnostics(self):
        self.assertEqual(self.analytics(data={})['status'], 'attention')
        with patch.object(collector, 'run', side_effect=TimeoutError), patch.object(collector, 'worker_log_failures', return_value=0):
            self.assertEqual(collector.analytics_health('grocery', {})['status'], 'unknown')
    def test_stale_reporting_is_not_healthy(self):
        self.assertEqual(self.analytics(now=10000, metrics={'commerce_analytics_worker_ready':1, 'commerce_reporting_last_success_seconds':1})['status'], 'attention')
    def exports(self, active_failed=0, failed=0, stalled=0, logs=0, probe=True):
        def command(args, **kwargs):
            if '--health' in args:
                if not probe: raise TimeoutError()
                return ''
            return json.dumps({'queued':0,'running':0,'failed':failed,'active_failed':active_failed,'stalled':stalled})
        with patch.object(collector, 'run', side_effect=command), patch.object(collector, 'worker_log_failures', return_value=logs):
            return collector.export_health('grocery')
    def test_failed_jobs_and_spool_errors_override_live_heartbeat(self):
        self.assertEqual(self.exports(active_failed=1, failed=1)['status'], 'attention')
        self.assertEqual(self.exports(logs=1)['status'], 'attention')
        self.assertEqual(self.exports(stalled=1)['status'], 'attention')
    def test_expired_failure_history_does_not_permanently_alert(self):
        self.assertEqual(self.exports(failed=10)['status'], 'healthy')
    def test_export_probe_and_unknown_diagnostics(self):
        self.assertEqual(self.exports(probe=False)['status'], 'attention')
        with patch.object(collector, 'run', side_effect=TimeoutError), patch.object(collector, 'worker_log_failures', return_value=0):
            self.assertEqual(collector.export_health('grocery')['status'], 'unknown')
    def test_export_plaintext_failures_are_sanitized(self):
        from subprocess import CompletedProcess
        with patch.object(collector.subprocess, 'run', return_value=CompletedProcess([],0,'','Spool cleanup: secret-path\nExport queue: secret-url\nExport fixture failed: secret-payload')):
            self.assertEqual(collector.worker_log_failures('grocery','export-worker'),3)
    def test_all_worker_functional_failures_override_docker(self):
        cs=[{'name':f'rocento-grocery-{w}-worker-1','status':'healthy'} for w in ('analytics','export')]
        collector.apply_publisher_health(cs,[{'name':'grocery','analytics_health':{'status':'attention'},'export_health':{'status':'unknown'}}])
        self.assertEqual([c['status'] for c in cs],['analytics attention','export unknown'])

class GatewayAITests(unittest.TestCase):
    def gateway(self, logs=0, retrying=0, queue_ok=True, consumers_ok=True):
        with patch.object(collector, 'worker_log_failures', return_value=logs), patch.object(collector, 'event_consumers', return_value={'complete':consumers_ok,'consumers':[],'reasons':[] if consumers_ok else ['Consumer diagnostics unavailable']}):
            return collector.gateway_health('grocery',[{'id':'grocery:outbox','ok':queue_ok}],{'commerce_reliability_sample_success':1,'commerce_outbox_retrying':retrying})
    def test_gateway_background_failures_override_readiness(self):
        self.assertEqual(self.gateway()['status'],'healthy')
        self.assertEqual(self.gateway(logs=1)['status'],'attention')
        self.assertEqual(self.gateway(retrying=1)['status'],'attention')
        self.assertEqual(self.gateway(queue_ok=False)['status'],'attention')
        self.assertEqual(self.gateway(consumers_ok=False)['status'],'unknown')
    def ai(self, override=None, logs=0):
        probe={'ready':True,'language_ready':True,'storage_ready':True,'model_available':True,'provider_enabled':True,'language_self_check':True}
        probe.update(override or {})
        with patch.object(collector, 'run', return_value=json.dumps(probe)), patch.object(collector,'ai_log_failures',return_value=logs):
            return collector.ai_health('grocery')
    def test_ai_dependencies_and_model_failure_override_ready(self):
        self.assertEqual(self.ai()[0]['status'],'healthy')
        self.assertEqual(self.ai({'storage_ready':False})[0]['status'],'attention')
        self.assertEqual(self.ai({'model_available':False})[0]['status'],'attention')
        self.assertEqual(self.ai({'language_self_check':False})[1]['status'],'attention')
        self.assertEqual(self.ai(logs=1)[0]['status'],'attention')
    def test_intentionally_disabled_provider_is_not_an_outage(self):
        health,_=self.ai({'provider_enabled':False,'model_available':False})
        self.assertEqual(health['status'],'healthy')
        self.assertEqual(health['provider'],'disabled')
    def test_unavailable_ai_diagnostics_are_unknown(self):
        self.assertEqual(self.ai({'probe_unavailable':True})[0]['status'],'unknown')
        self.assertEqual(self.ai({'provider_unknown':True})[0]['status'],'unknown')
        self.assertEqual(self.ai({'language_probe_unavailable':True})[1]['status'],'unknown')
    def test_ai_turn_failures_and_5xx_are_counted_without_payloads(self):
        from subprocess import CompletedProcess
        lines=[json.dumps({'event':'assistant_turn','outcome':'completed','timings':{'provider_errors':1},'secret':'private'}),
               json.dumps({'event':'assistant_turn','outcome':'unavailable'}),
               'INFO: client - "POST /v1/chat HTTP/1.1" 503 Service Unavailable',
               json.dumps({'event':'assistant_turn','outcome':'denied'}),
               'INFO: client - "GET /ready HTTP/1.1" 200 OK']
        with patch.object(collector.subprocess,'run',return_value=CompletedProcess([],0,'\n'.join(lines),'')):
            self.assertEqual(collector.ai_log_failures('grocery','ai-service'),3)
    def test_unknown_ai_log_format_fails_closed(self):
        from subprocess import CompletedProcess
        with patch.object(collector.subprocess,'run',return_value=CompletedProcess([],0,'opaque diagnostic','')):
            with self.assertRaises(ValueError): collector.ai_log_failures('grocery','ai-service')
    def test_gateway_and_ai_effective_health(self):
        cs=[{'name':'rocento-grocery-'+w+'-1','status':'healthy'} for w in ('api-gateway','ai-service','commerce-language-engine')]
        collector.apply_publisher_health(cs,[{'name':'grocery','gateway_health':{'status':'attention'},'ai_health':{'status':'unknown'},'language_health':{'status':'attention'}}])
        self.assertEqual([c['status'] for c in cs],['gateway attention','AI unknown','language attention'])


class InfrastructureTests(unittest.TestCase):
    def pg(self, **changes):
        values=dict(recovery=False,default_read_only=False,connections=10,max_connections=100,blocked=0,idle_transactions=0,xid_age=100)
        values.update(changes)
        with patch.object(collector,'run',return_value='SET\nBEGIN\n'+json.dumps(values)):
            return collector.postgres_health('db')
    def test_database_hidden_failures(self):
        self.assertEqual(self.pg()['status'],'healthy')
        for values in ({'recovery':True},{'default_read_only':True},{'connections':85},{'blocked':1},{'idle_transactions':1},{'xid_age':1_000_000_000}):
            with self.subTest(values=values): self.assertEqual(self.pg(**values)['status'],'attention')
    def test_database_unavailable_does_not_leak_errors(self):
        with patch.object(collector,'run',side_effect=RuntimeError('secret')):
            result=collector.postgres_health('db')
        self.assertEqual(result['status'],'unknown'); self.assertNotIn('secret',json.dumps(result))
    def test_volume_capacity_inodes_and_read_only(self):
        from types import SimpleNamespace
        info={'Mounts':[{'Destination':'/data','Source':'/private','RW':True}]}
        defaults=dict(f_blocks=100,f_bavail=50,f_files=100,f_favail=50,f_flag=0)
        for changes in ({},{'f_bavail':10},{'f_favail':10},{'f_flag':collector.os.ST_RDONLY}):
            with patch.object(collector.os,'statvfs',return_value=SimpleNamespace(**(defaults|changes))), patch.object(collector,'container_mount_read_only',return_value=bool(changes.get('f_flag',0))):
                result=collector.with_volume({'status':'healthy','reasons':[]},info,'/data')
                self.assertEqual(result['status'],'attention' if changes else 'healthy')
        self.assertEqual(collector.with_volume({'status':'healthy','reasons':[]},{'Mounts':[]},'/data')['status'],'unknown')
    def test_mount_namespace_uses_container_not_collector(self):
        info={'State':{'Pid':123},'Mounts':[{'Destination':'/data','Source':'/host/data','RW':True}]}
        from types import SimpleNamespace
        stats=SimpleNamespace(f_blocks=100,f_bavail=50,f_files=100,f_favail=50,f_flag=collector.os.ST_RDONLY)
        for options,expected in (('rw',False),('ro',True)):
            text='1 0 1:1 / / rw - ext4 /dev/root rw\n2 1 1:1 /vol /data '+options+' - ext4 /dev/root rw\n'
            with patch.object(collector.Path,'read_text',return_value=text),patch.object(collector.os,'statvfs',return_value=stats):
                self.assertEqual(collector.container_mount_read_only(info,'/data'),expected)
                self.assertEqual(bool(collector.volume_health(info,'/data')[1]),expected)
        with patch.object(collector.Path,'read_text',side_effect=PermissionError):
            result=collector.with_volume({'status':'healthy','reasons':[]},info,'/data')
        self.assertEqual(result['status'],'unknown')

    def infrastructure(self, **changes):
        from unittest.mock import MagicMock
        services=('postgres','engagement-postgres','clickhouse','nats','minio','meilisearch','api-gateway')
        env=['S3_ENDPOINT=http://minio:9000','S3_ACCESS_KEY=test-access','S3_SECRET_KEY=test-secret','MEILI_URL=http://meilisearch:7700','MEILI_MASTER_KEY=test-master']
        infos=[{'Name':'/rocento-grocery-'+name+'-1','Config':{'Env':env},'NetworkSettings':{'Networks':{'default':{'IPAddress':'127.0.0.1'}}}} for name in services]
        stream={'name':'COMMERCE_EVENTS','config':{'storage':'file','subjects':['commerce.>'],'max_bytes':-1,'max_msgs':-1},'state':{'bytes':10,'messages':2},'cluster':{'leader':'server'}}
        if changes.get('volatile'): stream['config']['storage']='memory'
        if changes.get('sealed'): stream['config']['sealed']=True
        if changes.get('lost'): stream['state']['lost']={'msgs':1}
        if changes.get('limit'): stream['config']['max_bytes']=10
        if changes.get('leader'): stream['cluster']={}
        nats={'account_details':[{'stream_detail':[] if changes.get('missing_stream') else [stream]}],'storage':10,'config':{'max_storage':1000}}
        ch=dict(required_tables=2,failed_mutations=0,stalled_mutations=0,detached_parts=0); ch.update(changes.get('ch',{}))
        def run(args,timeout=10):
            if args[1]=='inspect': return json.dumps(infos)
            return json.dumps(nats if 'wget' in args else ch)
        requests=[]
        def urlopen(req,timeout=3):
            requests.append(req)
            if changes.get('denied') and req.get_method()=='HEAD': raise urllib.error.HTTPError(req.full_url,403,'Forbidden',{},None)
            if '/stats' in req.full_url: data={'indexes':{} if changes.get('no_indexes') else {'products':{}}}
            elif 'statuses=failed' in req.full_url: data={'total':1 if changes.get('failed_task') else 0}
            elif 'statuses=enqueued' in req.full_url:
                data={'total':1 if changes.get('stalled') else 0,'results':[{'enqueuedAt':'2020-01-01T00:00:00Z'}] if changes.get('stalled') else []}
            else: data={}
            response=MagicMock(); response.__enter__.return_value.read.return_value=json.dumps(data).encode(); return response
        with patch.object(collector,'run',side_effect=run),patch.object(collector,'postgres_health',return_value={'status':'healthy','reasons':[]}),patch.object(collector,'with_volume',side_effect=lambda h,*_:h),patch.object(collector.urllib.request,'urlopen',side_effect=urlopen):
            result=collector.infrastructure_health('grocery')
        self.assertTrue(all(req.get_method() in ('GET','HEAD') for req in requests))
        self.assertNotIn('test-secret',json.dumps(result)); self.assertNotIn('test-master',json.dumps(result))
        return result
    def test_healthy_infrastructure_and_authenticated_bucket(self):
        result=self.infrastructure()
        self.assertTrue(all(h['status']=='healthy' for h in result.values()))
        self.assertTrue(result['minio']['bucket_access'])
    def test_jetstream_hidden_failures(self):
        for key in ('volatile','sealed','lost','limit','leader'):
            with self.subTest(key=key): self.assertEqual(self.infrastructure(**{key:True})['nats']['status'],'attention')
        self.assertEqual(self.infrastructure(missing_stream=True)['nats']['status'],'unknown')
    def test_clickhouse_hidden_failures(self):
        for key,value in (('required_tables',1),('failed_mutations',1),('stalled_mutations',1),('detached_parts',1)):
            self.assertEqual(self.infrastructure(ch={key:value})['clickhouse']['status'],'attention')
    def test_storage_auth_and_indexing_failures(self):
        self.assertEqual(self.infrastructure(denied=True)['minio']['status'],'unknown')
        for key in ('no_indexes','failed_task','stalled'):
            self.assertEqual(self.infrastructure(**{key:True})['meilisearch']['status'],'attention')
    def test_infrastructure_overrides_container_and_shared_health(self):
        cs=[{'name':'rocento-grocery-nats-1','status':'healthy'},{'name':'rocento-ai-shared-ai-postgres-1','status':'healthy'}]
        collector.apply_infrastructure_health(cs,[{'name':'grocery','infrastructure_health':{'nats':{'status':'attention'}}}],{'status':'unknown'})
        self.assertEqual([c['status'] for c in cs],['infrastructure attention','infrastructure unknown'])
        self.assertTrue(all(c['docker_status']=='healthy' for c in cs))

if __name__ == '__main__':
    unittest.main()
