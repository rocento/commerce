"""M5 local smoke; restores the fee, removes synthetic catalog/tax fixtures, retains order audit history."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import http.cookiejar
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from decimal import Decimal, ROUND_HALF_UP
from catalog_support import Client, ROOT
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
category=product=rule=None
fee_changed=False
fee=admin.call('GET','/v1/admin/settings/delivery-fee')
try:
    credentials={'identifier':'m5-'+unique+'@example.test','password':uuid.uuid4().hex}
    call('POST','/v1/customer/auth/register',credentials)
    token=call('POST','/v1/customer/auth/login',credentials)['access_token']
    logs=docker('compose','logs','--no-log-prefix','api-gateway')
    notices=[]
    for line in logs.splitlines():
        try:row=json.loads(line)
        except json.JSONDecodeError:continue
        if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:notices.append(row['fields'])
    assert notices
    call('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
    home=call('POST','/v1/customer/locations',{'label':'home','latitude':-60,'longitude':-130,'formatted_address':'Synthetic M5 zone','is_default':True})
    work=call('POST','/v1/customer/locations',{'label':'work','latitude':-59,'longitude':-129,'formatted_address':'Synthetic outside zone'})
    used={r['priority'] for r in admin.call('GET','/v1/admin/tax/rules')}
    priority=next(p for p in range(10000,-1,-1) if p not in used)
    body={'name':'M5 synthetic '+unique,'min_lat':-60.01,'max_lat':-59.99,'min_lon':-130.01,'max_lon':-129.99,'rate_bps':750,'tax_delivery':False,'priority':priority,'active':True}
    rule=admin.call('POST','/v1/admin/tax/rules',body)
    category=admin.call('POST','/v1/admin/catalog/categories',{'name':'M5 test','slug':'m5-'+unique,'parent_id':None})
    product=admin.call('POST','/v1/admin/catalog/products',{'sku':'M5-'+unique,'name':'M5 test bananas','slug':'m5-'+unique,'description':'Synthetic M5 fixture','price':'1.20','currency':'USD','unit':'lb','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
    admin.call('PUT','/v1/admin/inventory/'+product['id'],{'on_hand':10,'reason':'M5 fixture'})
    call('POST','/v1/cart')
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':2})
    q=call('POST','/v1/customer/checkout/quote',{'location_id':home['id']})
    net=Decimal(q['snapshot']['subtotal'])-Decimal(q['snapshot']['discount_amount'])
    assert Decimal(q['snapshot']['tax_amount'])==(net*Decimal('.075')).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)
    order=call('POST','/v1/customer/checkout/place',{'quote_id':q['id'],'idempotency_key':str(uuid.uuid4())})
    assert Decimal(order['order']['total'])==net+Decimal(q['snapshot']['tax_amount'])+Decimal(fee['amount'])
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':2})
    stale=call('POST','/v1/customer/checkout/quote',{'location_id':home['id']})
    admin.call('PUT','/v1/admin/settings/delivery-fee',{'amount':'4.25','reason':'M5 temporary verification'})
    fee_changed=True
    body['rate_bps']=1000
    admin.call('PUT','/v1/admin/tax/rules/'+rule['id'],body)
    rejected(400,lambda:call('POST','/v1/customer/checkout/place',{'quote_id':stale['id'],'idempotency_key':str(uuid.uuid4())}))
    q=call('POST','/v1/customer/checkout/quote',{'location_id':home['id']})
    net=Decimal(q['snapshot']['subtotal'])-Decimal(q['snapshot']['discount_amount'])
    tax=(net*Decimal('.10')).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)
    assert Decimal(q['snapshot']['tax_amount'])==tax and Decimal(q['snapshot']['total'])==net+tax+Decimal('4.25')
    second=call('POST','/v1/customer/checkout/place',{'quote_id':q['id'],'idempotency_key':str(uuid.uuid4())})
    previous=call('GET','/v1/customer/orders/'+order['order']['id'])
    assert previous['order']['total']==order['order']['total'] and previous['order']['tax_snapshot']['rate_bps']==750
    assert previous['order']['delivery_fee']==fee['amount']
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
    outside=call('POST','/v1/customer/checkout/quote',{'location_id':work['id']})
    assert outside['snapshot']['tax_snapshot']['rule_id']!=rule['id']
    call('DELETE','/v1/cart/items/'+product['id'])
    path='/v1/admin/orders/'+second['order']['id']
    for status in ['confirmed','fulfilling']:admin.call('POST',path+'/status',{'status':status,'reason':'M5 fixture'})
    rejected(400,lambda:admin.call('POST',path+'/status',{'status':'shipped','reason':'Must use dispatch'}))
    payload={'tracking_reference':'M5-TRACK-'+unique,'reason':'Synthetic dispatch'}
    d=admin.call('POST',path+'/dispatch',payload)
    assert d['order']['status']=='shipped' and d['dispatch']['items'][0]['quantity']==2
    assert admin.call('POST',path+'/dispatch',payload)['dispatch']['shipment']['id']==d['dispatch']['shipment']['id']
    customer=call('GET','/v1/customer/orders/'+second['order']['id'])
    assert customer['dispatch']['shipment']['tracking_reference']==payload['tracking_reference']
    delivered=admin.call('POST',path+'/status',{'status':'delivered','reason':'Synthetic delivery'})
    assert delivered['dispatch']['shipment']['status']=='delivered' and delivered['payment']['collected_at'] is None
    wait_for(lambda:payload['tracking_reference'] in docker('compose','logs','--no-log-prefix','api-gateway'))
    print('PASS M5: location-based tax, fee edits, stale-review rejection, immutable snapshots, full idempotent dispatch, customer tracking, separate cash status and local dispatch notification.')
finally:
    if fee_changed and admin.call('GET','/v1/admin/settings/delivery-fee')['amount']=='4.25':
        admin.call('PUT','/v1/admin/settings/delivery-fee',{'amount':fee['amount'],'reason':'Restore fee after M5 smoke'})
    if rule:pg("DELETE FROM tax.rules WHERE id='"+rule['id']+"'")
    if product:admin.call('DELETE','/v1/admin/catalog/products/'+product['id'])
    if category:admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
