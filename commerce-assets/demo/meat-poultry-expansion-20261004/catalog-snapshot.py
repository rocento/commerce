import json, os, shlex, socket, sys
from pathlib import Path
root=Path('/opt/rocento')
values={}
for line in (root/'deploy/ec2/bootstrap.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  key,value=line.split('=',1); tokens=shlex.split(value,comments=True); values[key.strip()]=tokens[0] if tokens else ''
host='admin.'+values['DOMAIN']; resolve=socket.getaddrinfo
socket.getaddrinfo=lambda h,p,*a,**kw:resolve('127.0.0.1' if h==host else h,p,*a,**kw)
os.environ['DEMO_SSL_CA_FILE']='/etc/nginx/ssl/rocento-origin.pem'
sys.path.insert(0,str(root/'assets/demo'))
from demo_seed import Client
c=Client('https://'+host+'/api')
c.call('POST','/v1/admin/auth/login',{'email':values['GROCERY_ADMIN_EMAIL'],'password':values['GROCERY_ADMIN_PASSWORD']})

try:
 rows=[]
 while True:
  batch=c.call('GET',f'/v1/admin/catalog/products?offset={len(rows)}');rows+=batch
  if len(batch)<50:break
 cats=c.call('GET','/v1/catalog/categories')
 cat=next(x for x in cats if x['slug']=='grocery-meat-poultry')
 result={'category':cat,'existing_products':[x for x in rows if x['category_id']==cat['id']],'all_names':[x['name'] for x in rows],'definitions':c.call('GET','/v1/admin/attribute-definitions?entity_type=product'),'languages':c.call('GET','/v1/admin/languages'),'sources':c.call('GET','/v1/admin/inventory/sources'),'stocks':c.call('GET','/v1/admin/inventory/stocks')}
 print(json.dumps(result,ensure_ascii=False,indent=2))
finally:c.call('POST','/v1/admin/auth/logout')
