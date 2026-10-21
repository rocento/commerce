"""M11 real-provider regression. --keep-demo retains synthetic catalog fixtures for browser QA.
Credentials remain private under .local. Existing catalog and orders are never rewritten.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import http.cookiejar
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from decimal import Decimal
from catalog_support import Client, ROOT
parser=argparse.ArgumentParser();parser.add_argument('--keep-demo',action='store_true');args=parser.parse_args()
admin=Client();unique='m11-'+uuid.uuid4().hex[:8];code='pack_'+unique.replace('-','_');spice='spice_'+unique.replace('-','_');products=[];definitions=[];category=None
http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));token=None

def public(method,path,body=None):
    headers={'Content-Type':'application/json','X-Commerce-Request':'1'}
    if token:headers['Authorization']='Bearer '+token
    request=urllib.request.Request('http://localhost:5173/api'+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with http.open(request,timeout=30) as r:return json.load(r)

def definition(code,label):
    return {'id':str(uuid.uuid4()),'entity_type':'product','attribute_code':code,'label':label,'input_type':'select','scope':'global','is_required':False,'is_unique':False,'is_searchable':True,'is_filterable':True,'is_comparable':False,'is_visible_on_front':True,'used_for_promo_rules':False,'used_for_configurations':False,'swatch_type':'text','options':[],'version':0}

def product(sku,name,price,attributes=None):
    p=admin.call('POST','/v1/admin/catalog/products',{'sku':unique+'-'+sku,'slug':unique+'-'+sku,'name':name,'description':'Synthetic M11 demonstration','price':price,'currency':'USD','unit':'each','category_id':category['id'],'attributes':attributes or {},'media_ids':[],'active':True,'in_stock':False});products.append(p);return p

def link(p,group=''):return {'child_id':p['id'],'option_label':group,'quantity':1}
def structure(p,kind,children,attrs=None):return admin.call('PUT','/v1/admin/catalog/products/'+p['id']+'/family',{'product_type':kind,'configurable_attributes':attrs or [],'children':children})
def wait_search(query,predicate):
    deadline=time.monotonic()+150
    while time.monotonic()<deadline:
        r=public('GET','/v1/search?'+urllib.parse.urlencode(query))
        if predicate(r):return r
        time.sleep(.4)
    raise AssertionError('Search indexing did not converge for M11 fixtures')
def reject(fn):
    try:fn()
    except urllib.error.HTTPError as e:
        assert e.code in [400,404,409],(e.code,e.read())
    else:raise AssertionError('Invalid operation succeeded')

success=False
try:
    category=admin.call('POST','/v1/admin/catalog/categories',{'name':'M11 demo '+unique,'slug':unique,'parent_id':None})
    d=definition(code,'Pack size');d.update(used_for_configurations=True,options=[{'value':'500ml','label':'500 ml'},{'value':'1l','label':'1 L'},{'value':'2l','label':'2 L'}]);definitions.append(admin.call('POST','/v1/admin/attribute-definitions',d))
    d=definition(spice,'Spice level');d.update(options=[{'value':'mild','label':'Mild'},{'value':'hot','label':'Hot'}]);definitions.append(admin.call('POST','/v1/admin/attribute-definitions',d))
    oil=product('oil','Olive Oil · M11','0.00',{spice:'mild'})
    variants=[product('oil-'+size,'Olive Oil '+size,price,{code:size,spice:'mild'}) for size,price in [('500ml','4.00'),('1l','7.00'),('2l','12.00')]]
    for p in variants:admin.call('PUT','/v1/admin/inventory/'+p['id'],{'on_hand':8,'reason':'M11 demo variant stock'})
    family=structure(oil,'configurable',[link(p) for p in variants],[code]);assert len(family['children'])==3
    assert all(p['parent_id']==oil['id'] for p in family['children'])
    basics=[product('bread','Breakfast bread','2.00'),product('eggs','Breakfast eggs','3.00'),product('milk','Breakfast milk','4.00')]
    for p in basics:admin.call('PUT','/v1/admin/inventory/'+p['id'],{'on_hand':8,'reason':'M11 demo stock'})
    breakfast=product('breakfast','Breakfast Basics · M11','0.00');structure(breakfast,'grouped',[link(p) for p in basics])
    basket=product('basket','Build your basket · M11','0.00');structure(basket,'bundle',[link(basics[0],'Bread'),link(basics[1],'Protein'),link(basics[2],'Protein')])
    r=wait_search({'category_id':category['id']},lambda r:any(p['id']==oil['id'] for p in r['hits']) and not any(p['id'] in [v['id'] for v in variants] for p in r['hits']) and r['total']==6)
    assert len([p for p in r['hits'] if p['id']==oil['id']])==1
    filtered=wait_search({'category_id':category['id'],'attribute_filters':json.dumps({spice:'mild'})},lambda r:any(p['id']==oil['id'] for p in r['hits']))
    assert filtered['total']==1
    credentials={'identifier':unique+'@example.test','password':uuid.uuid4().hex};public('POST','/v1/customer/auth/register',credentials);token=public('POST','/v1/customer/auth/login',credentials)['access_token']
    logs=subprocess.check_output(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'logs','--no-log-prefix','api-gateway'],cwd=ROOT,text=True)
    notices=[]
    for line in logs.splitlines():
        try:row=json.loads(line)
        except json.JSONDecodeError:continue
        if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:notices.append(row['fields'])
    assert notices;public('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
    public('POST','/v1/cart');reject(lambda:public('POST','/v1/cart/items',{'product_id':oil['id'],'quantity':1}))
    public('POST','/v1/cart/items',{'product_id':variants[0]['id'],'quantity':1});cart=public('POST','/v1/cart/items',{'product_id':variants[1]['id'],'quantity':2})
    assert len(cart['items'])==2 and Decimal(cart['subtotal'])==Decimal('18.00')
    for p in variants[:2]:public('DELETE','/v1/cart/items/'+p['id'])
    cart=public('POST','/v1/cart/bundles/'+basket['id'],{'selected':[basics[0]['id'],basics[1]['id']]});assert Decimal(cart['subtotal'])==Decimal('5.00')
    for p in basics[:2]:public('DELETE','/v1/cart/items/'+p['id'])
    profile=public('PUT','/v1/customer/profile',{'first_name':'M11','last_name':'Customer','date_of_birth':'1990-01-01','gender':'prefer_not_to_say','attributes':{}});assert profile['customer_group']=='general'
    public('POST','/v1/cart/items',{'product_id':variants[2]['id'],'quantity':1})
    location=public('POST','/v1/customer/locations',{'label':'home','latitude':-58,'longitude':-128,'formatted_address':'M11 synthetic destination','is_default':True})
    quote=public('POST','/v1/customer/checkout/quote',{'location_id':location['id'],'gift_message':'Happy birthday from M11'})
    order=public('POST','/v1/customer/checkout/place',{'quote_id':quote['id'],'idempotency_key':str(uuid.uuid4())})
    assert order['order']['gift_message']=='Happy birthday from M11'
    ext=public('GET','/v1/customer/orders/'+order['order']['id']+'/extensions');assert ext['state']=='new' and ext['delivery_location_snapshot']==order['order']['location']
    admin.call('POST','/v1/admin/orders/'+order['order']['id']+'/comments',{'body':'M11 internal-only note'})
    assert 'M11 internal-only note' not in json.dumps(public('GET','/v1/customer/orders/'+order['order']['id']))
    success=True
    print('PASS M11: typed definitions/filtering, one configurable listing, independent variants, grouped children, bundle additions, profile, gift/location snapshots and private order notes.')
    if args.keep_demo:
        (ROOT/'.local/m11-demo.json').write_text(json.dumps({'prefix':unique,'category':category,'definitions':definitions,'products':products,'oil':oil,'breakfast':breakfast,'basket':basket,'credentials':credentials},indent=2))
        print('Retained synthetic M11 browser fixtures; manifest: .local/m11-demo.json')
finally:
    if not (success and args.keep_demo):
        for p in products:
            if p['sku'].endswith(('-oil','-breakfast','-basket')):
                try:structure(p,'simple',[])
                except urllib.error.HTTPError:pass
        for p in reversed(products):admin.call('DELETE','/v1/admin/catalog/products/'+p['id'])
        for d in definitions:admin.call('DELETE','/v1/admin/attribute-definitions/'+d['id'])
        if category:admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
