"""Industry, attribute metadata, schema discovery and enrichment contracts."""
def extend(schemas, endpoint, paths):
    S=lambda:{'type':'string'}
    U=lambda:{'type':'string','format':'uuid'}
    I=lambda:{'type':'integer'}
    B=lambda:{'type':'boolean'}
    N=lambda:{'type':'number'}
    ref=lambda n:{'$ref':'#/components/schemas/'+n}
    arr=lambda v:{'type':'array','items':v}
    null=lambda v:{**v,'nullable':True}
    enum=lambda *v:{'type':'string','enum':list(v)}
    def obj(p,optional=()):return {'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    free={'type':'object','additionalProperties':True}
    meta={'description':S(),'status':enum('active','disabled'),'admin_visible':B(),'facetable':B(),'sortable':B(),'ai_queryable':B(),'ai_enrichable':B(),'source_policy':enum('factual','semantic','trusted_only'),'semantic_role':null(enum('classification','brand','intended_use')),'unit':null(S()),'min':null(N()),'max':null(N()),'max_length':null(I()),'default_value':{},'display_order':I()}
    schemas['AttributeMetadata']=obj(meta,meta.keys())
    definition=schemas['AttributeDefinition']['properties']
    definition['metadata']=ref('AttributeMetadata')
    definition['input_type']['enum']+=['integer','decimal','datetime','measurement','long_text','single_select','multi_select']
    definition['options']['items']['properties']['labels']={'type':'object','additionalProperties':S()}
    schemas['IndustryTemplateAttribute']=obj({'group':S(),'definition':ref('AttributeDefinition')})
    profile={'id':U(),'code':S(),'name':S(),'description':S(),'status':enum('active','disabled'),'version':I(),'metadata':free,'template':arr(ref('IndustryTemplateAttribute'))}
    schemas['IndustryProfile']=obj(profile)
    schemas['CatalogConfiguration']=obj({'industry_profile_id':null(U()),'default_attribute_set_id':null(U()),'version':I()})
    schemas['IndustryApply']=obj({'profile_id':U(),'profile_version':I(),'expected_version':I(),'selected_codes':arr(S()),'confirmed':B()})
    schemas['IndustryPreviewAttribute']=obj({'code':S(),'label':S(),'group':S(),'action':enum('create','reuse','configure_default','conflict'),'reason':null(S())})
    schemas['IndustryPreview']=obj({'configuration':ref('CatalogConfiguration'),'profile':ref('IndustryProfile'),'attributes':arr(ref('IndustryPreviewAttribute'))})
    schemas['CatalogSchema']=schemas['ShopperCatalogSchema']
    schemas['EnrichmentEvidence']=obj({'field':enum('name','description'),'quote':{'type':'string','minLength':1,'maxLength':4000}})
    proposal={'product_id':U(),'definition_id':U(),'value':{},'source':enum('AI_INFERRED','DERIVED'),'confidence':{'type':'number','minimum':0,'maximum':1},'model_version':S(),'evidence':ref('EnrichmentEvidence')}
    schemas['EnrichmentInput']=obj(proposal)
    schemas['EnrichmentSuggestion']=obj({'id':U(),**proposal,'evidence':null(schemas['EnrichmentEvidence']),'status':enum('pending','approved','rejected'),'created_at':S(),'reviewed_at':null(S()),'reviewed_by':null(U())})
    schemas['EnrichmentReview']=obj({'approve':B()})
    schemas['AttributeValueRecord']=obj({'code':S(),'value':{},'source':enum('VERIFIED','MERCHANT','IMPORTED','DERIVED','AI_INFERRED'),'confidence':null(N()),'model_version':null(S())})
    schemas['AttributeRelationship']=obj({'id':U(),'definition_id':U(),'value_code':S(),'target_definition_id':U(),'target_value_code':S(),'relation':enum('synonym','parent','child','related','equivalent','broader_than','narrower_than')})
    endpoint('/v1/catalog/schema','get','CatalogSchema')
    for path,result,many in [('industry-profiles','IndustryProfile',True),('industry','CatalogConfiguration',False),('industry-profiles/{id}/preview','IndustryPreview',False),('enrichment','EnrichmentSuggestion',True),('products/{id}/attribute-values','AttributeValueRecord',True),('attribute-relationships','AttributeRelationship',True)]:
        endpoint('/v1/admin/catalog/'+path,'get',result,auth='adminSession',many=many)
    for path,method,result,body in [('industry-profiles','post','IndustryProfile','IndustryProfile'),('industry','put','CatalogConfiguration','IndustryApply'),('enrichment','post','EnrichmentSuggestion','EnrichmentInput'),('enrichment/{id}','put','EnrichmentSuggestion','EnrichmentReview'),('attribute-relationships','post','AttributeRelationship','AttributeRelationship')]:
        endpoint('/v1/admin/catalog/'+path,method,result,body,auth='adminSession')
    endpoint('/v1/admin/catalog/products/{id}/enrichment','post','EnrichmentSuggestion',auth='adminSession',many=True)
    paths['/v1/admin/catalog/enrichment']['get']['parameters'] = [
        {'in':'query','name':name,'schema':schema} for name,schema in [
            ('status',enum('pending','approved','rejected')),('before',U()),('product_id',U()),
            ('limit',{'type':'integer','minimum':1,'maximum':100,'default':50})]]

    schemas['SearchResults']['properties']['facets']={'type':'object','additionalProperties':{'type':'object','additionalProperties':{'type':'integer'}}}
    paths['/v1/search']['get']['parameters'] += [{'in':'query','name':'sort_by','schema':S()},{'in':'query','name':'sort_order','schema':enum('asc','desc')}]
