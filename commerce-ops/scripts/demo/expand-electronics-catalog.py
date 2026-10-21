#!/usr/bin/env python3
"""Add the reviewed 20-product electronics expansion through admin APIs.

Run on the existing EC2 installation. Preview by default; --apply is additive,
checkpointed, and preserves existing catalog products, inventory and themes.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse, copy, fcntl, hashlib, json, os, shlex, socket, sys, uuid, urllib.request
from pathlib import Path
FIELDS=('sku','slug','name','description','price','currency','unit','category_id','media_ids','attributes','attribute_set_id','active','in_stock')

def products(c):
    out=[]
    while True:
        page=c.call('GET','/v1/admin/catalog/products?offset='+str(len(out)))
        out.extend(page)
        if len(page)<50:return out

def validate(m,assets,snapshot):
    assert m['id']=='electronics-expansion-20261005'
    assert len(m['products'])==20
    assert len({p['attributes']['brand'] for p in m['products']})>=5
    for field in ('sku','slug','name'):
        assert len({p[field] for p in m['products']})==20,field
    old={p['sku']:p for p in snapshot['products']}
    assert all(p['sku'].startswith('DEMO-ELE-') for p in old.values()),'Unexpected store catalog'
    defs={d['attribute_code']:d for d in snapshot['definitions']}
    expected={d['attribute_code']:d for d in m['attributes']}
    assert all(code not in defs or defs[code]['input_type']==d['input_type'] for code,d in expected.items()),'Attribute type conflict'
    sources={s['sku']:s for s in m['sources']}
    for p in m['products']:
        assert p['sku'].startswith('DEMO-ELE-BRAND-')
        assert not any(o['sku']!=p['sku'] and (o['slug']==p['slug'] or o['name']==p['name']) for o in old.values()),'Identity collision'
        if p['sku'] in old:
            assert old[p['sku']]['slug']==p['slug'] and old[p['sku']]['name']==p['name'],'Changed seeded identity'
        image=assets/p['images'][0]
        assert image.is_file() and image.stat().st_size<5*1024*1024
        assert hashlib.sha256(image.read_bytes()).hexdigest()==sources[p['sku']]['sha256'],'Image checksum mismatch'
        tr=m['translations']['ar']['products'][p['sku']]
        assert all(tr.get(k) and any('\u0600'<=c<='\u06ff' for c in tr[k]) for k in ('name','description'))
        for code,value in p['attributes'].items():
            assert value in {o['value'] for o in expected[code]['options']}
            assert 'option.'+value in m['translations']['ar']['attributes'][code]
    assert any(s['code']=='demo-global' and s['is_enabled'] for s in snapshot['sources'])
    assert any(s['code']=='demo-global' and s['is_global'] for s in snapshot['stocks'])
    assert any(l['locale']=='ar' for l in snapshot['languages']['languages'])

def translate(c,kind,id,changes,preserve=False):
    path=f'/v1/admin/languages/ar/translations/{kind}/{id}'
    current=c.call('GET',path)
    values={k:v for k,v in current['source'].items() if not k.startswith('__label.')}
    values.update(current.get('fields') or {})
    for k,v in changes.items():
        if k in current['source'] and (not preserve or k not in (current.get('fields') or {})):
            values[k]=v
    if values!=current.get('fields') or current.get('status')!='reviewed':
        c.call('PUT',path,{'expected_revision':current['revision'],'source':current['source'],'fields':values,'reviewed':True})
    return c.call('GET',path)

def apply(c,m,assets,snapshot,statefile):
    digest=hashlib.sha256(json.dumps(m,sort_keys=True).encode()).hexdigest()
    if statefile.exists():state=json.loads(statefile.read_text());assert state['manifest_sha256']==digest
    else:state={'manifest_sha256':digest,'uploads':{},'published':[],'created':[],'before':snapshot}
    def save():
        statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2));statefile.chmod(0o600)
    save()
    defs={d['attribute_code']:d for d in c.call('GET','/v1/admin/attribute-definitions?entity_type=product')}
    for want in m['attributes']:
        code=want['attribute_code'];old=defs.get(code)
        if old:
            values={o['value'] for o in old['options']}
            additions=[o for o in want['options'] if o['value'] not in values]
            if additions:defs[code]=c.call('POST','/v1/admin/attribute-definitions',{**old,'options':old['options']+additions})
        else:defs[code]=c.call('POST','/v1/admin/attribute-definitions',{**want,'id':str(uuid.uuid4()),'metadata':{}})
    for code,fields in m['translations']['ar']['attributes'].items():translate(c,'attribute',defs[code]['id'],fields,preserve=True)
    sets=c.call('GET','/v1/admin/attribute-sets');name='Electronics product specifications'
    attrset=next((s for s in sets if s['name']==name),None)
    if not attrset:
        default=next(s for s in sets if s['name']=='Default')
        members=copy.deepcopy(default['members']);ids={x['definition_id'] for x in members}
        for n,code in enumerate(sorted({k for p in m['products'] for k in p['attributes']})):
            if defs[code]['id'] not in ids:members.append({'definition_id':defs[code]['id'],'group_name':'Technical specifications','position':(n+1)*10})
        attrset=c.call('POST','/v1/admin/attribute-sets',{'id':str(uuid.uuid4()),'entity_id':default['entity_id'],'name':name,'description':'Brand and model specifications for electronics products.','version':0,'members':members})
    cats={x['slug']:x for x in c.call('GET','/v1/catalog/categories')}
    for row in m['categories']:
        if row['slug'] not in cats:cats[row['slug']]=c.call('POST','/v1/admin/catalog/categories',{**row,'parent_id':None})
        translate(c,'category',cats[row['slug']]['id'],m['translations']['ar']['categories'][row['slug']],preserve=True)
    bysku={p['sku']:p for p in products(c)}
    source=next(s for s in snapshot['sources'] if s['code']=='demo-global' and s['is_enabled'])
    for row in m['products']:
        sku=row['sku'];p=bysku.get(sku)
        if not p:
            if sku not in state['uploads']:
                state['uploads'][sku]=c.upload(assets/row['images'][0],row['name']+' — official manufacturer product image')['id'];save()
            media=state['uploads'][sku]
            if media not in state['published']:
                c.call('POST',f'/v1/admin/catalog/media/{media}/publication');state['published'].append(media);save()
            body={k:row[k] for k in ('sku','slug','name','description','price','unit','attributes')}
            body.update(currency='USD',category_id=cats[row['category']]['id'],media_ids=[media],attribute_set_id=attrset['id'],active=False,in_stock=True)
            p=c.call('POST','/v1/admin/catalog/products',body);state['created'].append(sku);save()
        assert p['attributes']==row['attributes'],'Seeded attributes differ; preserve administrator edits'
        translation=translate(c,'product',p['id'],m['translations']['ar']['products'][sku],preserve=True)
        assert all(translation['fields'][k]==v for k,v in m['translations']['ar']['products'][sku].items())
        path='/v1/admin/inventory/'+p['id']+'/sources'
        item=next(i for i in c.call('GET',path) if i['source_id']==source['id'])
        if not item['is_assigned']:
            c.call('PUT',path,{'source_id':source['id'],'quantity':row['stock'],'status':'in_stock','notify_stock_qty':0,'reason':'Initialize new electronics demo product'})
        if not p['active']:
            body={k:p[k] for k in FIELDS if k in p};body['active']=True;p=c.call('PUT','/v1/admin/catalog/products/'+p['id'],body)
        bysku[sku]=p
        print('Ready: '+sku+' '+row['name'],flush=True)
    final={p['sku']:p for p in products(c)}
    initial=state['before']['products']
    for old in initial:
        assert all(final[old['sku']].get(k)==old.get(k) for k in FIELDS),'Existing product changed: '+old['sku']
    assert len(final)==len(initial)+20,'Unexpected catalog count'
    checked=[]
    for row in m['products']:
        p=final[row['sku']];assert p['active'] and p['attributes']==row['attributes'] and p['media_ids']
        request=urllib.request.Request(c.base+'/v1/catalog/products/'+p['id'],headers={'X-Storefront-Locale':'ar','X-Commerce-Request':'1'})
        with c.http.open(request,timeout=60) as response:public=json.load(response)
        assert public['active'] and public['name']==m['translations']['ar']['products'][row['sku']]['name'],'Arabic storefront name mismatch'
        translated=c.call('GET','/v1/admin/languages/ar/translations/product/'+p['id'])
        assert all(translated['fields'].get(k)==v for k,v in m['translations']['ar']['products'][row['sku']].items())
        stock=next(i for i in c.call('GET','/v1/admin/inventory/'+p['id']+'/sources') if i['source_id']==source['id'])
        assert stock['is_assigned'] and stock['quantity']-stock.get('reserved',0)>0
        image=public['images'][p['media_ids'][0]]
        assert image['variants'], 'Missing published image variants'
        for width in sorted({v['width'] for v in image['variants']}):
            with c.http.open(c.base+'/v1/catalog/media/'+p['media_ids'][0]+'/content?width='+str(width),timeout=60) as response:
                content=response.read();assert response.headers['Content-Type'].startswith('image/webp') and content[:4]==b'RIFF','Image derivative failed'
        checked.append({'sku':row['sku'],'id':p['id'],'slug':p['slug'],'media_id':p['media_ids'][0],'arabic_name':translated['fields']['name'],'public_name':public['name'],'stock':stock['quantity']})
    result={'added':20,'total_records':len(final),'active_products':sum(p['active'] for p in final.values()),'existing_products_preserved':len(initial),'verified_products':checked}
    statefile.with_name('electronics-expansion-20261005-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,default=Path('/opt/rocento'));parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--assets',type=Path,required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    m=json.loads(args.manifest.read_text());root=args.root
    lock=(root/'deploy/ec2/setup.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    env={}
    for line in (root/'deploy/ec2/bootstrap.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1);t=shlex.split(v,comments=True);env[k.strip()]=t[0] if t else ''
    host='electronics-admin.'+env['DOMAIN'];resolve=socket.getaddrinfo
    socket.getaddrinfo=lambda h,p,*a,**kw:resolve('127.0.0.1' if h==host else h,p,*a,**kw)
    os.environ['DEMO_SSL_CA_FILE']='/etc/nginx/ssl/rocento-origin.pem';sys.path.insert(0,str(root/'commerce-assets/demo'));from demo_seed import Client
    c=Client('https://'+host+'/api');c.call('POST','/v1/admin/auth/login',{'email':env['ELECTRONICS_ADMIN_EMAIL'],'password':env['ELECTRONICS_ADMIN_PASSWORD']})
    try:
        snapshot={'products':products(c)}
        for key,path in {'definitions':'/v1/admin/attribute-definitions?entity_type=product','categories':'/v1/catalog/categories','sources':'/v1/admin/inventory/sources','stocks':'/v1/admin/inventory/stocks','languages':'/v1/admin/languages'}.items():snapshot[key]=c.call('GET',path)
        validate(m,args.assets,snapshot)
        print(json.dumps({'new_products':sum(p['sku'] not in {o['sku'] for o in snapshot['products']} for p in m['products']),'translations':len(m['translations']['ar']['products']),'images':len(m['sources']),'existing_active':sum(p['active'] for p in snapshot['products'])}),flush=True)
        if args.apply:
            directory=Path('/var/log/rocento/catalog');directory.mkdir(parents=True,exist_ok=True)
            result=apply(c,m,args.assets,snapshot,directory/'electronics-expansion-20261005-checkpoint.json');print(json.dumps({k:v for k,v in result.items() if k!='verified_products'}))
    finally:c.call('POST','/v1/admin/auth/logout');socket.getaddrinfo=resolve;lock.close()
if __name__=='__main__':main()
