"""Local two-zone M13 demo. Run `python3 scripts/m13-demo.py cleanup` afterward.

Uses the existing local admin login. Records only synthetic fixture IDs.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
import sys
import uuid
from catalog_support import Client,ROOT
from m8_db import pg
fixture=ROOT/'.local/m13-demo.json'
if len(sys.argv)>1 and sys.argv[1]=='cleanup':
    if fixture.exists():
        data=json.loads(fixture.read_text())
        ids=','.join("'"+str(uuid.UUID(x))+"'" for x in data['areas'])
        pg(f'DELETE FROM inventory.delivery_areas WHERE id IN ({ids});')
        fixture.unlink()
        print('Removed M13 demo zones; synthetic product and source history retained.')
    sys.exit()
if fixture.exists():
    print(f'Existing demo: {fixture}');sys.exit()
c=Client();tag=uuid.uuid4().hex[:8]
category=c.call('POST','/v1/admin/catalog/categories',{'name':'M13 demo '+tag,'slug':'m13-'+tag,'parent_id':None})
product=c.call('POST','/v1/admin/catalog/products',{'sku':'M13-'+tag,'name':'M13 Local Oranges '+tag,'slug':'m13-oranges-'+tag,'description':'Available in demo Zone A; unavailable in Zone B.','price':'2.00','currency':'USD','unit':'each','category_id':category['id'],'attributes':{},'media_ids':[],'active':True,'in_stock':True})
source=c.call('POST','/v1/admin/inventory/sources',{'code':'m13_b_'+tag,'name':'M13 B warehouse '+tag,'is_enabled':True,'address':'Synthetic fixture','latitude':31.0444,'longitude':31.2357,'contact_name':'','contact_phone':'','priority':0})
stock=c.call('POST','/v1/admin/inventory/stocks',{'code':'m13_b_'+tag,'name':'M13 B stock '+tag,'is_default':False,'sources':[{'source_id':source['id'],'priority':0}]})
default=next(s for s in c.call('GET','/v1/admin/inventory/stocks') if s['is_default'])
c.call('PUT','/v1/admin/inventory/'+product['id'],{'on_hand':20,'reason':'M13 demo Zone A'})
c.call('PUT','/v1/admin/inventory/'+product['id']+'/sources',{'source_id':source['id'],'quantity':0,'status':'in_stock','notify_stock_qty':0,'reason':'M13 demo Zone B'})
data={'product_id':product['id'],'name':product['name'],'areas':[],'pins':{'A':[30.0444,31.2357],'B':[31.0444,31.2357],'outside':[0,0]}}
fixture.parent.mkdir(exist_ok=True);fixture.write_text(json.dumps(data,indent=2)+'\n')
for name,lat,stock_id in [('A',30.0444,default['id']),('B',31.0444,stock['id'])]:
    area=c.call('POST','/v1/admin/inventory/delivery-areas',{'name':'M13 Demo '+name+' '+tag,'center_lat':lat,'center_lng':31.2357,'radius_km':10,'priority':-100,'is_active':True,'stocks':[{'stock_id':stock_id,'priority':0}]})
    data['areas'].append(area['id']);fixture.write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data,indent=2))
