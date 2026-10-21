"""M7 domain contracts, shared by generated clients and response validation."""
def extend(schemas, endpoint, paths):
    S=lambda:{'type':'string'}
    U=lambda:{'type':'string','format':'uuid'}
    T=lambda:{'type':'string','format':'date-time'}
    I=lambda:{'type':'integer'}
    B=lambda:{'type':'boolean'}
    ref=lambda n:{'$ref':'#/components/schemas/'+n}
    arr=lambda v:{'type':'array','items':v}
    null=lambda v:{**v,'nullable':True}
    def obj(p,optional=()):return {'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    def enum(*values):return {'type':'string','enum':list(values)}
    block={'kind':enum('hero','text','link'),'heading':S(),'text':S(),'image_id':null(U()),'link_label':S(),'link_url':S()}
    schemas['NavigationLink']=obj({'label':S(),'url':S(),'group':S(),'icon':S(),'description':S(),'new_tab':{'type':'boolean'}})
    schemas['Navigation']=obj({'icon':S(),'badge':S(),'enabled':{'type':'boolean'},'new_tab':{'type':'boolean'},'columns':{'type':'integer','minimum':1,'maximum':4},'links':arr(ref('NavigationLink'))})
    schemas['ContentBlock']=obj(block)
    schemas['ContentBlock']['properties']['navigation']=null(ref('Navigation'))
    document={'id':U(),'key':S(),'kind':enum('home','page','footer','navigation'),'version':I(),'updated_at':T()}
    revision={'id':U(),'document_id':U(),'version':I(),'title':S(),'blocks':arr(ref('ContentBlock')),'created_by':U(),'created_at':T()}
    release={'id':U(),'document_id':U(),'revision_id':null(U()),'starts_at':T(),'ends_at':null(T()),'cancelled':B(),'created_at':T()}
    schemas.update({'ContentDocument':obj(document),'ContentRevision':obj(revision),'ContentRelease':obj(release),'ContentDetail':obj({'document':ref('ContentDocument'),'revisions':arr(ref('ContentRevision')),'releases':arr(ref('ContentRelease'))}),'ContentInput':obj({'key':S(),'kind':enum('home','page','footer','navigation'),'expected_version':I(),'title':S(),'blocks':arr(ref('ContentBlock'))}),'ContentPublish':obj({'revision_id':null(U()),'starts_at':null(T()),'ends_at':null(T())}),'PublishedContent':null(obj({'key':S(),'title':S(),'blocks':arr(ref('ContentBlock')),'version':I()}))})
    endpoint('/v1/content/{key}','get','PublishedContent')
    paths['/v1/content/{key}']['get'].setdefault('parameters', []).append({'in':'query','name':'locale','required':False,'schema':S(),'description':'Language for published navigation translations; unavailable translations fall back to the source.'})
    endpoint('/v1/admin/content/media','get','Media',auth='adminSession',many=True)
    endpoint('/v1/admin/content','get','ContentDocument',auth='adminSession',many=True)
    endpoint('/v1/admin/content','post','ContentRevision','ContentInput',auth='adminSession')
    endpoint('/v1/admin/content/{id}','get','ContentDetail',auth='adminSession')
    endpoint('/v1/admin/content/{id}/releases','post','ContentRelease','ContentPublish',auth='adminSession')
    review={'id':U(),'product_id':U(),'customer_id':U(),'display_name':S(),'rating':I(),'title':S(),'body':S(),'status':enum('pending','approved','rejected'),'version':I(),'moderation_reason':null(S()),'created_at':T(),'updated_at':T()}
    schemas['Review']=obj(review);schemas['OwnReview']=null(obj(review))
    schemas['PublicReview']=obj({k:review[k] for k in ['id','display_name','rating','title','body','created_at']})
    schemas['ReviewInput']=obj({k:review[k] for k in ['display_name','rating','title','body']})
    schemas['ReviewInput']['properties']['rating']={'type':'integer','minimum':1,'maximum':5}
    for key, limit in [('display_name',80),('title',200),('body',4000)]:
        schemas['ReviewInput']['properties'][key]={'type':'string','minLength':1,'maxLength':limit,'pattern':r'\S','description':f'Must contain non-whitespace text. At most {limit} UTF-8 bytes before trimming; maxLength is only the corresponding character upper bound. Multibyte text may reach the byte limit sooner.'}
    schemas['ReviewModeration']=obj({'status':enum('approved','rejected'),'reason':S(),'expected_version':I()})
    endpoint('/v1/products/{id}/reviews','get','PublicReview',many=True)
    endpoint('/v1/customer/products/{id}/review','get','OwnReview',auth='customerBearer')
    endpoint('/v1/customer/products/{id}/review','put','Review','ReviewInput',auth='customerBearer')
    paths['/v1/customer/products/{id}/review']['put']['responses']['400']={'description':'Rating must be 1–5; name/title/body must contain non-whitespace text and fit their UTF-8 byte limits. The product must remain available.','content':{'application/json':{'schema':ref('Error'),'example':{'error':'Enter a display name, 1–5 rating, title and review (up to 4000 characters)'}}}}
    endpoint('/v1/admin/reviews','get','Review',auth='adminSession',many=True)
    endpoint('/v1/admin/reviews/{id}','put','Review','ReviewModeration',auth='adminSession')
    schemas['IdList']=arr(U())
    endpoint('/v1/customer/wishlist','get','IdList',auth='customerBearer')
    endpoint('/v1/customer/wishlist/{id}','put',auth='customerBearer')
    endpoint('/v1/customer/wishlist/{id}','delete',auth='customerBearer')
    filters={'q':S(),'category_id':null(U()),'active':null(B()),'offset':I()}
    schemas['CatalogFilter']=obj(filters)
    schemas['CatalogPage']=obj({'items':arr(ref('Product')),'total':I()})
    schemas['BulkInput']=obj({'ids':arr(U()),'category_id':null(U()),'active':null(B()),'price_adjustment_pct':null(S()),'reason':S()})
    schemas['BatchResult']=obj({'count':I(),'operation_id':U(),'preview':B(),'skus':arr(S())})
    schemas['CsvInput']=obj({'csv':S(),'preview':B(),'reason':S()});schemas['CsvExport']=obj({'csv':S()})
    schemas['SavedFilter']=obj({'id':U(),'admin_id':U(),'name':S(),'filters':ref('CatalogFilter')})
    schemas['SavedFilterInput']=obj({'name':S(),'filters':ref('CatalogFilter')})
    endpoint('/v1/admin/operations/products','get','CatalogPage',auth='adminSession')
    endpoint('/v1/admin/operations/product-ids','get','IdList',auth='adminSession')
    endpoint('/v1/admin/operations/bulk','post','BatchResult','BulkInput',auth='adminSession')
    endpoint('/v1/admin/operations/{kind}/export','get','CsvExport',auth='adminSession')
    endpoint('/v1/admin/operations/{kind}/import','post','BatchResult','CsvInput',auth='adminSession')
    endpoint('/v1/admin/filters','get','SavedFilter',auth='adminSession',many=True)
    endpoint('/v1/admin/filters','post','SavedFilter','SavedFilterInput',auth='adminSession')
    endpoint('/v1/admin/filters/{id}','delete',auth='adminSession')
    for path,method,param in [('/v1/content/{key}','get','key'),('/v1/admin/operations/{kind}/export','get','kind'),('/v1/admin/operations/{kind}/import','post','kind')]:
        paths[path][method].setdefault('parameters',[]).append({'in':'path','name':param,'required':True,'schema':S()})
    for path in ['/v1/admin/operations/products','/v1/admin/operations/product-ids','/v1/admin/operations/{kind}/export']:
        paths[path]['get'].setdefault('parameters',[]).extend({'in':'query','name':k,'schema':v} for k,v in filters.items())
    for path in ['/v1/products/{id}/reviews','/v1/admin/reviews','/v1/admin/audit']:
        params=paths[path]['get'].setdefault('parameters',[]);params.append({'in':'query','name':'offset','schema':I()})
        if path.endswith('audit'):params.append({'in':'query','name':'q','schema':S()})
        if path=='/v1/admin/reviews':params.append({'in':'query','name':'status','schema':S()})
