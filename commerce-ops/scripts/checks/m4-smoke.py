"""Local COD lifecycle smoke. --replay briefly pauses NATS and kills/restarts the gateway.
Creates synthetic orders/customers (retained for audit); removes catalog fixtures afterward.
No external messages, payments or deliveries occur.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from decimal import Decimal
import argparse
import concurrent.futures
import http.cookiejar
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from catalog_support import Client, ROOT
parser=argparse.ArgumentParser()
parser.add_argument('--replay',action='store_true')
args=parser.parse_args()
admin=Client()
http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
token=None

def call(method,path,body=None):
    headers={'Content-Type':'application/json','X-Commerce-Request':'1'}
    if token:headers['Authorization']='Bearer '+token
    r=urllib.request.Request('http://localhost:5173/api'+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with http.open(r,timeout=20) as response:return json.load(response)

def docker(*arguments):
    if arguments and arguments[0] == 'compose':
        arguments = ('compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), *arguments[1:])
    return subprocess.check_output(['docker',*arguments],cwd=ROOT,text=True,stderr=subprocess.STDOUT)

def pg(sql):
    return docker('compose','exec','-T','postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"','sh',sql).strip()

def facts(order):
    sql=f"SELECT count() FROM commerce_analytics.order_facts FINAL WHERE order_id='{order}'"
    return int(docker('compose','exec','-T','clickhouse','sh','-c','exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"','sh',sql).strip())

def wait_for(fn,seconds=45):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            if fn():return
        except (urllib.error.URLError,subprocess.CalledProcessError):pass
        time.sleep(.5)
    raise AssertionError('Timed out waiting for provider recovery')

def rejected(status,fn):
    try:fn()
    except urllib.error.HTTPError as error:
        assert error.code==status,(error.code,error.read())
    else:raise AssertionError('Expected request rejection')

unique=uuid.uuid4().hex[:10]
category=product=None
paused=False
try:
    rejected(401,lambda:call('POST','/v1/customer/checkout/place',{'quote_id':str(uuid.uuid4()),'idempotency_key':str(uuid.uuid4())}))
    category=admin.call('POST','/v1/admin/catalog/categories',{'name':'M4 test','slug':'m4-'+unique,'parent_id':None})
    product=admin.call('POST','/v1/admin/catalog/products',{'sku':'M4-'+unique,'name':'M4 test bananas','slug':'m4-'+unique,'description':'Synthetic checkout fixture','price':'1.20','currency':'USD','unit':'lb','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
    stock='/v1/admin/inventory/'+product['id']
    admin.call('PUT',stock,{'on_hand':5,'reason':'M4 checkout test'})
    call('POST','/v1/cart')
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':2})
    credentials={'identifier':'m4-'+unique+'@example.test','password':uuid.uuid4().hex}
    call('POST','/v1/customer/auth/register',credentials)
    token=call('POST','/v1/customer/auth/login',credentials)['access_token']
    rejected(403,lambda:call('POST','/v1/customer/checkout/quote',{'location_id':str(uuid.uuid4())}))
    logs=docker('compose','logs','--no-log-prefix','api-gateway')
    notices=[]
    for line in logs.splitlines():
        try:row=json.loads(line)
        except json.JSONDecodeError:continue
        if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:notices.append(row['fields'])
    assert notices,'Verification notification missing'
    call('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
    assert call('POST','/v1/cart')['items'][0]['quantity']==2
    location=call('POST','/v1/customer/locations',{'label':'home','latitude':30,'longitude':31,'formatted_address':'M4 synthetic delivery address'})
    quote=call('POST','/v1/customer/checkout/quote',{'location_id':location['id']})
    reviewed=quote['snapshot']
    assert reviewed['subtotal']=='2.40'
    assert reviewed['delivery_fee']==admin.call('GET','/v1/admin/settings/delivery-fee')['amount']
    assert Decimal(reviewed['total'])==Decimal('2.40')-Decimal(reviewed['discount_amount'])+Decimal(reviewed['delivery_fee'])+Decimal(reviewed['tax_amount'])
    body={'quote_id':quote['id'],'idempotency_key':str(uuid.uuid4())}
    if args.replay:
        docker('compose','pause','nats');paused=True
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:call('POST','/v1/customer/checkout/place',body),range(2)))
    order=results[0]['order'];oid=order['id']
    assert oid==results[1]['order']['id']
    assert admin.call('GET',stock)['stock']['on_hand']==3
    assert call('POST','/v1/cart')['items']==[]
    if args.replay:
        assert pg(f"SELECT count(*) FROM platform.outbox WHERE event_type='order.placed' AND payload->>'order_id'='{oid}' AND published_at IS NULL")=='1'
        docker('compose','kill','-s','SIGKILL','api-gateway')
        docker('compose','unpause','nats');paused=False
        docker('start',docker('compose','ps','-aq','api-gateway').strip())
        wait_for(lambda:urllib.request.urlopen('http://localhost:8080/health',timeout=2).status==200)
        assert call('POST','/v1/customer/checkout/place',body)['order']['id']==oid
        print('PASS M4 publisher crash: committed order survived; identical retry returned the original order.')
    wait_for(lambda:facts(oid)==1)
    path='/v1/admin/orders/'+oid
    rejected(400,lambda:admin.call('POST',path+'/status',{'status':'cash_collected','reason':'Must reject before delivered'}))
    for status in ['confirmed','fulfilling','shipped','delivered','cash_collected']:
        d=admin.call('POST',path+'/dispatch',{'tracking_reference':'M4-'+unique,'reason':'M4 synthetic workflow'}) if status=='shipped' else admin.call('POST',path+'/status',{'status':status,'reason':'M4 synthetic workflow'})
        assert d['order']['status']==status
        assert call('GET','/v1/customer/orders/'+oid)['order']['status']==status
    assert d['payment']['collected_at'] and d['payment']['collected_by']
    rejected(400,lambda:admin.call('POST',path+'/status',{'status':'cash_collected','reason':'Duplicate'}))
    assert any(o['id']==oid for o in call('GET','/v1/customer/orders'))
    audit=admin.call('GET','/v1/admin/audit')
    assert any(a['entity_id']==oid and a['details'].get('to')=='cash_collected' for a in audit)
    wait_for(lambda:'LOCAL ORDER CONFIRMATION' in docker('compose','logs','--no-log-prefix','analytics-worker'))
    assert pg(f"SELECT count(*) FROM platform.outbox WHERE event_type='order.placed' AND payload->>'order_id'='{oid}' AND published_at IS NOT NULL")=='1'
    print('PASS M4: guest merge, verified checkout, exact flat fee, concurrent idempotency, stock commit, order history, COD lifecycle/audit, local confirmation and deduplicated order_facts.')
finally:
    if paused:docker('compose','unpause','nats')
    if args.replay:
        docker('start',docker('compose','ps','-aq','api-gateway').strip())
        wait_for(lambda:urllib.request.urlopen('http://localhost:8080/health',timeout=2).status==200)
    if product:admin.call('DELETE','/v1/admin/catalog/products/'+product['id'])
    if category:admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
