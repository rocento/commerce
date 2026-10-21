#!/usr/bin/env python3
"""Read-only Docker deployment inventory and installation/storage isolation gate. No credentials emitted."""
import argparse, json, subprocess, uuid
from urllib.parse import urlparse

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=20)

def env(container):
    return dict(v.split('=',1) for v in container['Config'].get('Env',[]) if '=' in v)

def scopes(container):
    return sorted(m.get('Name') or m.get('Source','') for m in container.get('Mounts',[]) if m.get('RW') and m.get('Destination') in ('/data','/var/lib/postgresql/data'))

def resolves_uniquely(host, caller, target, containers):
    networks=set(caller['NetworkSettings']['Networks'])
    matches=set()
    for c in containers:
        for network,details in c['NetworkSettings']['Networks'].items():
            names=[c['Name'].lstrip('/')]+(details.get('Aliases') or [])+(details.get('DNSNames') or [])
            if network in networks and host in names: matches.add(c['Id'])
    return matches=={target['Id']}

def inventory():
    ids=run('docker','ps','-q').split()
    containers=json.loads(run('docker','inspect',*ids)) if ids else []
    grouped={}
    for c in containers:
        labels=c['Config'].get('Labels') or {};project=labels.get('com.docker.compose.project');service=labels.get('com.docker.compose.service')
        if project and service: grouped.setdefault(project,{}).setdefault(service,[]).append(c)
    results=[]
    for project,services in grouped.items():
        if 'publication-renderer' not in services: continue
        errors=[];api=services.get('api-gateway',[]);pg=services.get('postgres',[]);stores=services.get('minio',[])
        if len(api)!=1 or len(pg)!=1 or len(stores)!=1: errors.append('requires one locally inspectable gateway/database/media store; external scopes need separate verified evidence')
        item={'project':project,'errors':errors,'origins':[],'installation_ids':[],'renderer_count':len(services['publication-renderer']),'database_scopes':[],'media_scopes':[]}
        if not errors:
            api,pg,store=api[0],pg[0],stores[0];cfg=env(api)
            try: db=urlparse(cfg.get('DATABASE_URL',''));media=urlparse(cfg.get('S3_ENDPOINT',''))
            except ValueError: errors.append('malformed service address');db=urlparse('');media=urlparse('')
            if not resolves_uniquely(db.hostname,api,pg,containers): errors.append('database endpoint does not resolve to inspected project database')
            if not resolves_uniquely(media.hostname,api,store,containers): errors.append('media endpoint does not resolve to inspected project store')
            item['database_scopes']=scopes(pg);item['media_scopes']=scopes(store)
            if not item['database_scopes'] or not item['media_scopes']: errors.append('persistent database/media scope unavailable')
            try:
                actual=run('docker','exec',pg['Id'],'sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT installation_id FROM platform.publication_installation WHERE singleton"').strip()
            except (subprocess.SubprocessError,OSError): actual='';errors.append('persisted installation UUID unavailable')
            item['installation_ids']=[actual];origin=cfg.get('PUBLICATION_APPROVED_ORIGIN','');item['origins']=[origin] if not any(x in origin for x in ['@','?','#']) else [''];
            if item['origins']==['']:errors.append('unsafe approved origin omitted from evidence')
            if not actual or cfg.get('PUBLICATION_INSTALLATION_ID')!=actual: errors.append('gateway/database installation mismatch')
            for renderer in services['publication-renderer']:
                r=env(renderer)
                if r.get('PUBLICATION_INSTALLATION_ID')!=actual or r.get('PUBLICATION_APPROVED_ORIGIN')!=origin: errors.append('renderer installation/origin mismatch')
                if cfg.get('PUBLICATION_OBSERVATION_TOKEN')!=r.get('PUBLICATION_OBSERVATION_TOKEN') or len(r.get('PUBLICATION_OBSERVATION_TOKEN',''))<32:errors.append('private health token missing or mismatched')
                if not renderer['HostConfig'].get('ReadonlyRootfs'):errors.append('renderer filesystem is not read-only')
            if not cfg.get('PUBLICATION_RENDERER_URL'):errors.append('gateway private renderer probe not configured')
        results.append(item)
    return {'scope':'read-only local Docker topology and persisted installation identity; not CDN/IAM/field-performance verification','installations':results}

def assess(data):
    errors=[];seen={k:{} for k in ['origins','installation_ids','database_scopes','media_scopes']}
    if not data.get('installations'):errors.append('No running merchant publication installation was observed')
    for item in data.get('installations',[]):
        project=item['project'];
        for required in seen:
            if not item.get(required):errors.append(f'{project}: missing {required}')
        for identifier in item.get('installation_ids',[]):
            try:uuid.UUID(identifier)
            except ValueError:errors.append(f'{project}: invalid installation UUID')
        errors.extend(f'{project}: {e}' for e in item.get('errors',[]))
        for kind,values in seen.items():
            for value in item.get(kind,[]):
                if not value: errors.append(f'{project}: empty {kind}')
                elif value in values and values[value]!=project:errors.append(f'{project}: {kind} shared with {values[value]}')
                else:values[value]=project
        for origin in item.get('origins',[]):
            try:
                u=urlparse(origin);valid=u.scheme=='https' and bool(u.hostname) and u.path=='/' and not(u.username or u.password or u.query or u.fragment or u.port)
            except ValueError:valid=False
            if not valid:errors.append(f'{project}: invalid approved origin')
    return {'gate':'Verified' if not errors else 'Blocked','errors':errors,'inventory':data}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--input',help='Assess previously collected, trusted inventory');parser.add_argument('--output');args=parser.parse_args()
    try:
        if args.input:
            with open(args.input) as f:data=json.load(f)
        else:data=inventory()
        result=assess(data)
    except (subprocess.SubprocessError,OSError,ValueError,KeyError):result={'gate':'Blocked','errors':['Inventory unavailable or malformed; no deployment claims made']}
    text=json.dumps(result,indent=2)+'\n'
    if args.output:
        with open(args.output,'w') as f:f.write(text)
    else:print(text,end='')
    return 0 if result['gate']=='Verified' else 2
if __name__=='__main__':raise SystemExit(main())
