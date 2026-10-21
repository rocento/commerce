#!/usr/bin/env python3
"""Preview/apply ten distinct bakery demo products using production admin APIs."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[4] / "commerce-ops/scripts"))

import argparse, fcntl, json, os, shlex, socket, sys
from pathlib import Path
from datetime import datetime, timezone
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets',type=Path,required=True)
parser.add_argument('--apply',action='store_true')
args=parser.parse_args()
root=Path('/opt/rocento')
lock=(root/'deploy/ec2/setup.lock').open('a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
values={}
for line in (root/'deploy/ec2/bootstrap.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  key,value=line.split('=',1); tokens=shlex.split(value,comments=True); values[key.strip()]=tokens[0] if tokens else ''
host='admin.'+values['DOMAIN']; resolve=socket.getaddrinfo
socket.getaddrinfo=lambda h,p,*a,**kw:resolve('127.0.0.1' if h==host else h,p,*a,**kw)
os.environ['DEMO_SSL_CA_FILE']='/etc/nginx/ssl/rocento-origin.pem'
sys.path.insert(0,str(root/'commerce-assets/demo'))
from demo_seed import Client
c=Client('https://'+host+'/api')
c.call('POST','/v1/admin/auth/login',{'email':values['GROCERY_ADMIN_EMAIL'],'password':values['GROCERY_ADMIN_PASSWORD']})
def products():
 rows=[]
 while True:
  batch=c.call('GET',f'/v1/admin/catalog/products?offset={len(rows)}'); rows.extend(batch)
  if len(batch)<50:return rows
try:
 before=products(); by_sku={p['sku']:p for p in before}; by_slug={p['slug']:p for p in before}
 category=next(x for x in c.call('GET','/v1/catalog/categories') if x['slug']=='grocery-bakery')
 definitions={d['attribute_code']:d for d in c.call('GET','/v1/admin/attribute-definitions?entity_type=product')}
 planned=json.loads((args.assets/'manifest.json').read_text())['products']
 assert len(planned)==len({p['sku'] for p in planned})==len({p['slug'] for p in planned})==10
 for p in planned:
  assert (args.assets/p['image']).is_file(),p['image']
  assert p['sku'] not in by_sku or all(by_sku[p['sku']][k]==p[k] for k in ('name','slug','attributes','price')),'Existing SKU conflict'
  assert p['slug'] not in by_slug or by_slug[p['slug']]['sku']==p['sku'],'Slug conflict'
  assert not any(old['name']==p['name'] and old['sku']!=p['sku'] for old in before),'Name conflict'
  for code,value in p['attributes'].items():
   d=definitions[code]
   if d['options']:
    assert all(v in {o['value'] for o in d['options']} for v in (value if isinstance(value,list) else [value])),(code,value)
 sources=c.call('GET','/v1/admin/inventory/sources'); enabled={s['id'] for s in sources if s['is_enabled']}
 stocks=c.call('GET','/v1/admin/inventory/stocks')
 source_ids={min((s for s in stock['sources'] if s['source_id'] in enabled),key=lambda s:s['priority'])['source_id'] for stock in stocks if any(s['source_id'] in enabled for s in stock['sources'])}
 assert source_ids
 print(json.dumps({'apply':args.apply,'planned':[p['name'] for p in planned],'inventory_sources_per_product':len(source_ids)}),flush=True)
 if args.apply:
  directory=Path('/var/log/rocento/catalog');directory.mkdir(parents=True,exist_ok=True)
  backup=directory/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-bakery-before.json')
  with backup.open('x') as f:
   os.fchmod(f.fileno(),0o600);json.dump(before,f)
  created=[]
  for p in planned:
   saved=by_sku.get(p['sku'])
   if not saved:
    media=c.upload(args.assets/p['image'],p['name']+' — AI-generated illustrative product photo')
    payload={k:p[k] for k in ('sku','slug','name','price','currency','unit','description','attributes')}
    payload.update(category_id=category['id'],media_ids=[media['id']],active=True,in_stock=True)
    saved=c.call('POST','/v1/admin/catalog/products',payload)
    created.append(saved['id']);print('Created: '+p['name'],flush=True)
   endpoint='/v1/admin/inventory/'+saved['id']+'/sources'
   inventory={x['source_id']:x for x in c.call('GET',endpoint)}
   for source_id in sorted(source_ids):
    assert source_id in inventory and 'is_assigned' in inventory[source_id]
    if not inventory[source_id]['is_assigned']:
     c.call('PUT',endpoint,{'source_id':source_id,'quantity':p['initial_quantity'],'status':'in_stock','notify_stock_qty':5,'reason':'Initial stock for ten new bakery demo products'})
  import urllib.request
  translated=[]
  all_products={p['sku']:p for p in products()}
  for item in json.loads((args.assets/'translations-ar.json').read_text()):
   saved=all_products[item['sku']];endpoint='/v1/admin/languages/ar/translations/product/'+saved['id']
   current=c.call('GET',endpoint);fields=item['fields']
   assert {k for k,v in current['source'].items() if v and not k.startswith('__label.')}==set(fields)
   if current['status']!='reviewed' or current['fields']!=fields:
    c.call('PUT',endpoint,{'expected_revision':current['revision'],'source':current['source'],'fields':fields,'reviewed':True})
   review=c.call('GET',endpoint)
   assert review['status']=='reviewed' and review['fields']==fields
   req=urllib.request.Request(c.base+'/v1/catalog/products/'+saved['id'],headers={'X-Storefront-Locale':'ar'})
   with c.http.open(req,timeout=60) as response: arabic=json.load(response)
   assert arabic['name']==fields['name'] and arabic['description']==fields['description'] and arabic['attributes']['short_description']==fields['attribute.short_description']
   translated.append({'sku':item['sku'],'name':arabic['name'],'status':review['status']})
  after=products();after_by_id={p['id']:p for p in after}; after_by_sku={p['sku']:p for p in after}
  for old in before:
   assert all(after_by_id[old['id']].get(k)==v for k,v in old.items() if k!='updated_at'),'Existing product changed'
  verified=[]
  for p in planned:
   saved=after_by_sku[p['sku']]
   assert all(saved[k]==p[k] for k in ('name','slug','price','attributes','description'))
   assert saved['category_id']==category['id'] and saved['active'] and saved['in_stock'] and saved['media_ids']
   public=c.call('GET','/v1/catalog/products/'+saved['id'])
   assert public['active'] and public['media_ids'] and public['attributes']=={k:v for k,v in p['attributes'].items() if k not in ('meta_title','meta_description')}
   stock=c.call('GET','/v1/admin/inventory/'+saved['id']+'/sources')
   assert all(any(x['source_id']==s and x['is_assigned'] and x['quantity']>0 for x in stock) for s in source_ids)
   verified.append({'id':saved['id'],'name':saved['name'],'slug':saved['slug'],'price':saved['price'],'attribute_count':len(saved['attributes'])})
  result={'created_count':len(created),'verified_count':len(verified),'existing_products_unchanged':len(before),'backup':str(backup),'products':verified,'arabic_translations':translated}
  (args.assets/'result.json').write_text(json.dumps(result,indent=2)+'\n')
  print(json.dumps(result),flush=True)
finally:
 c.call('POST','/v1/admin/auth/logout');socket.getaddrinfo=resolve;lock.close()
