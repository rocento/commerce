
# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[4] / "commerce-ops/scripts"))

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

 import urllib.request
 planned=json.loads('[\n  {\n    "sku": "GRO-SEAFOOD-20261003-001",\n    "fields": {\n      "name": "فيليه سمك القد ٥٠٠ جم",\n      "description": "فيليه سمك القد منزوع الجلد بلحم أبيض خفيف النكهة. حجم العبوة: ٥٠٠ جم. يحتوي على الأسماك. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "فيليه سمك القد منزوع الجلد بلحم أبيض خفيف النكهة. عبوة ٥٠٠ جم. يحتوي على الأسماك.",\n      "attribute.meta_title": "فيليه سمك القد ٥٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "فيليه سمك القد منزوع الجلد بلحم أبيض خفيف النكهة. تسوّق عبوة ٥٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-002",\n    "fields": {\n      "name": "فيليه سمك البلطي ٥٠٠ جم",\n      "description": "فيليه سمك البلطي منزوع الجلد لوجبات السمك اليومية. حجم العبوة: ٥٠٠ جم. يحتوي على الأسماك. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "فيليه سمك البلطي منزوع الجلد لوجبات السمك اليومية. عبوة ٥٠٠ جم. يحتوي على الأسماك.",\n      "attribute.meta_title": "فيليه سمك البلطي ٥٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "فيليه سمك البلطي منزوع الجلد لوجبات السمك اليومية. تسوّق عبوة ٥٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-003",\n    "fields": {\n      "name": "سمك القاروص الكامل ٦٠٠ جم",\n      "description": "سمك قاروص كامل يُباع بالعظام والرأس والجلد. حجم العبوة: ٦٠٠ جم. يحتوي على الأسماك. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "سمك قاروص كامل يُباع بالعظام والرأس والجلد. عبوة ٦٠٠ جم. يحتوي على الأسماك.",\n      "attribute.meta_title": "سمك القاروص الكامل ٦٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "سمك قاروص كامل يُباع بالعظام والرأس والجلد. تسوّق عبوة ٦٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-004",\n    "fields": {\n      "name": "فيليه سمك الماكريل ٥٠٠ جم",\n      "description": "فيليه سمك الماكريل بالجلد بنكهة غنية. حجم العبوة: ٥٠٠ جم. يحتوي على الأسماك. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "فيليه سمك الماكريل بالجلد بنكهة غنية. عبوة ٥٠٠ جم. يحتوي على الأسماك.",\n      "attribute.meta_title": "فيليه سمك الماكريل ٥٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "فيليه سمك الماكريل بالجلد بنكهة غنية. تسوّق عبوة ٥٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-005",\n    "fields": {\n      "name": "سمك السردين الكامل ٥٠٠ جم",\n      "description": "سمك سردين كامل يُباع بالعظام والرؤوس والجلد. حجم العبوة: ٥٠٠ جم. يحتوي على الأسماك. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "سمك سردين كامل يُباع بالعظام والرؤوس والجلد. عبوة ٥٠٠ جم. يحتوي على الأسماك.",\n      "attribute.meta_title": "سمك السردين الكامل ٥٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "سمك سردين كامل يُباع بالعظام والرؤوس والجلد. تسوّق عبوة ٥٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-006",\n    "fields": {\n      "name": "حلقات الحبار ٥٠٠ جم",\n      "description": "حلقات حبار نيئة ومنظفة لأطباق المكرونة بالمأكولات البحرية والأطباق المقلية مع التقليب. حجم العبوة: ٥٠٠ جم. يحتوي على الرخويات. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "حلقات حبار نيئة ومنظفة لأطباق المكرونة بالمأكولات البحرية والأطباق المقلية مع التقليب. عبوة ٥٠٠ جم. يحتوي على الرخويات.",\n      "attribute.meta_title": "حلقات الحبار ٥٠٠ جم | Rocento للبقالة",\n      "attribute.meta_description": "حلقات حبار نيئة ومنظفة لأطباق المكرونة بالمأكولات البحرية والأطباق المقلية مع التقليب. تسوّق عبوة ٥٠٠ جم من Rocento للبقالة."\n    }\n  },\n  {\n    "sku": "GRO-SEAFOOD-20261003-007",\n    "fields": {\n      "name": "بلح البحر الكامل ١ كجم",\n      "description": "بلح بحر نيئ بقشره لأطباق شوربة المأكولات البحرية والمكرونة. حجم العبوة: ١ كجم. يحتوي على الرخويات. يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.",\n      "attribute.short_description": "بلح بحر نيئ بقشره لأطباق شوربة المأكولات البحرية والمكرونة. عبوة ١ كجم. يحتوي على الرخويات.",\n      "attribute.meta_title": "بلح البحر الكامل ١ كجم | Rocento للبقالة",\n      "attribute.meta_description": "بلح بحر نيئ بقشره لأطباق شوربة المأكولات البحرية والمكرونة. تسوّق عبوة ١ كجم من Rocento للبقالة."\n    }\n  }\n]\n')
 by_sku={p['sku']:p for p in rows}
 snapshots=[];result=[]
 for item in planned:
  product=by_sku[item['sku']];endpoint='/v1/admin/languages/ar/translations/product/'+product['id']
  current=c.call('GET',endpoint);snapshots.append(current)
  fields=item['fields']
  assert {k for k,v in current['source'].items() if v and not k.startswith('__label.')}==set(fields)
  if current['status']!='reviewed' or current['fields']!=fields:
   c.call('PUT',endpoint,{'expected_revision':current['revision'],'source':current['source'],'fields':fields,'reviewed':True})
  saved=c.call('GET',endpoint)
  assert saved['status']=='reviewed' and saved['fields']==fields
  request=urllib.request.Request(c.base+'/v1/catalog/products/'+product['id'],headers={'X-Storefront-Locale':'ar'})
  with c.http.open(request,timeout=60) as response:public=json.load(response)
  assert public['name']==fields['name'] and public['description']==fields['description']
  assert public['attributes']['short_description']==fields['attribute.short_description']
  english=c.call('GET','/v1/admin/catalog/products/'+product['id'])
  assert english==product,'Source product changed'
  result.append({'id':product['id'],'sku':item['sku'],'name':public['name'],'status':saved['status'],'translated_fields':len(fields)})
 print(json.dumps({'verified_arabic_products':len(result),'products':result,'before':snapshots},ensure_ascii=False,indent=2))
finally: c.call('POST','/v1/admin/auth/logout')
