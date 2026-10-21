"""M7 live CMS, 120-product operations, moderation and wishlist regression.
Only synthetic records owned by this run are removed; audit history is retained.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import csv
import io
import json
import subprocess
import urllib.error
import urllib.request
import uuid
from decimal import Decimal
from catalog_support import Client, ROOT

admin = Client()
unique = 'm7-' + uuid.uuid4().hex[:10]
products = []
category = document = customer = saved = None
token = None

def public(method, path, body=None):
    headers = {'Content-Type': 'application/json', 'X-Commerce-Request': '1'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request('http://localhost:5173/api' + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def docker(*args):
    if args and args[0] == 'compose':
        args = ('compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), *args[1:])
    return subprocess.check_output(['docker', *args], cwd=ROOT, text=True, stderr=subprocess.STDOUT)

def pg(sql):
    return docker('compose', 'exec', '-T', 'postgres', 'sh', '-c',
        'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'sh', sql).strip()

def rejected(status, fn):
    try:
        fn()
    except urllib.error.HTTPError as error:
        assert error.code == status, (error.code, error.read())
    else:
        raise AssertionError('Expected rejection')

try:
    category = admin.call('POST', '/v1/admin/catalog/categories', {'name': unique, 'slug': unique, 'parent_id': None})
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(['sku','slug','name','description','price','currency','unit','category_id','attributes','media_ids','active'])
    for index in range(120):
        sku = f'{unique}-{index:03}'
        writer.writerow([sku,sku,'M7 test '+sku,'Quoted, multiline\ncontent','1.05','USD','each',category['id'],'{}','[]','true'])
    payload = {'csv': stream.getvalue(), 'preview': True, 'reason': 'M7 120-product regression'}
    assert admin.call('POST', '/v1/admin/operations/catalog/import', payload)['count'] == 120
    assert admin.call('GET', '/v1/admin/operations/products?q='+unique)['total'] == 0
    assert admin.call('POST', '/v1/admin/operations/catalog/import', {**payload, 'preview': False})['count'] == 120
    products = admin.call('GET', '/v1/admin/operations/product-ids?q='+unique)
    assert len(products) == 120
    page = admin.call('GET', '/v1/admin/operations/products?q='+unique)
    assert page['total'] == 120 and len(page['items']) == 100
    assert len(admin.call('GET', '/v1/admin/operations/products?q='+unique+'&offset=100')['items']) == 20
    batch = admin.call('POST', '/v1/admin/operations/bulk', {'ids': products, 'price_adjustment_pct':'10', 'reason':'M7 exact 120-product batch'})
    assert batch['count'] == 120
    rows = admin.call('GET', '/v1/admin/operations/products?q='+unique)['items']
    assert all(Decimal(p['price']) == Decimal('1.16') for p in rows)
    audit = admin.call('GET', '/v1/admin/audit?q='+batch['operation_id'])
    assert len(audit) == 1 and audit[0]['details']['count'] == 120
    exported = admin.call('GET', '/v1/admin/operations/catalog/export?q='+unique)['csv']
    assert len(list(csv.reader(io.StringIO(exported)))) == 121
    assert admin.call('POST', '/v1/admin/operations/catalog/import', {'csv':exported,'preview':True,'reason':'Roundtrip'})['count'] == 120
    inventory = 'sku,on_hand,reason\n'+rows[0]['sku']+',7,M7 fixture\n'
    assert admin.call('POST','/v1/admin/operations/inventory/import',{'csv':inventory,'preview':False,'reason':'M7 inventory'})['count'] == 1
    saved = admin.call('POST','/v1/admin/filters',{'name':unique,'filters':{'q':unique}})
    assert any(f['id']==saved['id'] for f in admin.call('GET','/v1/admin/filters'))
    draft = {'key':unique,'kind':'page','expected_version':0,'title':'M7 managed page','blocks':[{'kind':'text','heading':'Published without a deploy','text':'M7 synthetic content','image_id':None,'link_label':'','link_url':''}]}
    revision = admin.call('POST','/v1/admin/content',draft)
    document = revision['document_id']
    assert public('GET','/v1/content/'+unique) is None
    admin.call('POST',f'/v1/admin/content/{document}/releases',{'revision_id':revision['id']})
    assert public('GET','/v1/content/'+unique)['title'] == draft['title']
    admin.call('POST','/v1/admin/content',{**draft,'expected_version':1,'title':'Private second revision'})
    assert public('GET','/v1/content/'+unique)['title'] == draft['title']
    admin.call('POST',f'/v1/admin/content/{document}/releases',{'revision_id':None})
    assert public('GET','/v1/content/'+unique) is None
    credentials = {'identifier':unique+'@example.test','password':uuid.uuid4().hex}
    public('POST','/v1/customer/auth/register',credentials)
    token = public('POST','/v1/customer/auth/login',credentials)['access_token']
    notices = []
    for line in docker('compose','logs','--no-log-prefix','api-gateway').splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get('target')=='local_notifications' and row.get('fields',{}).get('identifier')==credentials['identifier']:
            notices.append(row['fields'])
    assert notices
    public('POST','/v1/customer/auth/verify',{'identifier':credentials['identifier'],'token':notices[-1]['code']})
    review_path = '/v1/customer/products/'+products[0]+'/review'
    review = public('PUT',review_path,{'display_name':'M7 customer','rating':5,'title':'Fresh produce','body':'Synthetic review for moderation testing.'})
    customer = review['customer_id']
    assert public('GET','/v1/products/'+products[0]+'/reviews') == []
    decision = {'status':'approved','reason':'M7 moderation check','expected_version':review['version']}
    admin.call('PUT','/v1/admin/reviews/'+review['id'],decision)
    visible = public('GET','/v1/products/'+products[0]+'/reviews')
    assert len(visible)==1 and 'customer_id' not in visible[0]
    edited = public('PUT',review_path,{'display_name':'M7 customer','rating':4,'title':'Edited review','body':'This edit must return to moderation.'})
    rejected(409,lambda:admin.call('PUT','/v1/admin/reviews/'+review['id'],decision))
    assert public('GET','/v1/products/'+products[0]+'/reviews') == []
    admin.call('PUT','/v1/admin/reviews/'+review['id'],{'status':'rejected','reason':'Synthetic fixture','expected_version':edited['version']})
    public('PUT','/v1/customer/wishlist/'+products[0])
    public('PUT','/v1/customer/wishlist/'+products[0])
    token = public('POST','/v1/customer/auth/login',credentials)['access_token']
    assert public('GET','/v1/customer/wishlist') == [products[0]]
    public('DELETE','/v1/customer/wishlist/'+products[0])
    print('PASS M7: 120-product CSV preview/apply, pagination, exact bulk prices and one searchable audit, CSV roundtrip, inventory, saved filters, draft/public/unpublish, review moderation/edit race, wishlist across login.')
finally:
    if saved:
        admin.call('DELETE','/v1/admin/filters/'+saved['id'])
    if customer:
        pg(f"DELETE FROM reviews.reviews WHERE customer_id='{customer}'")
    if document:
        pg(f"DELETE FROM cms.releases WHERE document_id='{document}'; DELETE FROM cms.revision_media WHERE revision_id IN (SELECT id FROM cms.revisions WHERE document_id='{document}'); DELETE FROM cms.revisions WHERE document_id='{document}'; DELETE FROM cms.documents WHERE id='{document}'")
    # Recover IDs even if an assertion interrupted the batch after commit.
    if category:
        products = admin.call('GET','/v1/admin/operations/product-ids?q='+unique)
    for product in products:
        admin.call('DELETE','/v1/admin/catalog/products/'+product)
    if category:
        admin.call('DELETE','/v1/admin/catalog/categories/'+category['id'])
    admin.call('POST','/v1/admin/auth/logout')
