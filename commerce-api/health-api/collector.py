#!/usr/bin/env python3
"""Read-only production health sampler. Only sanitized summaries leave this process."""
import datetime
import hashlib
import hmac
import urllib.parse
import concurrent.futures
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(os.environ.get('HEALTH_STATE_DIR', '/var/lib/rocento-health'))
STORES = {'grocery': 8080, 'jewelry': 58080, 'electronics': 59080, 'pharmacy': 60080}
SERVICES = ('api-gateway', 'analytics-worker', 'engagement-worker', 'export-worker',
            'postgres', 'engagement-postgres', 'clickhouse', 'nats', 'meilisearch', 'minio',
            'ai-service', 'commerce-language-engine', 'assistant-ingress', 'assistant-tools', 'assistant-provider')
SHARED = ('rocento-ai-shared-ai-postgres-1', 'rocento-rengine-rengine-1')

def run(args, timeout=10):
    return subprocess.check_output(args, text=True, timeout=timeout, stderr=subprocess.DEVNULL).strip()

def metrics(text):
    result = {}
    for line in text.splitlines():
        if line and not line.startswith('#'):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    value = float(parts[1])
                    if value == value and abs(value) != float('inf'):
                        result[parts[0]] = value
                except ValueError:
                    pass
    return result

def http(url, host=None):
    req = urllib.request.Request(url, headers={'Host': host} if host else {})
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.read(2_000_000).decode()

def public_check(host):
    start = time.monotonic()
    try:
        code = int(run(['curl', '-sS', '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://' + host], 10))
        return {'host': host, 'ok': code == 200, 'code': code, 'ms': round((time.monotonic()-start)*1000)}
    except Exception:
        return {'host': host, 'ok': False, 'code': 0, 'ms': None}

