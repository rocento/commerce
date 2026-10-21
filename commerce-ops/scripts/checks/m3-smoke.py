"""M3 full-provider check. --expiry-base targets a gateway with a short reservation TTL."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

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
parser.add_argument('--expiry-base')
args=parser.parse_args()
admin=Client()
class Guest:
    def __init__(self,base='http://localhost:5173/api'):
        self.base=base
        self.http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.token=None
        self.call('POST','/v1/cart')
    def call(self,method,path,body=None):
        headers={'Content-Type':'application/json','X-Commerce-Request':'1'}
        if self.token:headers['Authorization']='Bearer '+self.token
        request=urllib.request.Request(self.base+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers=headers)
        with self.http.open(request,timeout=15) as response:return json.load(response)
    def login(self,credentials):
        self.token=self.call('POST','/v1/customer/auth/login',credentials)['access_token']
    def logout(self):
        self.call('POST','/v1/customer/auth/logout');self.token=None

def analytics(cart,event_type,reason=None,table="checkout_funnel_events"):
    assert table in {"checkout_funnel_events", "add_to_cart_events"}
    condition=f"cart_id='{cart}' AND event_type='{event_type}'"
    if reason:condition+=f" AND reason='{reason}'"
    sql=f'SELECT count() FROM commerce_analytics.{table} FINAL WHERE {condition}'
    result=subprocess.run(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'exec','-T','clickhouse','sh','-c','exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"','sh',sql],cwd=ROOT,capture_output=True,text=True,check=True)
    return int(result.stdout.strip())

def wait_for(fn,timeout=30):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        result=fn()
        if result:return result
        time.sleep(.3)
    raise AssertionError('Timed out waiting for reservation/event convergence')

unique=uuid.uuid4().hex[:10]
category=None;product=None;people=[]
try:
    category=admin.call('POST','/v1/admin/catalog/categories',{'name':'M3 test','slug':'m3-'+unique,'parent_id':None})
    product=admin.call('POST','/v1/admin/catalog/products',{'sku':'M3-'+unique,'name':'M3 Bananas '+unique,'slug':'m3-banana-'+unique,'description':'Temporary M3 fixture','price':'1.20','currency':'USD','unit':'lb','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
    path='/v1/admin/inventory/'+product['id']
    admin.call('PUT',path,{'on_hand':1,'reason':'Last-unit race fixture'})
    a,b=Guest(),Guest();people.extend([a,b])
    def add(person):
        try:return person.call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
        except urllib.error.HTTPError as e:
            assert e.code==400,(e.code,e.read())
            error=json.load(e)['error'];assert 'Only 0 units available' in error,error
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(add,[a,b]))
    assert sum(r is not None for r in results)==1
    winner,loser=(a,b) if results[0] is not None else (b,a)
    assert admin.call('GET',path)['stock']['reserved']==1
    try:admin.call('PUT',path,{'on_hand':0,'reason':'Should be rejected'})
    except urllib.error.HTTPError as e:assert e.code==400
    else:raise AssertionError('Reserved stock was reduced')
    winner.call('DELETE','/v1/cart/items/'+product['id'])
    assert add(loser) is not None
    loser.call('DELETE','/v1/cart/items/'+product['id'])
    assert add(winner) is not None
    credentials={'identifier':'m3-'+unique+'@example.test','password':'M3 test password '+unique+'!'}
    winner.call('POST','/v1/customer/auth/register',credentials)
    winner.login(credentials)
    cart=winner.call('POST','/v1/cart');assert cart['customer_id'] and cart['items'][0]['quantity']==1
    account_cart=cart['id'];winner.logout()
    assert winner.call('POST','/v1/cart')['items']==[]
    restored=Guest();people.append(restored);restored.login(credentials)
    assert restored.call('POST','/v1/cart')['id']==account_cart
    admin.call('PUT',path,{'on_hand':2,'reason':'Merge fixture'})
    assert add(loser) is not None
    loser.login(credentials)
    cart=loser.call('POST','/v1/cart');assert cart['id']==account_cart and cart['items'][0]['quantity']==2 and cart['items'][0]['reserved_quantity']==2 and cart['subtotal']=='2.40'
    assert loser.call('POST','/v1/cart')['items'][0]['quantity']==2
    loser.call('PUT','/v1/cart/items/'+product['id'],{'quantity':1})
    assert admin.call('GET',path)['stock']['available']==1
    loser.call('DELETE','/v1/cart/items/'+product['id'])
    assert admin.call('GET',path)['stock']['available']==2
    wait_for(lambda:analytics(account_cart,'cart.item_added'))
    wait_for(lambda:analytics(account_cart,'cart.item_added',table='add_to_cart_events'))
    wait_for(lambda:analytics(account_cart,'inventory.released'))
    if args.expiry_base:
        admin.call('PUT',path,{'on_hand':1,'reason':'Expiry fixture'})
        short=Guest(args.expiry_base);people.append(short)
        held=short.call('POST','/v1/cart/items',{'product_id':product['id'],'quantity':1})
        assert held['fully_reserved']
        wait_for(lambda:admin.call('GET',path)['stock']['available']==1)
        expired=short.call('POST','/v1/cart');assert expired['items'][0]['quantity']==1 and expired['items'][0]['reserved_quantity']==0 and not expired['fully_reserved']
        wait_for(lambda:analytics(held['id'],'inventory.released','expired'))
        short.call('DELETE','/v1/cart/items/'+product['id'])
        print('PASS M3 live short-TTL worker: released stock, retained cart item, and delivered expiry event to ClickHouse.')
    print('PASS M3: last-unit race, removal release, adjustment protection, automatic guest merge, cross-session persistence, exact subtotal, quantity updates and durable cart/inventory analytics.')
finally:
    if product:
        for person in people:
            try:person.call('DELETE','/v1/cart/items/'+product['id'])
            except Exception:pass
        admin.call('DELETE','/v1/admin/catalog/products/'+product['id'])
    if category:admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
