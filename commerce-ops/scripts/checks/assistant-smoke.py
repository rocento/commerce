"""Live local MVP demo. Creates synthetic COD orders/tickets, never real payments/messages."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import http.cookiejar
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from catalog_support import Client

parser=argparse.ArgumentParser();parser.add_argument('--chaos',action='store_true');args=parser.parse_args()
base='http://localhost:5173/api'
http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
token=None

def call(method,path,body=None):
    headers={'Content-Type':'application/json','X-Commerce-Request':'1'}
    if token:headers['Authorization']='Bearer '+token
    request=urllib.request.Request(base+path,method=method,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    with http.open(request,timeout=35) as response:
        if response.headers.get('content-type','').startswith('text/event-stream'):
            return [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith('data: ')]
        return json.load(response)

def wait(fn):
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        try:
            if fn():return
        except (OSError,subprocess.CalledProcessError):pass
        time.sleep(1)
    raise AssertionError('Timed out waiting for assistant dependency')

wait(lambda:urllib.request.urlopen('http://localhost:8000/ready',timeout=2).status==200)
wait(lambda:urllib.request.urlopen(base+'/health',timeout=2).status==200)
# Guests must never get an order card, and recommendations must not invent area availability.
events=call('POST','/v1/assistant/chat',{'request_id':str(uuid.uuid4()),'message':'Track order','order_id':str(uuid.uuid4())})
assert any(e.get('code')=='login_required' for e in events)
assert not any(e['type']=='card.order' for e in events)
events=call('POST','/v1/assistant/chat',{'request_id':str(uuid.uuid4()),'message':'Recommend luxury breakfast'})
assert any(e.get('code')=='area_unavailable' for e in events)
print('PASS guest order denial and honest recommendation gate')

admin=Client();unique=uuid.uuid4().hex[:10]
credentials={'identifier':f'assistant-{unique}@example.test','password':uuid.uuid4().hex}
call('POST','/v1/customer/auth/register',credentials)
logs=subprocess.check_output(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'logs','--no-log-prefix','api-gateway'],text=True)
notices=[]
for line in logs.splitlines():
    try:row=json.loads(line)
    except json.JSONDecodeError:continue
    if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:notices.append(row['fields'])
assert notices,'No local verification notification'
call('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
auth=call('POST','/v1/customer/auth/login',credentials);token=auth['access_token']
location=call('POST','/v1/customer/locations',{'label':'home','latitude':30,'longitude':31,'formatted_address':'Synthetic assistant test location'})
category=admin.call('POST','/v1/admin/catalog/categories',{'name':'Assistant test','slug':'assistant-'+unique,'parent_id':None})
product=admin.call('POST','/v1/admin/catalog/products',{'sku':'ASSISTANT-'+unique,'name':'Assistant test groceries','slug':'assistant-'+unique,'description':'Synthetic assistant fixture','price':'2.00','currency':'USD','unit':'each','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
admin.call('PUT','/v1/admin/inventory/'+product['id'],{'on_hand':10,'reason':'Assistant smoke fixture'})
call('POST','/v1/cart');call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
quote=call('POST','/v1/customer/checkout/quote',{'location_id':location['id']})
order=call('POST','/v1/customer/checkout/place',{'quote_id':quote['id'],'idempotency_key':str(uuid.uuid4())})['order']
conversation=str(uuid.uuid4());request_id=str(uuid.uuid4())
events=call('POST','/v1/assistant/chat',{'request_id':request_id,'conversation_id':conversation,'message':'Where is my order?','order_id':order['id']})
card=next(e['order'] for e in events if e['type']=='card.order')
assert card['id']==order['id'] and card['total']==order['total']
assert not any(k in card for k in ['contact','payment','location','customer_id'])
assert events[-1]['type']=='done'
wait(lambda:any(t['request_id']==request_id for t in call('GET','/v1/assistant/history')))
print('PASS live order lookup through signed gateway/Python/tool facade; narrowed snapshot and owned history')

ticket={'request_id':str(uuid.uuid4()),'subject':'Assistant smoke handoff','category':'order_issue','body':'Please help with this synthetic order.','order_id':order['id']}
request={'request_id':ticket['request_id'],'message':'Please open this ticket','ticket':ticket}
events=call('POST','/v1/assistant/chat',request)
result=next(e['ticket'] for e in events if e['type']=='ticket.created')
replayed=call('POST','/v1/assistant/chat',request)
assert next(e['ticket']['ticket']['id'] for e in replayed if e['type']=='ticket.created')==result['ticket']['id']
path='/v1/admin/support/tickets/'+result['ticket']['id']
admin.call('POST',path+'/messages',{'request_id':str(uuid.uuid4()),'body':'Our team has reviewed this test ticket.','status':'resolved'})
visible=call('GET','/v1/customer/support/tickets/'+result['ticket']['id'])
assert visible['ticket']['status']=='resolved' and visible['messages'][-1]['sender']=='admin'
print('PASS Python-requested support mutation, retry deduplication, Admin reply and customer resolution visibility')

def analytics():
    query=f"SELECT count() FROM commerce_analytics.assistant_events FINAL WHERE request_id='{request_id}'"
    output=subprocess.check_output(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'exec','-T','clickhouse','sh','-c','exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"','sh',query],text=True,stderr=subprocess.DEVNULL)
    return int(output.strip())==1
wait(analytics)
print('PASS bounded assistant telemetry delivered into ClickHouse')
if args.chaos:
    subprocess.run(['docker','stop','commerce-ai-ai-service-1'],check=True,stdout=subprocess.DEVNULL)
    try:
        started=time.monotonic()
        try:call('POST','/v1/assistant/chat',{'request_id':str(uuid.uuid4()),'message':'hello'})
        except urllib.error.HTTPError as e:assert e.code==503
        else:raise AssertionError('Expected unavailable assistant')
        assert time.monotonic()-started<6
        assert call('GET','/v1/customer/orders/'+order['id'])['order']['id']==order['id']
        assert call('GET','/v1/catalog/products/'+product['id'])['id']==product['id']
        call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
        quote=call('POST','/v1/customer/checkout/quote',{'location_id':location['id']})
        placed=call('POST','/v1/customer/checkout/place',{'quote_id':quote['id'],'idempotency_key':str(uuid.uuid4())})
        assert placed['order']['id']!=order['id']
        direct=call('POST','/v1/support/tickets',{**ticket,'request_id':str(uuid.uuid4()),'subject':'Support during AI outage'})
        assert direct['ticket']['status']=='open'
        print('PASS AI stopped: bounded fallback, catalog, cart, quote, COD checkout, orders and direct support remain working')
    finally:
        subprocess.run(['docker','start','commerce-ai-ai-service-1'],check=True,stdout=subprocess.DEVNULL)
        wait(lambda:urllib.request.urlopen('http://localhost:8000/ready',timeout=2).status==200)
# Retain a synthetic customer/order for browser QA. No real account or access token is written.
demo=Path('.local/assistant/demo.json');demo.write_text(json.dumps({'credentials':credentials,'order_id':order['id'],'ticket_id':result['ticket']['id']}));os.chmod(demo,0o600)
admin.call('POST','/v1/admin/auth/logout')
print('PASS assistant MVP smoke; synthetic browser fixture saved locally')