def engagement_publisher(store):
    """No events are emitted: inspect the publisher schema, backlog and diagnostics."""
    result = {'status': 'unknown', 'pending': None, 'oldest_seconds': None,
              'retrying': None, 'reconnect_warnings': None, 'delivery_warnings': None,
              'log_window_seconds': 120, 'reasons': []}
    try:
        # Selecting these columns detects the original defect even with an empty queue.
        query = """SET statement_timeout='2000ms'; SET default_transaction_read_only=on;
        SELECT json_build_object('pending',count(*),
          'oldest_seconds',COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0),
          'retrying',count(*) FILTER(WHERE attempts>0 OR last_error IS NOT NULL),
          'scheduled',count(*) FILTER(WHERE available_at>now()),
          'attempted',count(last_attempt_at))
        FROM platform.outbox WHERE published_at IS NULL;"""
        raw = run(['docker', 'exec', f'rocento-{store}-engagement-postgres-1', 'sh', '-c',
                   'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'sh', query], timeout=5)
        data = json.loads(raw.splitlines()[-1])
        result.update({key: max(0, int(data[key])) for key in ('pending', 'oldest_seconds', 'retrying')})
    except Exception:
        result['reasons'].append('Outbox schema/database check unavailable (retry columns required)')
    try:
        logs = subprocess.run(['docker', 'logs', '--since', '120s', '--tail', '2000',
                               f'rocento-{store}-engagement-worker-1'],
                              capture_output=True, text=True, timeout=5, check=True)
        lines = (logs.stdout + '\n' + logs.stderr).splitlines()
        if len([line for line in lines if line]) >= 2000:
            raise ValueError('Incomplete log window')
        counts = {'reconnect_warnings': 0, 'delivery_warnings': 0}
        for line in lines:
            if not line.strip():
                continue
            # The deployed publisher uses structured JSON logs. Unknown formats
            # cannot establish a clean diagnostic window; never expose raw lines.
            entry = json.loads(line)
            message = entry.get('fields', {}).get('message', '')
            if message == 'outbox publisher reconnecting; events remain durable':
                counts['reconnect_warnings'] += 1
            elif message == 'outbox delivery deferred; event retained':
                counts['delivery_warnings'] += 1
        result.update(counts)
    except Exception:
        result['reasons'].append('Publisher diagnostics unavailable or incomplete')
    if result['retrying']:
        result['reasons'].append('Engagement events awaiting retry')
    if result['oldest_seconds'] is not None and result['oldest_seconds'] >= 120:
        result['reasons'].append('Engagement outbox backlog exceeds two minutes')
    if result['reconnect_warnings'] or result['delivery_warnings']:
        result['reasons'].append('Publisher failures observed in the last two minutes')
    complete = all(result[k] is not None for k in ('pending', 'oldest_seconds', 'retrying', 'reconnect_warnings', 'delivery_warnings'))
    result['status'] = ('attention' if result['reasons'] else 'healthy') if complete else 'unknown'
    return result


def worker_log_failures(store, worker):
    logs = subprocess.run(['docker', 'logs', '--since', '120s', '--tail', '2000',
                           f'rocento-{store}-{worker}-1'], capture_output=True,
                          text=True, timeout=5, check=True)
    lines = [line for line in (logs.stdout+'\n'+logs.stderr).splitlines() if line.strip()]
    if len(lines) >= 2000:
        raise ValueError('Incomplete diagnostics')
    failures = 0
    for line in lines:
        if worker == 'export-worker':
            if line.startswith(('Export queue:', 'Spool cleanup:')) or (line.startswith('Export ') and ' failed:' in line):
                failures += 1
                continue
        entry = json.loads(line)
        if entry.get('level') in ('WARN', 'WARNING', 'ERROR'):
            failures += 1
    return failures


def event_consumers(store, names, previous=None, previous_at=0):
    now = time.time()
    result = {'consumers': [], 'reasons': []}
    complete = True
    try:
        data = json.loads(run(['docker', 'exec', f'rocento-{store}-nats-1', 'wget', '-qO-', '-T', '3',
                              'http://localhost:8222/jsz?accounts=true&streams=true&consumers=true'], timeout=5))
        consumers = {c['name']: c for a in data.get('account_details', []) for s in a.get('stream_detail', [])
                     if s.get('name') == 'COMMERCE_EVENTS' for c in s.get('consumer_detail', [])}
        old = {c['name']: c for c in (previous or {}).get('consumers', [])} if 0 < now-previous_at < 180 else {}
        for name in names:
            if name not in consumers:
                result['reasons'].append(name + ': required consumer missing')
                continue
            c = consumers[name]
            pending = int(c['num_pending']) + int(c['num_ack_pending'])
            ack = int(c['ack_floor']['stream_seq'])
            prior = old.get(name, {})
            # Recreated/reset consumers or monitoring gaps start a new observation.
            same = prior.get('created') == c['created'] and prior.get('ack') == ack and prior.get('pending', 0) > 0
            since = prior.get('stalled_since', now) if pending and same else now if pending else None
            stalled = pending > 0 and now-since >= 120
            redelivered = int(c['num_redelivered'])
            result['consumers'].append({'name': name, 'pending': pending, 'ack': ack, 'created': c['created'],
                                        'stalled_since': since, 'stalled': stalled, 'redelivered': redelivered})
            if stalled:
                result['reasons'].append(name + ': no acknowledged progress for two minutes with backlog')
            if redelivered:
                result['reasons'].append(name + ': unacknowledged redeliveries')
    except Exception:
        complete = False
        result['reasons'].append('Event consumer diagnostics unavailable')
    result['complete'] = complete
    return result


def analytics_health(store, metric_values, previous=None, previous_at=0):
    now = time.time()
    result = {'status': 'unknown', 'recent_failures': None, 'consumers': [], 'reasons': []}
    complete = True
    if metric_values is None or not all(k in metric_values for k in ('commerce_analytics_worker_ready', 'commerce_reporting_last_success_seconds')):
        complete = False
        result['reasons'].append('Analytics readiness/reporting diagnostics unavailable')
    else:
        age = now-metric_values['commerce_reporting_last_success_seconds']
        if metric_values['commerce_analytics_worker_ready'] != 1:
            result['reasons'].append('Analytics dependency or task readiness failed')
        if age < -60 or age >= 3600:
            result['reasons'].append('Reporting snapshot is stale or has an invalid timestamp')
    try:
        result['recent_failures'] = worker_log_failures(store, 'analytics-worker')
        if result['recent_failures']:
            result['reasons'].append('Analytics warnings/errors in the last two minutes')
    except Exception:
        complete = False
        result['reasons'].append('Analytics logs unavailable or incomplete')
    consumers = event_consumers(store, ('cart-analytics-v1', 'order-facts-v1'), previous, previous_at)
    result['consumers'] = consumers['consumers']
    result['reasons'].extend(consumers['reasons'])
    complete = complete and consumers['complete']
    result['status'] = ('attention' if result['reasons'] else 'healthy') if complete else 'unknown'
    return result


def export_health(store):
    result = {'status': 'unknown', 'recent_failures': None, 'jobs': None, 'probe': None, 'reasons': []}
    complete = True
    try:
        query = """SET statement_timeout='2000ms'; SET default_transaction_read_only=on;
        SELECT json_build_object('queued',count(*) FILTER(WHERE status='queued'),
        'running',count(*) FILTER(WHERE status='running'), 'failed',count(*) FILTER(WHERE status='failed'),
        'active_failed',count(*) FILTER(WHERE status='failed' AND expires_at>now()),
        'stalled',count(*) FILTER(WHERE (status='running' AND COALESCE(heartbeat_at,created_at)<now()-interval '10 minutes')
        OR (status='queued' AND created_at<now()-interval '10 minutes')))
        FROM admin_iam.export_jobs;"""
        raw = run(['docker', 'exec', f'rocento-{store}-postgres-1', 'sh', '-c',
                   'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'sh', query], timeout=5)
        jobs = json.loads(raw.splitlines()[-1])
        result['jobs'] = {key: int(jobs[key]) for key in ('queued', 'running', 'failed', 'active_failed', 'stalled')}
        if jobs['active_failed']:
            result['reasons'].append('Unexpired failed export jobs require review')
        if jobs['stalled']:
            result['reasons'].append('Queued/running exports stalled for ten minutes')
    except Exception:
        complete = False
        result['reasons'].append('Export queue/schema diagnostics unavailable')
    try:
        run(['docker', 'exec', f'rocento-{store}-export-worker-1', 'export-worker', '--health'], timeout=5)
        result['probe'] = True
    except Exception:
        result['probe'] = False
        result['reasons'].append('Live export heartbeat/database probe failed')
    try:
        result['recent_failures'] = worker_log_failures(store, 'export-worker')
        if result['recent_failures']:
            result['reasons'].append('Export queue, job or spool failures in the last two minutes')
    except Exception:
        complete = False
        result['reasons'].append('Export logs unavailable or incomplete')
    result['status'] = ('attention' if result['reasons'] else 'healthy') if complete else 'unknown'
    return result


def gateway_health(store, base_checks, metric_values, previous=None, previous_at=0):
    result = {'status': 'unknown', 'recent_failures': None, 'retrying': None, 'consumers': [], 'reasons': []}
    complete = metric_values is not None
    if not all(c['ok'] for c in base_checks if c['id'].endswith((':gateway', ':catalog', ':queue-sampling', ':outbox', ':notifications', ':notification-failures', ':metrics'))):
        result['reasons'].append('Commerce readiness, catalog or queue checks failed')
    if metric_values is None or metric_values.get('commerce_reliability_sample_success') != 1:
        complete = False
        result['reasons'].append('Gateway queue diagnostics unavailable')
    else:
        result['retrying'] = int(metric_values.get('commerce_outbox_retrying', 0))
        if result['retrying']:
            result['reasons'].append('Commerce events awaiting publication retry')
    try:
        result['recent_failures'] = worker_log_failures(store, 'api-gateway')
        if result['recent_failures']:
            result['reasons'].append('Gateway background/request warnings or errors in the last two minutes')
    except Exception:
        complete = False
        result['reasons'].append('Gateway logs unavailable or incomplete')
    consumers = event_consumers(store, ('catalog-search-v2', 'shipment-notifications-v1', 'shipment-notifications-v2'), previous, previous_at)
    result['consumers'] = consumers['consumers']
    result['reasons'].extend(consumers['reasons'])
    complete = complete and consumers['complete']
    result['status'] = ('attention' if result['reasons'] else 'healthy') if complete else 'unknown'
    return result


# Executed inside the AI container. Outputs allowlisted states only, never config or keys.
AI_PROBE = r'''
import json,os,pathlib,urllib.request,urllib.error

def get(url):
 try:
  response=urllib.request.urlopen(url,timeout=2)
 except urllib.error.HTTPError as e:
  response=e
 with response:
  return json.loads(response.read(8192))
result={}
try:
 d=get('http://127.0.0.1:8000/ready')
 result['ready']=d.get('status')=='ready'
 result['language_ready']=d.get('components',{}).get('language')=='ready'
 result['storage_ready']=d.get('components',{}).get('storage')=='ready'
 result['model_available']=d.get('recommendations')=='catalog-backed'
except Exception:
 result['probe_unavailable']=True
try:
 path=os.environ.get('AI_PROVIDER_SETTINGS_FILE','')
 if not path: raise ValueError()
 if not pathlib.Path(path).exists():
  result['provider_enabled']=False
 else:
  d=json.loads(pathlib.Path(path).read_text())
  if type(d.get('enabled')) is not bool or d.get('tenant')!=os.environ.get('ASSISTANT_TENANT_ID'): raise ValueError()
  result['provider_enabled']=d['enabled']
except Exception:
 result['provider_unknown']=True
try:
 d=get(os.environ['AI_LANGUAGE_ENGINE_URL'].rstrip('/')+'/api/ready')
 result['language_self_check']=d.get('status')=='ok' and d.get('resolutionContractVersion')==1 and d.get('dictionaryVersion',0)>0 and d.get('intents',0)>0
except Exception:
 result['language_probe_unavailable']=True
print(json.dumps(result))
'''


def ai_log_failures(store, service):
    logs = subprocess.run(['docker', 'logs', '--since', '120s', '--tail', '2000', f'rocento-{store}-{service}-1'],
                          capture_output=True, text=True, timeout=5, check=True)
    lines = [line for line in (logs.stdout+'\n'+logs.stderr).splitlines() if line.strip()]
    if len(lines) >= 2000:
        raise ValueError('Incomplete diagnostics')
    failures = 0
    for line in lines:
        try:
            d = json.loads(line)
            if not isinstance(d, dict): raise ValueError()
            timings = d.get('timings', {})
            failed = d.get('level', '').upper() in ('ERROR', 'WARN', 'WARNING')
            if d.get('event') == 'assistant_turn':
                failed |= d.get('outcome') in ('unavailable', 'failed', 'error') or any(timings.get(k, 0)>0 for k in ('provider_errors','tool_errors','retrieval_errors','history_errors','persistence_errors'))
            failures += bool(failed)
        except (ValueError, TypeError, AttributeError):
            # Uvicorn access/server logs and Node stack traces are plaintext.
            if re.search(r'\b(ERROR|WARNING|WARN)\b|Traceback \(most recent call last\)|\b\w*Error:|Session cleanup failed|HTTP/1\.[01]" 5\d\d', line):
                failures += 1
            elif re.search(r'^\s*(INFO:|DEBUG:|Commerce inspector:|at |File |\^|During handling|The above exception)', line):
                continue
            else:
                raise ValueError('Unrecognized log format')
    return failures


def ai_health(store):
    result = {'status':'unknown','recent_failures':None,'provider':'unknown','reasons':[]}
    language = {'status':'unknown','recent_failures':None,'reasons':[]}
    complete = language_complete = True
    try:
        probe = json.loads(run(['docker','exec',f'rocento-{store}-ai-service-1','python','-c',AI_PROBE], timeout=8))
        if probe.get('probe_unavailable') or probe.get('provider_unknown'):
            complete = False
            result['reasons'].append('AI readiness/provider configuration diagnostics unavailable')
        else:
            if not all(probe.get(k) for k in ('ready','language_ready','storage_ready')):
                result['reasons'].append('AI language or durable storage readiness failed')
            result['provider'] = 'configured' if probe.get('provider_enabled') and probe.get('model_available') else 'unavailable' if probe.get('provider_enabled') else 'disabled'
            if result['provider']=='unavailable':
                result['reasons'].append('Enabled model provider is unavailable')
        if probe.get('language_probe_unavailable'):
            language_complete = False
            language['reasons'].append('Language self-check unavailable')
        elif not probe.get('language_self_check'):
            language['reasons'].append('Language parsing/contract self-check failed')
    except Exception:
        complete = language_complete = False
        result['reasons'].append('AI probe unavailable')
        language['reasons'].append('Language probe unavailable')
    for service, health in (('ai-service', result), ('commerce-language-engine', language)):
        try:
            health['recent_failures'] = ai_log_failures(store, service)
            if health['recent_failures']:
                health['reasons'].append('Runtime/turn failures in the last two minutes')
        except Exception:
            if service=='ai-service': complete = False
            else: language_complete = False
            health['reasons'].append('Runtime logs unavailable or incomplete')
    result['status'] = ('attention' if result['reasons'] else 'healthy') if complete else 'unknown'
    language['status'] = ('attention' if language['reasons'] else 'healthy') if language_complete else 'unknown'
    return result, language



def health_result(probe):
    """Keep diagnostics failures explicit and never serialize exception/credential text."""
    try:
        values, reasons = probe()
        return dict(values, status='attention' if reasons else 'healthy', reasons=reasons)
    except Exception:
        return {'status': 'unknown', 'reasons': ['Read-only infrastructure diagnostics unavailable']}


def postgres_health(name):
    def probe():
        query = """SET statement_timeout='2000ms'; BEGIN READ ONLY;
        SELECT json_build_object(
          'recovery',pg_is_in_recovery(),
          'default_read_only',current_setting('default_transaction_read_only')::boolean,
          'connections',(SELECT count(*) FROM pg_stat_activity),
          'max_connections',current_setting('max_connections')::int,
          'blocked',(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'
            AND query_start<now()-interval '2 minutes'),
          'idle_transactions',(SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'
            AND xact_start<now()-interval '5 minutes'),
          'xid_age',(SELECT max(age(datfrozenxid)) FROM pg_database));"""
        raw = run(['docker','exec',name,'sh','-c',
                   'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"','sh',query],5)
        d = json.loads(next(line for line in raw.splitlines() if line.startswith('{')))
        reasons=[]
        if d['recovery'] or d['default_read_only']: reasons.append('Expected primary database is read-only or in recovery')
        if d['connections'] >= .85*d['max_connections']: reasons.append('Database connections at or above 85%')
        if d['blocked']: reasons.append('Database queries blocked on locks for over two minutes')
        if d['idle_transactions']: reasons.append('Idle transactions older than five minutes')
        if d['xid_age'] >= 1_000_000_000: reasons.append('Transaction ID age requires vacuum review')
        return d,reasons
    return health_result(probe)


def container_mount_read_only(info, destination):
    # statvfs flags reflect the collector's ProtectSystem=strict sandbox. Read
    # the service's own mount namespace instead, without entering or altering it.
    pid=int(info['State']['Pid'])
    if pid<=0: raise ValueError('Container not running')
    candidates=[]
    for line in Path(f'/proc/{pid}/mountinfo').read_text().splitlines():
        left,right=line.split(' - ',1); fields=left.split(); super_fields=right.split()
        mount=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4])
        if destination==mount or destination.startswith(mount.rstrip('/')+'/'):
            candidates.append((len(mount),'ro' in fields[5].split(',') or 'ro' in super_fields[2].split(',')))
    if not candidates: raise ValueError('Container mount diagnostics unavailable')
    return max(candidates)[1]


def volume_health(info, destination):
    mounts = [m for m in info['Mounts'] if m['Destination']==destination]
    if len(mounts)!=1: raise ValueError('Missing persistent volume')
    m=mounts[0]; v=os.statvfs(m['Source'])
    d={'disk_percent':round(100*(1-v.f_bavail/v.f_blocks),1),
       'inode_percent':round(100*(1-v.f_favail/v.f_files),1) if v.f_files else None}
    reasons=[]
    if not m['RW'] or container_mount_read_only(info,destination): reasons.append('Persistent volume is read-only')
    if d['disk_percent']>=90: reasons.append('Persistent volume capacity at or above 90%')
    if d['inode_percent'] is None: raise ValueError('Inode diagnostics unavailable')
    if d['inode_percent']>=90: reasons.append('Persistent volume inodes at or above 90%')
    return d,reasons


def with_volume(health, info, destination):
    volume=health_result(lambda:volume_health(info,destination))
    health['volume']=volume
    health['reasons'].extend(volume['reasons'])
    if volume['status']=='unknown': health['status']='unknown'
    elif volume['status']=='attention' and health['status']=='healthy': health['status']='attention'
    return health


def infrastructure_health(store):
    """Bounded read-only probes. HTTP credentials stay in memory and never enter snapshot output."""
    services={'postgres':'/var/lib/postgresql/data','engagement-postgres':'/var/lib/postgresql/data',
              'clickhouse':'/var/lib/clickhouse','nats':'/data','minio':'/data','meilisearch':'/meili_data'}
    names={k:f'rocento-{store}-{k}-1' for k in (*services,'api-gateway')}
    try:
        inspected=json.loads(run(['docker','inspect',*names.values()],5))
        infos={k:next(c for c in inspected if c['Name']=='/'+name) for k,name in names.items()}
        env=dict(x.split('=',1) for x in infos['api-gateway']['Config']['Env'])
    except Exception:
        return {k:{'status':'unknown','reasons':['Infrastructure configuration unavailable']} for k in services}
    def endpoint(service, configured):
        parsed=urllib.parse.urlsplit(configured)
        # Use the service IP on a network shared with the gateway, not host DNS.
        nets=infos[service]['NetworkSettings']['Networks']
        shared=set(nets)&set(infos['api-gateway']['NetworkSettings']['Networks'])
        ip=next(nets[n]['IPAddress'] for n in sorted(shared) if nets[n]['IPAddress'])
        if parsed.scheme!='http' or parsed.username or parsed.password: raise ValueError('Unexpected endpoint')
        return 'http://'+ip+':'+str(parsed.port or 80)
    def request(url,headers=None,method='GET'):
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {},method=method),timeout=3) as r:
            return r.read(1_000_000)
    def clickhouse():
        query="""SELECT
        (SELECT count() FROM system.tables WHERE database='commerce_analytics' AND name IN ('browser_events','reporting_order_facts')) AS required_tables,
        (SELECT count() FROM system.mutations WHERE database='commerce_analytics' AND NOT is_done AND latest_fail_reason!='') AS failed_mutations,
        (SELECT count() FROM system.mutations WHERE database='commerce_analytics' AND NOT is_done AND create_time<now()-INTERVAL 10 MINUTE) AS stalled_mutations,
        (SELECT count() FROM system.detached_parts WHERE database='commerce_analytics') AS detached_parts
        SETTINGS max_execution_time=2, readonly=1 FORMAT JSONEachRow"""
        raw=run(['docker','exec',names['clickhouse'],'sh','-c',
                 'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"','sh',query],5)
        d=json.loads(raw); reasons=[]
        if int(d['required_tables'])!=2: reasons.append('Required analytics tables missing')
        for key in ('failed_mutations','stalled_mutations','detached_parts'):
            if int(d[key]): reasons.append('ClickHouse '+key.replace('_',' ')+' require review')
        return d,reasons
    def nats():
        d=json.loads(run(['docker','exec',names['nats'],'wget','-qO-','-T','3',
                         'http://localhost:8222/jsz?accounts=true&streams=true&config=true'],5))
        stream=next(s for a in d['account_details'] for s in a['stream_detail'] if s['name']=='COMMERCE_EVENTS')
        config,state=stream['config'],stream['state']; reasons=[]
        if config['storage']!='file' or config.get('sealed') or 'commerce.>' not in config['subjects']:
            reasons.append('Commerce stream persistence or publishing configuration invalid')
        if state.get('lost',{}).get('msgs',0): reasons.append('JetStream reports lost messages')
        if not stream.get('cluster',{}).get('leader'): reasons.append('Commerce stream has no leader')
        for replica in stream.get('cluster',{}).get('replicas',[]):
            if replica.get('offline') or not replica.get('current'): reasons.append('Commerce stream replica unavailable or behind')
        limits=[(d['storage'],d['config']['max_storage']), (state['bytes'],config['max_bytes']), (state['messages'],config['max_msgs'])]
        if any(limit>0 and used>=.9*limit for used,limit in limits): reasons.append('JetStream storage/message limit at or above 90%')
        return {'messages':state['messages'],'bytes':state['bytes'],'persistent':config['storage']=='file'},reasons
    def minio():
        base=endpoint('minio',env['S3_ENDPOINT'])
        request(base+'/minio/health/cluster')
        # Authenticated HEAD verifies the real application bucket and credentials.
        url=base+'/commerce-media'; host=urllib.parse.urlsplit(base).netloc
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'); day=stamp[:8]
        payload=hashlib.sha256(b'').hexdigest(); scope=day+'/us-east-1/s3/aws4_request'
        signed='host;x-amz-content-sha256;x-amz-date'
        canonical='HEAD\n/commerce-media\n\nhost:'+host+'\nx-amz-content-sha256:'+payload+'\nx-amz-date:'+stamp+'\n\n'+signed+'\n'+payload
        string='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
        key=('AWS4'+env['S3_SECRET_KEY']).encode()
        for part in (day,'us-east-1','s3','aws4_request'): key=hmac.new(key,part.encode(),hashlib.sha256).digest()
        signature=hmac.new(key,string.encode(),hashlib.sha256).hexdigest()
        headers={'x-amz-date':stamp,'x-amz-content-sha256':payload,
                 'Authorization':'AWS4-HMAC-SHA256 Credential='+env['S3_ACCESS_KEY']+'/'+scope+', SignedHeaders='+signed+', Signature='+signature}
        request(url,headers,'HEAD')
        return {'bucket_access':True,'cluster_ready':True},[]
    def search():
        base=endpoint('meilisearch',env['MEILI_URL']); headers={'Authorization':'Bearer '+env['MEILI_MASTER_KEY']}
        stats=json.loads(request(base+'/stats',headers))
        if 'products' not in stats['indexes']: return {'indexes':len(stats['indexes'])},['Required products search index missing']
        since=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=2)).isoformat().replace('+00:00','Z')
        failed=json.loads(request(base+'/tasks?statuses=failed&limit=1&afterFinishedAt='+urllib.parse.quote(since),headers))
        active=json.loads(request(base+'/tasks?statuses=enqueued,processing&limit=1&reverse=true',headers))
        reasons=[]
        if failed['total']: reasons.append('Search indexing failures in the last two minutes')
        for task in active['results']:
            at=datetime.datetime.fromisoformat(task['enqueuedAt'].replace('Z','+00:00')).timestamp()
            if time.time()-at>=600: reasons.append('Search indexing task pending for over ten minutes')
        return {'indexes':len(stats['indexes']),'recent_failed_tasks':failed['total'],'pending_tasks':active['total']},reasons
    result={}
    for service in services:
        h=postgres_health(names[service]) if service in ('postgres','engagement-postgres') else health_result({'clickhouse':clickhouse,'nats':nats,'minio':minio,'meilisearch':search}[service])
        result[service]=with_volume(h,infos[service],services[service])
    return result


