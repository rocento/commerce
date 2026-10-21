"""Runtime isolation probe. Requires the opt-in assistant Compose stack running."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
import subprocess

def inspect(name):
    return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
ai=inspect('commerce-ai-ai-service-1')
assert ai['Config']['User'] == '10001:10001'
assert ai['HostConfig']['ReadonlyRootfs']
assert 'ALL' in ai['HostConfig']['CapDrop']
assert ai['HostConfig']['Memory'] > 0 and ai['HostConfig']['NanoCpus'] > 0
assert ai['HostConfig']['PidsLimit'] > 0
names={entry.split('=',1)[0] for entry in ai['Config']['Env']}
assert not names.intersection({'DATABASE_URL','AUTH_SECRET','POSTGRES_PASSWORD','PAYMENT_SECRET','ASSISTANT_PRIVATE_KEY_FILE'})
assert set(ai['NetworkSettings']['Networks']) == {'commerce-ai_assistant-private'}
network=inspect('commerce-ai_assistant-private')
assert network['Internal'] is True
commerce=inspect('commerce-ai-postgres-1')
ips=[v['IPAddress'] for v in commerce['NetworkSettings']['Networks'].values()]
probe='''
import os,socket,urllib.request,urllib.error
assert os.getuid()==10001
for host,port in TARGETS:
    try:
        with socket.create_connection((host,port),timeout=1): pass
    except OSError: print('DENIED',host,port)
    else: raise AssertionError('Forbidden destination reachable: '+host)
for path in ['/v1/admin/orders','/v1/customer/checkout/place','/v1/catalog/products','/v1/assistant-tools/orders/../admin','/']:
    try:
        urllib.request.urlopen('http://assistant-tools:8081'+path,timeout=2)
    except urllib.error.HTTPError as e: assert e.code==403
    else: raise AssertionError('Non-tool path allowed')
try:
    urllib.request.urlopen('http://assistant-tools:8081/v1/assistant-tools/orders/00000000-0000-0000-0000-000000000001',timeout=3)
except urllib.error.HTTPError as e: assert e.code in (401,404), e.code
else: raise AssertionError('Tool accessed without delegation')
print('PASS non-root, forbidden destinations, facade method/path allow-list and missing delegation')
'''.replace('TARGETS',repr([('postgres',5432),*[(ip,5432) for ip in ips],('api-gateway',8080),('1.1.1.1',443)]))
subprocess.run(['docker','exec','commerce-ai-ai-service-1','python','-c',probe],check=True)
print('PASS runtime resources, separate identity/secrets, read-only filesystem, internal network')
