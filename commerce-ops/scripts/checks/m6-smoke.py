"""M6 local promotion regression. Removes synthetic rules/catalog, retains order/audit history."""

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
from decimal import Decimal
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
category=product=None
rules=[]
try:
    credentials={'identifier':'m6-'+unique+'@example.test','password':uuid.uuid4().hex}
    call('POST','/v1/customer/auth/register',credentials)
    token=call('POST','/v1/customer/auth/login',credentials)['access_token']
    notices=[]
    for line in docker('compose','logs','--no-log-prefix','api-gateway').splitlines():
        try:row=json.loads(line)
        except json.JSONDecodeError:continue
        if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:notices.append(row['fields'])
    assert notices
    call('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
    home=call('POST','/v1/customer/locations',{'label':'home','latitude':-58,'longitude':-128,'formatted_address':'Synthetic M6 destination','is_default':True})
    category=admin.call('POST','/v1/admin/catalog/categories',{'name':'M6 test','slug':'m6-'+unique,'parent_id':None})
    product=admin.call('POST','/v1/admin/catalog/products',{'sku':'M6-'+unique,'name':'M6 test groceries','slug':'m6-'+unique,'description':'Synthetic M6 fixture','price':'1.20','currency':'USD','unit':'each','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
    admin.call('PUT','/v1/admin/inventory/'+product['id'],{'on_hand':60,'reason':'M6 fixture'})
    body={'name':'M6 coupon '+unique,'scope':'cart','kind':'percentage','value':'10','coupon_code':'M6-'+unique,'min_subtotal':'20','skus':[product['sku']],'category_ids':[],'customer_group':'verified','priority':10000,'active':True,'starts_at':None,'ends_at':None}
    coupon=admin.call('POST','/v1/admin/promotions',body);rules.append(coupon['id'])
    call('POST','/v1/cart')
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':2})
    try:call('PUT','/v1/cart/coupon',{'code':coupon['coupon_code']})
    except urllib.error.HTTPError as e:
        assert e.code==400 and 'Minimum cart value not met' in json.load(e)['error']
    else:raise AssertionError('Coupon minimum was not enforced')
    call('PUT','/v1/cart/items/'+product['id'],{'quantity':20})
    cart=call('PUT','/v1/cart/coupon',{'code':coupon['coupon_code'].lower()})
    assert Decimal(cart['discount_amount'])==Decimal('2.40')
    stale=call('POST','/v1/customer/checkout/quote',{'location_id':home['id']})
    catalog_body={**body,'name':'M6 catalog '+unique,'scope':'catalog','coupon_code':None,'min_subtotal':'0','category_ids':[category['id']]}
    catalog=admin.call('POST','/v1/admin/promotions',catalog_body);rules.append(catalog['id'])
    rejected(400,lambda:call('POST','/v1/customer/checkout/place',{'quote_id':stale['id'],'idempotency_key':str(uuid.uuid4())}))
    q=call('POST','/v1/customer/checkout/quote',{'location_id':home['id']})
    assert Decimal(q['snapshot']['discount_amount'])==Decimal('4.56')
    assert sum(Decimal(a['amount']) for a in q['snapshot']['discount_snapshot'])==Decimal('4.56')
    expected=Decimal('19.44')+Decimal(q['snapshot']['delivery_fee'])+Decimal(q['snapshot']['tax_amount'])
    assert Decimal(q['snapshot']['total'])==expected
    payload={'quote_id':q['id'],'idempotency_key':str(uuid.uuid4())}
    order=call('POST','/v1/customer/checkout/place',payload)
    assert order['payment']['amount_due']==order['order']['total']
    assert Decimal(order['items'][0]['discount_amount'])==Decimal('4.56')
    for rule in list(rules):admin.call('DELETE','/v1/admin/promotions/'+rule);rules.remove(rule)
    assert call('POST','/v1/customer/checkout/place',payload)==order
    assert call('GET','/v1/customer/orders/'+order['order']['id'])==order
    assert admin.call('GET','/v1/admin/orders/'+order['order']['id'])==order
    assert call('POST','/v1/cart')['coupon_code'] is None
    # A fixed coupon is capped at the eligible subtotal, then disabled coupons fail closed.
    fixed=admin.call('POST','/v1/admin/promotions',{**body,'name':'M6 fixed '+unique,'kind':'fixed','value':'100','min_subtotal':'0'})
    rules.append(fixed['id'])
    call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
    cart=call('PUT','/v1/cart/coupon',{'code':fixed['coupon_code']})
    assert Decimal(cart['discount_amount'])==Decimal('1.20')
    admin.call('PUT','/v1/admin/promotions/'+fixed['id'],{**body,'name':'M6 fixed '+unique,'kind':'fixed','value':'100','min_subtotal':'0','active':False})
    assert call('POST','/v1/cart')['coupon_error']
    rejected(400,lambda:call('POST','/v1/customer/checkout/quote',{'location_id':home['id']}))
    call('PUT','/v1/cart/coupon',{'code':''})
    call('DELETE','/v1/cart/items/'+product['id'])
    print('PASS M6: minimum spend, catalog/coupon precedence, fixed caps, stale-review rejection, per-item/order snapshots, deletion immutability, COD amount and coupon removal.')
finally:
    for rule in rules:admin.call('DELETE','/v1/admin/promotions/'+rule)
    if product:admin.call('DELETE','/v1/admin/catalog/products/'+product['id'])
    if category:admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