def shared_database_health():
    name='rocento-ai-shared-ai-postgres-1'
    health=postgres_health(name)
    try:
        info=json.loads(run(['docker','inspect',name],5))[0]
        return with_volume(health,info,'/var/lib/postgresql/data')
    except Exception:
        health['status']='unknown'; health['reasons'].append('Shared database volume diagnostics unavailable')
        return health


def apply_infrastructure_health(containers, stores, shared):
    healths={'rocento-ai-shared-ai-postgres-1':shared}
    healths.update({f"rocento-{s['name']}-{service}-1":h for s in stores for service,h in s.get('infrastructure_health',{}).items()})
    for container in containers:
        if container['name'] in healths:
            health=healths[container['name']]
            container['docker_status']=container['status']
            if container['status']=='healthy' and health['status']!='healthy': container['status']='infrastructure '+health['status']


def apply_publisher_health(containers, stores):
    for store in stores:
        for key, worker, label in (('engagement_publisher', 'engagement-worker', 'publisher'),
                                   ('analytics_health', 'analytics-worker', 'analytics'),
                                   ('export_health', 'export-worker', 'export'),
                                   ('gateway_health', 'api-gateway', 'gateway'),
                                   ('ai_health', 'ai-service', 'AI'),
                                   ('language_health', 'commerce-language-engine', 'language')):
            health = store.get(key, {'status': 'unknown'})
            for container in containers:
                if container['name'] == f"rocento-{store['name']}-{worker}-1":
                    container['docker_status'] = container['status']
                    container[label + '_status'] = health['status']
                    if container['status'] == 'healthy' and health['status'] != 'healthy':
                        container['status'] = label + ' ' + health['status']


