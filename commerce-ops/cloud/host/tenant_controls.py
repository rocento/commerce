#!/usr/bin/python3
"""Apply staff-requested suspension/archive; preserve data, billing and hostnames."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

STATE=Path('/opt/rocento-merchants')
NGINX=Path('/etc/nginx/conf.d')

def run(args,data=None):
    result=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
    if result.returncode:raise RuntimeError('HOST_CONTROL_FAILED')
    return result.stdout

def sql(query):
    return run(['docker','exec','-i','rocento-onboarding-test-postgres-1','psql','-v','ON_ERROR_STOP=1','-U','onboarding','-d','onboarding','-At'],query.encode()).decode().strip()

def trusted(path):
    path=Path(path)
    for item in [path,*path.parents]:
        st=item.lstat()
        if item.is_symlink() or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('UNTRUSTED_RUNTIME')
    return path

def validate(item):
    for key in ('id','tenantId'):
        if str(uuid.UUID(item[key]))!=item[key]:raise ValueError('INVALID_CONTROL_ID')
    if item['action'] not in ('SUSPEND','ARCHIVE') or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,38}[a-z0-9]',item['slug']):
        raise ValueError('INVALID_CONTROL_REQUEST')

def denial_config(slug):
    return f'''# Staff control: data and hostnames retained.
server {{
 listen 443 ssl;
 server_name {slug}.rocento.com {slug}-admin.rocento.com;
 ssl_certificate /opt/rocento-onboarding/config/origin.pem;
 ssl_certificate_key /opt/rocento-onboarding/config/origin.key;
 add_header Cache-Control "no-store" always;
 add_header X-Robots-Tag "noindex, nofollow" always;
 default_type text/plain;
 return 503 "This store is currently unavailable.\\n";
}}
'''

def restrict_runtime(item):
    validate(item)
    target=NGINX/('merchant-'+item['tenantId']+'.conf')
    previous=trusted(target).read_bytes() if target.exists() else None
    temporary=target.with_suffix('.pending')
    temporary.write_text(denial_config(item['slug']));temporary.chmod(0o644)
    temporary.replace(target)
    try:
        run(['nginx','-t']);run(['systemctl','reload','nginx'])
    except Exception:
        if previous is None:target.unlink()
        else:target.write_bytes(previous)
        raise
    directory=STATE/item['tenantId']
    if directory.exists():
        trusted(directory)
        config=trusted(directory/'compose.json');env=trusted(directory/'runtime.env')
        spec=json.loads(config.read_text())
        if spec.get('name')!='merchant-'+item['tenantId']:raise ValueError('TENANT_RUNTIME_MISMATCH')
        # Only stop exact existing project containers. Do not run services or remove volumes.
        base=['docker','compose','--project-directory',str(directory),'--env-file',str(env),'-f',str(config)]
        run(base+['stop','--timeout','30'])
        ids=run(base+['ps','--all','-q']).decode().split()
        if ids:
            containers=json.loads(run(['docker','inspect',*ids]))
            if any(c['State']['Running'] or c['Config']['Labels'].get('com.docker.compose.project')!=spec['name'] for c in containers):
                raise ValueError('RUNTIME_STOP_NOT_VERIFIED')

def complete_sql(item):
    validate(item)
    state='ARCHIVED' if item['action']=='ARCHIVE' else 'SUSPENDED'
    expected='ARCHIVE_REQUESTED' if item['action']=='ARCHIVE' else 'SUSPEND_REQUESTED'
    return f"""BEGIN;
      SELECT id FROM provisioning_jobs WHERE tenant_id='{item['tenantId']}' FOR UPDATE;
      UPDATE tenants SET management_state='{state}',lifecycle_status='SUSPENDED',
        archived_at=CASE WHEN '{state}'='ARCHIVED' THEN clock_timestamp() ELSE archived_at END
        WHERE id='{item['tenantId']}' AND management_state='{expected}';
      UPDATE provisioning_jobs SET status='BLOCKED',last_error='STORE_RESTRICTED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE tenant_id='{item['tenantId']}' AND status<>'SUCCEEDED';
      UPDATE tenant_domains SET route_status='SUSPENDED' WHERE tenant_id='{item['tenantId']}';
      UPDATE tenant_control_commands SET status='APPLIED',completed_at=clock_timestamp(),error_code=NULL WHERE id='{item['id']}' AND status='APPLYING';
      INSERT INTO audit_events(actor_id,action,target_id) VALUES('tenant-control-worker','store.{state.lower()}.applied','{item['tenantId']}');
      INSERT INTO outbox_events(aggregate_id,subject,payload) VALUES('{item['tenantId']}','rocento.control.store.restricted',jsonb_build_object('commandId','{item['id']}','state','{state}'));
      COMMIT;"""

def main():
    os.umask(0o077);STATE.mkdir(mode=0o700,exist_ok=True);trusted(STATE)
    with (STATE/'deployment.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        raw=sql("SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT c.id,c.tenant_id AS \"tenantId\",c.action,t.store_slug AS slug FROM tenant_control_commands c JOIN tenants t ON t.id=c.tenant_id WHERE c.status IN ('PENDING','APPLYING') AND t.management_state IN ('SUSPEND_REQUESTED','ARCHIVE_REQUESTED') ORDER BY c.requested_at LIMIT 20) x;")
        for item in json.loads(raw):
            validate(item)
            sql(f"UPDATE tenant_control_commands SET status='APPLYING' WHERE id='{item['id']}' AND status IN ('PENDING','APPLYING');")
            try:
                import merchant_fleet
                if not merchant_fleet.restrict(item):
                    restrict_runtime(item)
                sql(complete_sql(item))
                print(json.dumps({'commandId':item['id'],'status':'APPLIED'}))
            except merchant_fleet.Waiting as error:
                if str(error) != 'HOST_EXECUTION_BUSY':
                    sql(f"UPDATE tenant_control_commands SET status='FAILED',error_code='HOST_CONTROL_FAILED',completed_at=clock_timestamp() WHERE id='{item['id']}';")
                else:
                    sql(f"UPDATE tenant_control_commands SET status='PENDING',error_code='HOST_EXECUTION_BUSY' WHERE id='{item['id']}';")
            except Exception as error:
                sql(f"UPDATE tenant_control_commands SET status='FAILED',error_code='HOST_CONTROL_FAILED',completed_at=clock_timestamp() WHERE id='{item['id']}';")
                print('Tenant control requires review: '+type(error).__name__,file=sys.stderr)

if __name__=='__main__':main()
