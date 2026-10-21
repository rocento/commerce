"""Synthetic local UI fixture. No connection to production data.
Admin: API_PROXY_TARGET=http://127.0.0.1:18089 API_PROXY_ORIGIN=http://127.0.0.1:5184
Storefront: same target, API_PROXY_ORIGIN=http://127.0.0.1:5183
Draft reads deliberately fail through the storefront to exercise the preview bridge.
"""
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / 'packages/api-client/src/theme-contract.json').read_text())['default']
for section in CONFIG['pages']['home']:
    if section['component'] == 'hero': section['settings']['heading'] = 'Authorized preview works'
ID = '11111111-1111-4111-8111-111111111111'
THEME = dict(id=ID, name='Preview test theme', owner_channel='storefront', revision=1, configuration=CONFIG, published_version=None, updated_at='2026-09-21T08:00:00Z')
AREAS = []
for i in range(52):
    lat, lng = 30.01 + (i//8)*.022, 31.18 + (i%8)*.022
    AREAS.append(dict(id=f'area-{i}', name=f'Delivery area {i+1:02}', boundary=[dict(latitude=lat,longitude=lng),dict(latitude=lat+.018,longitude=lng),dict(latitude=lat+.018,longitude=lng+.018),dict(latitude=lat,longitude=lng+.018)], center_lat=lat, center_lng=lng, radius_km=1, priority=i, is_active=i%4!=0, stocks=[dict(stock_id=ID,priority=0)]))
AREAS[0].update(name='Central Cairo', boundary=None, radius_km=1.2)
CATEGORIES = [dict(id=f'category-{i}',name=name,slug=name.lower().replace(' ','-'),parent_id=parent,thumbnail=None,banner=None) for i,(name,parent) in enumerate([('Clothing',None),('Women','category-0'),('Dresses','category-1'),('Men','category-0'),('Shoes',None),('Sneakers','category-4')])]
ASSIGNMENT = dict(channel='storefront',theme_id=ID,revision=1,rules=[])
ROLES = [dict(id='fixture-role',name='Catalog reviewer',system=False,permissions=['catalog.read','theme.preview@storefront'])]
COUNTS = {'admin_preview':0,'storefront_preview':0,'source_deletes':0}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, data, status=200):
        body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
    def do_GET(self):
        path=urlparse(self.path).path
        if path == '/fixture/counts': return self.reply(COUNTS)
        if path == '/v1/catalog/media/fixture-cover/content':
            body=b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#f4eee5"/><path d="M24 16h32v49H24z" fill="#708968"/><path d="M24 16h32v10H24z" fill="#a5b698"/><circle cx="40" cy="43" r="10" fill="#faf7e9"/></svg>'
            self.send_response(200);self.send_header('Content-Type','image/svg+xml');self.end_headers();return self.wfile.write(body)
        if path == '/v1/catalog/media/fixture-broken/content': return self.reply({'error':'Missing image'},404)
        if path == '/v1/admin/me': return self.reply({'user':{'id':ID,'name':'Workflow test admin','email':'fixture@example.test','active':True,'role_id':ID},'permissions':['*']})
        if path == '/v1/admin/themes': return self.reply([{**THEME,'published_version':'version-1'}])
        if path.endswith('/preview'):
            admin=self.headers.get('Origin')=='http://127.0.0.1:5184';COUNTS['admin_preview' if admin else 'storefront_preview']+=1
            return self.reply(CONFIG if admin else {'error':'Storefront has no admin session'},200 if admin else 403)
        if path == '/v1/admin/themes/assignments': return self.reply([ASSIGNMENT])
        if path == '/v1/admin/themes/target-options/storefront': return self.reply(dict(segments=[],stocks=[],areas=AREAS))
        if path in ['/v1/admin/catalog/categories','/v1/catalog/categories']: return self.reply(CATEGORIES)
        if path.startswith('/v1/admin/catalog/categories/') and path.endswith('/attributes'): return self.reply({})
        if path.endswith('/versions'): return self.reply([])
        if path.endswith('/delivery-areas') and '/admin/' in path: return self.reply(AREAS)
        if path == '/v1/admin/inventory/stocks': return self.reply([dict(id=ID,name='Main fulfillment stock')])
        if path.endswith('/sorts'): return self.reply(['id','name'])
        if '/grids/' in path:
            name=path.rsplit('/',1)[1]
            rows=[]
            if name=='roles': rows=ROLES
            if name=='catalog': rows=[dict(id=f'product-{i}',name=label,sku=f'TEST-{i}',media_ids=media,price='12.00',unit='each',active=True) for i,(label,media) in enumerate([('Organic green tea',['fixture-cover']),('Product without image',[]),('Product with unavailable image',['fixture-broken'])])]
            if name=='sources': rows=[dict(id=ID,name='Main warehouse',code='MAIN',is_enabled=True,address='Cairo',latitude=30.04,longitude=31.23,contact_name='',contact_phone='',priority=0)]
            if name=='stocks': rows=[dict(id=ID,name='Default stock',code='default',is_default=True,sources=[])]
            if name=='support': rows=[dict(id=ID,number=1042,subject='Delivery question',category='order',priority='normal',status='open',created_at='2026-09-21T08:00:00Z')]
            return self.reply(dict(items=rows,next_cursor=None,total_count=len(rows)))
        if path.startswith('/v1/content/'): return self.reply(dict(blocks=[]))
        if path.startswith('/v1/theme/'): return self.reply(dict(configuration=CONFIG,cities=[],version_id=None))
        if 'search' in path or path.endswith('/products'): return self.reply(dict(hits=[],total=0,facets={},next_cursor=None))
        if path.endswith('/cart'): return self.reply(dict(items=[],subtotal='0.00',total='0.00',currency='USD'))
        if path.endswith('/me') or 'session' in path: return self.reply({'error':'No customer session'},401)
        return self.reply([])
    def do_DELETE(self):
        COUNTS['source_deletes']+=1
        return self.reply({'error':'Fixture deletion rejected: source is in use'},409)
    def do_PUT(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        if self.path.startswith('/v1/admin/roles/'):
            role=next((r for r in ROLES if r['id']==self.path.rsplit('/',1)[1]),None)
            if not role: return self.reply({},404)
            role.update(body); return self.reply(role)
        if self.path.startswith('/v1/admin/catalog/categories/'):
            category=next((c for c in CATEGORIES if c['id']==self.path.rsplit('/',1)[1]),None)
            if not category: return self.reply({},404)
            category.update(body); return self.reply(category)
        if self.path=='/v1/admin/themes/assignments/storefront':
            if body['expected_revision']!=ASSIGNMENT['revision']: return self.reply({'error':'Revision conflict'},409)
            ASSIGNMENT.update(theme_id=body['theme_id'],rules=body['rules'],revision=ASSIGNMENT['revision']+1)
            COUNTS['last_assignment']=ASSIGNMENT.copy(); return self.reply(ASSIGNMENT)
        return self.reply({})
    def do_POST(self):
        if self.path=='/v1/admin/roles':
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            role=dict(**body,id=f'role-{len(ROLES)}',system=False);ROLES.append(role);return self.reply(role)
        if self.path=='/v1/admin/catalog/categories':
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            category=dict(**body,id=f'category-{len(CATEGORIES)}',thumbnail=None,banner=None);CATEGORIES.append(category);return self.reply(category)
        if '/cart' in self.path: return self.reply(dict(id=ID,items=[],subtotal='0.00',total='0.00',currency='USD',discounts=[]))
        return self.reply({})
if __name__=='__main__':
    print('Synthetic admin workflow API: http://127.0.0.1:18089',flush=True)
    ThreadingHTTPServer(('127.0.0.1',18089),Handler).serve_forever()