def collect_store(item, previous=None, previous_at=0):
    store, port = item
    result = {'name': store, 'checks': [], 'queues': None, 'reporting_age': None, 'traffic': None}
    checks = result['checks']
    def check(key, ok, detail):
        checks.append({'id': store + ':' + key, 'ok': bool(ok), 'detail': detail})
    for route, key in [('/ready', 'gateway'), ('/v1/catalog/categories', 'catalog')]:
        try:
            http(f'http://127.0.0.1:{port}{route}', store + '.rocento.com')
            check(key, True, key.title() + ' responds')
        except Exception:
            check(key, False, key.title() + ' unavailable')
    gateway_metrics = None
    try:
        m = metrics(http(f'http://127.0.0.1:{port}/metrics', store + '.rocento.com'))
        gateway_metrics = m
        fresh = m.get('commerce_reliability_sample_success') == 1 and time.time()-m.get('commerce_reliability_last_success_seconds', 0) < 120
        check('queue-sampling', fresh, 'Queue diagnostics fresh' if fresh else 'Queue diagnostics unavailable or stale')
        if fresh:
            result['queues'] = {q: {'pending': int(m[f'commerce_queue_pending{{queue="{q}"}}']), 'oldest_seconds': round(m[f'commerce_queue_oldest_pending_seconds{{queue="{q}"}}'])} for q in ('outbox', 'notifications')}
            result['queues']['notification_failed'] = int(m['commerce_notifications_failed'])
            result['queues']['outbox_retrying'] = int(m['commerce_outbox_retrying'])
            for q in ('outbox', 'notifications'):
                check(q, result['queues'][q]['oldest_seconds'] < (120 if q == 'outbox' else 600), q.title() + ' queue age')
            check('notification-failures', result['queues']['notification_failed'] == 0, 'Failed commerce notifications')
        # Exclude health, catalog-probe endpoint, metrics, and auth traffic.
        counters = {'requests': 0, 'errors': 0, 'seconds': 0}
        for key, value in m.items():
            if 'route="/v1/' not in key or '/auth/' in key or '/v1/admin/me"' in key or 'route="/v1/catalog/categories"' in key:
                continue
            for prefix, field in [('commerce_http_requests_total{', 'requests'), ('commerce_http_errors_total{', 'errors'), ('commerce_http_duration_seconds_sum{', 'seconds')]:
                if key.startswith(prefix):
                    counters[field] += value
        result['traffic'] = counters
    except Exception:
        check('metrics', False, 'Gateway metrics unavailable')
    analytics_metrics = None
    try:
        m = metrics(run(['docker', 'exec', f'rocento-{store}-analytics-worker-1', 'curl', '-fsS', '--max-time', '5', 'http://localhost:8082/metrics']))
        analytics_metrics = m
        age = max(0, round(time.time()-m['commerce_reporting_last_success_seconds']))
        result['reporting_age'] = age
        check('reporting', m.get('commerce_analytics_worker_ready') == 1 and age < 3600, 'Reporting freshness (one-hour threshold)')
    except Exception:
        check('reporting', False, 'Reporting metrics unavailable')
    # Parallel bounded diagnostics keep the existing collector time budget.
    # Docker CLI processes have significant resident memory. Four stores already
    # run concurrently; serialize diagnostics within each store to respect 192 MiB.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        publisher = pool.submit(engagement_publisher, store)
        analytics = pool.submit(analytics_health, store, analytics_metrics,
                                (previous or {}).get('analytics_health'), previous_at)
        exports = pool.submit(export_health, store)
        gateway = pool.submit(gateway_health, store, list(checks), gateway_metrics, (previous or {}).get('gateway_health'), previous_at)
        ai = pool.submit(ai_health, store)
        infrastructure = pool.submit(infrastructure_health, store)
        result['engagement_publisher'] = publisher.result()
        result['analytics_health'] = analytics.result()
        result['export_health'] = exports.result()
        result['gateway_health'] = gateway.result()
        result['ai_health'], result['language_health'] = ai.result()
        result['infrastructure_health'] = infrastructure.result()
    for service, health in result['infrastructure_health'].items():
        check('infrastructure-'+service, health['status']=='healthy', store+': '+service+' — '+('; '.join(health['reasons']) or 'checks passing'))
    result['exports'] = result['export_health']['jobs']
    for key in ('engagement_publisher', 'analytics_health', 'export_health', 'gateway_health', 'ai_health', 'language_health'):
        health = result[key]
        check(key.replace('_', '-'), health['status'] == 'healthy',
              store + ': ' + key.replace('_', ' ') + ' — ' + ('; '.join(health['reasons']) or 'checks passing'))
    return result

