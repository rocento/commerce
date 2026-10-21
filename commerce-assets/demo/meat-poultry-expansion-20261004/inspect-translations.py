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
 defs=c.call('GET','/v1/admin/attribute-definitions?entity_type=product')
 codes=['grocery-pack-size','grocery_group','ingredient_role','meal_occasion','preparation_method','dish_type','short_description']
 print(json.dumps({d['attribute_code']:c.call('GET','/v1/admin/languages/ar/translations/attribute/'+d['id']) for d in defs if d['attribute_code'] in codes},ensure_ascii=False,indent=2))
finally:c.call('POST','/v1/admin/auth/logout')
