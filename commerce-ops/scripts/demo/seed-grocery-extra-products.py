#!/usr/bin/env python3
"""Add 15 grocery pack sizes on EC2; preview by default, --apply to create.

Run from /opt/rocento. Reuses existing media and categories. Existing SKUs and
inventory are left untouched on reruns. No credentials are stored in this file.
"""

import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
import sys,json,shlex,os
from pathlib import Path
sys.path.insert(0,'commerce-assets/demo')
from demo_seed import Client
v={}
for line in Path('deploy/ec2/bootstrap.env').read_text().splitlines():
 if '=' in line and not line.startswith('#'):
  k,x=line.split('=',1); v[k]=shlex.split(x)[0] if shlex.split(x) else ''
import socket
original_resolve=socket.getaddrinfo
socket.getaddrinfo=lambda host,port,*a,**kw: original_resolve('127.0.0.1' if host=='admin.'+v['DOMAIN'] else host,port,*a,**kw)
os.environ['DEMO_SSL_CA_FILE']='/etc/nginx/ssl/rocento-origin.pem'
c=Client('https://admin.'+v['DOMAIN']+'/api')
c.call('POST','/v1/admin/auth/login',{'email':v['GROCERY_ADMIN_EMAIL'],'password':v['GROCERY_ADMIN_PASSWORD']})
try:
 cats=c.call('GET','/v1/catalog/categories')
 rows=[]
 off=0
 while True:
  batch=c.call('GET',f'/v1/admin/catalog/products?offset={off}'); rows+=batch
  if len(batch)<50: break
  off+=50
 items=[
 ('mangoes','Mangoes 500g','2.00','grocery-fruit'),
 ('red-grapes','Red Grapes 1kg','5.00','grocery-fruit'),
 ('pears','Pears 500g','1.50','grocery-fruit'),
 ('mushrooms','White Mushrooms 500g','3.75','grocery-vegetables'),
 ('zucchini','Zucchini 500g','1.00','grocery-vegetables'),
 ('cheddar-cheese','Cheddar Cheese 500g','5.50','grocery-dairy-eggs'),
 ('feta-cheese','Feta Cheese 500g','4.50','grocery-dairy-eggs'),
 ('croissants','Butter Croissants 6 Pack','5.50','grocery-bakery'),
 ('basmati-rice','Basmati Rice 2kg','5.50','grocery-pantry'),
 ('chickpeas','Chickpeas 1kg','3.25','grocery-pantry'),
 ('chicken-breast','Chicken Breast 1kg','8.50','grocery-meat-poultry'),
 ('beef-steak','Beef Steak 1kg','15.00','grocery-meat-poultry'),
 ('salmon-fillet','Salmon Fillet 600g','16.00','grocery-fish-seafood'),
 ('cashews','Cashews 500g','7.50','grocery-dates-nuts'),
 ('pistachios','Pistachios 500g','9.50','grocery-dates-nuts')]
 by_slug={p['slug']:p for p in rows}; by_sku={p['sku']:p for p in rows}; categories={x['slug']:x for x in cats}
 planned=[]
 for i,(source,name,price,category) in enumerate(items,1):
  old=by_slug['demo-grocery-white-'+source]
  assert old['media_ids'],name
  assert category in categories,category
  slug='grocery-'+name.lower().replace(' ','-')
  sku=f'GRO-EXTRA-20260929-{i:03}'
  assert slug not in by_slug or by_slug[slug]['sku']==sku,slug
  planned.append(dict(sku=sku,slug=slug,name=name,price=price,unit='pack',currency='USD',category_id=categories[category]['id'],attributes={},media_ids=old['media_ids'],active=True,in_stock=True,description=f"{name}. A convenient pack size for everyday shopping. Product image is illustrative; pack quantity is as stated in the product name."))
 sources=c.call('GET','/v1/admin/inventory/sources')
 enabled={x['id'] for x in sources if x['is_enabled']}
 stocks=c.call('GET','/v1/admin/inventory/stocks')
 source_ids={min((x for x in stock['sources'] if x['source_id'] in enabled),key=lambda x:x['priority'])['source_id'] for stock in stocks if any(x['source_id'] in enabled for x in stock['sources'])}
 created=[]
 created_count=0
 for payload in planned:
  product=by_sku.get(payload['sku'])
  if product:
   print('Kept existing:',payload['name'],flush=True)
   created.append(product['id'])
   continue
  if not args.apply:
   print('Would create:',payload['name'],flush=True)
   continue
  if not product:
   product=c.call('POST','/v1/admin/catalog/products',payload)
   created_count+=1
   print('Created:',payload['name'],flush=True)
  current=c.call('GET','/v1/admin/inventory/'+product['id']+'/sources')
  stocked={x['source_id'] for x in current if x['quantity']>0}
  for source_id in source_ids-stocked:
   c.call('PUT','/v1/admin/inventory/'+product['id']+'/sources',{'source_id':source_id,'quantity':30,'status':'in_stock','notify_stock_qty':5,'reason':'Initial stock for additional grocery demo pack size'})
  created.append(product['id'])
 verified=[]
 off=0
 while True:
  batch=c.call('GET',f'/v1/admin/catalog/products?offset={off}'); verified+=batch
  if len(batch)<50: break
  off+=50
 added=[p for p in verified if p['id'] in created]
 if args.apply:
  assert len(added)==15
  assert all(p['media_ids'] for p in added)
 print(json.dumps({'created':created_count,'apply':args.apply,'existing_or_created':len(added),'catalog_total':len(verified),'names':[p['name'] for p in added]}))
finally: c.call('POST','/v1/admin/auth/logout')