def incidents(previous, checks, now):
    old = {x['id']: x for x in previous.get('incidents', []) if x.get('resolved_at') is None}
    active = []
    for item in checks:
        if not item['ok']:
            active.append(old.pop(item['id'], {'id': item['id'], 'detail': item['detail'], 'started_at': now, 'resolved_at': None}))
    resolved = [dict(x, resolved_at=now) for x in old.values()]
    history = resolved + [x for x in previous.get('incidents', []) if x.get('resolved_at') is not None]
    return active + history[:200]

def collect():
    now = time.time()
    try:
        previous = json.loads((ROOT/'snapshot.json').read_text())
    except (OSError, ValueError):
        previous = {}
    checks = []
    containers = []
    expected = {f'rocento-{s}-{c}-1' for s in STORES for c in SERVICES} | set(SHARED)
    try:
        ids = run(['docker', 'ps', '-aq']).splitlines()
        inspected = json.loads(run(['docker', 'inspect', *ids])) if ids else []
        seen = set()
        for item in inspected:
            name = item['Name'].lstrip('/')
            if not name.startswith('rocento-'):
                continue
            seen.add(name)
            state = item['State']
            status = state.get('Health', {}).get('Status', 'no healthcheck') if state['Running'] else state['Status']
            containers.append({'name': name, 'status': status, 'restarts': item['RestartCount'], 'image': item['Image'].removeprefix('sha256:')[:12], 'started_at': state['StartedAt']})
            checks.append({'id': 'container:' + name, 'ok': status == 'healthy', 'detail': name + ': ' + status})
        for name in sorted(expected-seen):
            checks.append({'id': 'container:' + name, 'ok': False, 'detail': name + ': missing'})
            containers.append({'name': name, 'status': 'missing', 'restarts': 0, 'image': '—', 'started_at': ''})
    except Exception:
        checks.append({'id': 'docker', 'ok': False, 'detail': 'Container inspection failed'})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(collect_store, item, next((s for s in previous.get('stores', []) if s['name'] == item[0]), None), previous.get('checked_at', 0)) for item in STORES.items()]
        public = list(pool.map(public_check, [host for s in STORES for host in (s+'.rocento.com', 'admin.rocento.com' if s == 'grocery' else s+'-admin.rocento.com')]))
        stores = [f.result() for f in futures]
    for s in stores:
        checks.extend(s['checks'])
        old = next((x for x in previous.get('stores', []) if x['name'] == s['name']), {})
        a, b = s['traffic'], old.get('traffic')
        if a and b and now-previous.get('checked_at', 0) < 180 and all(a[k] >= b[k] for k in a):
            requests, errors = a['requests']-b['requests'], a['errors']-b['errors']
            s['interval_traffic'] = {'requests': int(requests), 'errors': int(errors), 'average_ms': round(1000*(a['seconds']-b['seconds'])/requests) if requests else None}
            if errors > 0:
                if s['gateway_health']['status'] == 'healthy':
                    s['gateway_health']['status'] = 'attention'
                s['gateway_health']['reasons'].append('New HTTP 5xx responses since previous sample')
            checks.append({'id': s['name']+':gateway-http-errors', 'ok': errors == 0,
                           'detail': s['name'] + ': new HTTP 5xx responses since previous sample'})
            checks.append({'id': s['name']+':errors', 'ok': requests < 100 or errors/requests <= .05, 'detail': s['name'] + ': API errors above 5% (minimum 100 requests per sample)'})
    shared = shared_database_health()
    checks.append({'id':'shared:database','ok':shared['status']=='healthy','detail':'Shared AI database — '+('; '.join(shared['reasons']) or 'checks passing')})
    apply_infrastructure_health(containers, stores, shared)
    apply_publisher_health(containers, stores)
    checks.extend({'id': 'public:'+p['host'], 'ok': p['ok'], 'detail': p['host']+': HTTP '+str(p['code'])} for p in public)
    mem = {k: int(v.split()[0]) for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    disk = shutil.disk_usage('/')
    host = {'memory_percent': round(100*(1-mem['MemAvailable']/mem['MemTotal']), 1), 'disk_percent': round(100*disk.used/disk.total, 1), 'load': list(os.getloadavg()), 'cpus': os.cpu_count()}
    for field in ('memory_percent', 'disk_percent'):
        checks.append({'id': 'host:'+field, 'ok': host[field] < 90, 'detail': field.replace('_', ' ').title()+' above 90%'})
    failed = sum(not x['ok'] for x in checks)
    history = previous.get('history', []) + [{'at': now, 'failed': failed, 'healthy': sum(c['status']=='healthy' for c in containers), 'memory': host['memory_percent']}]
    snapshot = {'checked_at': now, 'duration_seconds': round(time.time()-now, 1), 'status': 'attention' if failed else 'healthy', 'checks_failed': failed, 'containers': sorted(containers, key=lambda c: c['name']), 'stores': stores, 'shared_database':shared, 'public': public, 'host': host, 'incidents': incidents(previous, checks, now), 'history': [x for x in history if x['at'] > now-86400][-1440:], 'notifications': 'Dashboard only; email delivery disabled'}
    ROOT.mkdir(parents=True, exist_ok=True)
    temp = ROOT/'snapshot.tmp'
    temp.write_text(json.dumps(snapshot, allow_nan=False))
    temp.chmod(0o644)
    temp.replace(ROOT/'snapshot.json')
    print(json.dumps({'status': snapshot['status'], 'containers': len(containers), 'failed_checks': failed, 'duration_seconds': snapshot['duration_seconds']}))

if __name__ == '__main__':
    collect()
