"""Internal renderer snapshot, deliberately excluded from the public API allowlist."""
def extend(schemas, endpoint, paths):
    text={'type':'string'}; uuid={**text,'format':'uuid'}; stamp={**text,'format':'date-time'}
    ref=lambda name:{'$ref':'#/components/schemas/'+name}
    arr=lambda item:{'type':'array','items':item}
    nullable=lambda item:{**item,'nullable':True}
    obj=lambda fields,optional=():{'type':'object','properties':fields,'required':[k for k in fields if k not in optional],'additionalProperties':False}
    mapping=lambda item:{'type':'object','additionalProperties':item}
    free={'type':'object','additionalProperties':True}
    schemas['PublicationCanonicalIdentity']=obj({'installation_id':uuid,**{key:text for key in ['locale','path','url','html','json_ld','sitemap','feed']}})
    schemas['PublicationSnapshotCategory']=obj({'parent_id':nullable(uuid),'id':uuid,'entity_id':{'type':'integer','format':'int64'},'slug':text,'name':text,'description':text,'thumbnail':nullable(uuid)})
    schemas['PublicationSnapshotProduct']=obj({'sku':text,'parent_id':nullable(uuid),'offer_eligible':{'type':'boolean'},'price_diagnostic':text,'id':uuid,'entity_id':{'type':'integer','format':'int64'},**{key:text for key in ['slug','name','description','price','original_price','product_type','currency','unit']},'category_id':uuid,'image_id':nullable(uuid),'image_alt':nullable(text),'attributes':free},['original_price'])
    schemas['PublicationPublicPage']=obj({'document_id':uuid,'revision_id':uuid,'purpose':text,'title':text,'url':text,'updated_at':stamp,'effective_date':nullable({**text,'format':'date'})})
    schemas['PublicationPublicEntity']=obj({**{key:text for key in ['legal_name','description','email','telephone','country','region']},'logo_id':nullable(uuid),**{key:arr(text) for key in ['locations','delivery_areas','social_profiles']},'pages':arr(ref('PublicationPublicPage'))})
    schemas['PublicationSnapshotContent']=obj({'revision_id':uuid,'updated_at':stamp,'id':uuid,'title':text,'blocks':arr(ref('ContentBlock'))})
    product=ref('PublicationSnapshotProduct')
    schemas['PublicationSnapshot']=obj({
        'representation_version':text,'schema_version':{'type':'integer'},'merchant':nullable(ref('PublicationPublicEntity')),
        'comparisons':arr(product),'discovery_attribution_enabled':{'type':'boolean'},'structured_data':nullable(free),
        'related_canonicals':mapping(ref('PublicationCanonicalIdentity')),'family':arr(product),'variant_dimensions':arr(text),'parent_product':nullable(product),
        'metadata':ref('PublicationResolvedMetadata'),'guides':arr(obj({'path':text,'title':text})),'images':mapping(ref('CatalogImage')),
        'installation_id':uuid,**{key:text for key in ['origin','locale','site_name','description','path','kind','robots','availability']},
        'status':{'type':'integer','minimum':100,'maximum':599},'location':nullable(text),'canonical':nullable(ref('PublicationCanonicalIdentity')),
        'theme':ref('ThemeConfiguration'),'categories':arr(ref('PublicationSnapshotCategory')),'category_id':nullable(uuid),
        'products':arr(product),'collections':mapping(arr(product)),'product':nullable(product),'content':nullable(ref('PublicationSnapshotContent')),
        'page':{'type':'integer','minimum':1,'maximum':10000},'has_next':{'type':'boolean'},
    },['representation_version'])
    endpoint('/v1/publication/snapshot','get','PublicationSnapshot')
    operation=paths['/v1/publication/snapshot']['get']
    operation['parameters']=[{'name':'path','in':'query','required':True,'schema':{**text,'pattern':r'^(/|/(products|categories|pages)/[A-Za-z0-9_-]{1,200})$'}},{'name':'page','in':'query','schema':{'type':'integer','minimum':1,'maximum':10000,'default':1}}]
    operation['description']='Anonymous renderer projection assembled from a repeatable-read snapshot. Deployment must accept the HTTP Host; customer cookies and forwarded location are not inputs. The JSON status/location describe the rendered document and may differ from the HTTP success status. Not a stable third-party integration surface.'
    operation['responses']['503']={'description':'Snapshot could not be assembled within its four-second budget.','content':{'text/plain':{'schema':text}}}
    for status,description in [('400','Invalid path or page.'),('421','Host is not approved for this deployment.')]:
        operation['responses'][status]={'description':description,'content':{'application/json':{'schema':ref('Error')}}}
