"""Per-installation public discovery and admin configuration."""
def extend(schemas, endpoint, paths):
    nullable_string={'type':'string','nullable':True,'maxLength':2048}
    fields={
      'revision':{'type':'integer','minimum':1}, 'enabled':{'type':'boolean'},
      'indexing_enabled':{'type':'boolean'}, 'llms_txt_enabled':{'type':'boolean'},
      'site_name':{'type':'string','minLength':1,'maxLength':120},
      'organization_name':{'type':'string','minLength':1,'maxLength':120},
      'canonical_url':nullable_string, 'description':{'type':'string','maxLength':500},
      'default_locale':{'type':'string','pattern':'^[a-z]{2}(-[A-Z]{2})?$'},
      **{name:{'type':'boolean'} for name in ['feature_pages_enabled','industry_pages_enabled','docs_enabled','pricing_page_enabled','security_page_enabled','integrations_page_enabled','changelog_enabled']},
      'grocery_demo_url':nullable_string, 'jewelry_demo_url':nullable_string,
    }
    schemas['DiscoverySettings']={'type':'object','additionalProperties':False,'required':[*fields,'updated_at'],'properties':{**fields,'updated_at':{'type':'string','format':'date-time'}}}
    input_fields={('expected_revision' if key=='revision' else key):value for key,value in fields.items()}
    schemas['DiscoverySettingsInput']={'type':'object','additionalProperties':False,'required':list(input_fields),'properties':input_fields}
    endpoint('/v1/discovery/config','get','DiscoverySettings')
    endpoint('/v1/admin/discovery/config','get','DiscoverySettings',auth='adminSession')
    endpoint('/v1/admin/discovery/config','put','DiscoverySettings','DiscoverySettingsInput',auth='adminSession')

    policy_fields = {
        'installation_id': {'type':'string','format':'uuid','nullable':True},
        'settings_revision': {'type':'integer'},
        'merchant_preference': {'type':'boolean'},
        'state': {'type':'string','enum':['INDEXABLE','MERCHANT_DISABLED','BLOCKED_BY_ENVIRONMENT','BLOCKED_BY_HEADER','DOMAIN_UNVERIFIED','CONFIGURATION_ERROR']},
        'environment': {'type':'string'},
        'canonical_origin': {'type':'string','nullable':True},
        'response_header': {'type':'string'}, 'robots_meta': {'type':'string'}, 'robots_txt': {'type':'string'},
        'deployment_override': {'type':'boolean'},
        'external_headers': {'type':'string','enum':['NOT_OBSERVED']},
        'warnings': {'type':'array','items':{'type':'string'}},
    }
    schemas['EffectiveIndexingPolicy'] = {'type':'object','additionalProperties':False,'required':list(policy_fields),'properties':policy_fields}
    endpoint('/v1/admin/discovery/effective','get','EffectiveIndexingPolicy',auth='adminSession')

    ref=lambda name: {'$ref': '#/components/schemas/'+name}
    def obj(fields): return {'type':'object','additionalProperties':False,'required':list(fields),'properties':fields}
    text={'type':'string','maxLength':2000}
    schemas['PublicationMetadataText']=obj({'title':text,'description':text})
    schemas['PublicationMetadataConfiguration']=obj({
        'templates':{'type':'object','additionalProperties':ref('PublicationMetadataText')},
        'overrides':{'type':'object','maxProperties':500,'additionalProperties':ref('PublicationMetadataText')},
        'social_image':{'type':'string','format':'uuid','nullable':True},
    })
    schemas['PublicationMetadataSettings']=obj({'revision':{'type':'integer'},'configuration':ref('PublicationMetadataConfiguration')})
    schemas['PublicationMetadataInput']=obj({'expected_revision':{'type':'integer','minimum':1},'configuration':ref('PublicationMetadataConfiguration')})
    schemas['PublicationMetadataPreviewInput']=obj({'path':{'type':'string'},'page':{'type':'integer','minimum':1,'maximum':10000,'default':1},'configuration':ref('PublicationMetadataConfiguration')})
    schemas['PublicationMetadataPreviewInput']['required'].remove('page')
    schemas['PublicationResolvedMetadata']=obj({'title':{'type':'string'},'description':{'type':'string'},'image':{'type':'string','format':'uuid','nullable':True},'warnings':{'type':'array','items':{'type':'string'}}})
    schemas['PublicationMetadataPreview']={'type':'object','additionalProperties':True,'required':['metadata','status','robots','canonical','images'],'properties':{'metadata':ref('PublicationResolvedMetadata'),'status':{'type':'integer'},'robots':{'type':'string'},'canonical':{'type':'object','nullable':True,'additionalProperties':True},'images':{'type':'object','additionalProperties':True}}}
    endpoint('/v1/admin/discovery/metadata','get','PublicationMetadataSettings',auth='adminSession')
    endpoint('/v1/admin/discovery/metadata','put','PublicationMetadataSettings','PublicationMetadataInput',auth='adminSession')
    endpoint('/v1/admin/discovery/metadata/preview','post','PublicationMetadataPreview','PublicationMetadataPreviewInput',auth='adminSession')
    schemas['PublicationImageProcessed']=obj({'status':{'type':'string','enum':['processed']}})
    endpoint('/v1/admin/catalog/media/{id}/publication','post','PublicationImageProcessed',auth='adminSession')
    paths['/v1/catalog/media/{id}/content']['get'].setdefault('parameters',[]).append({'in':'query','name':'width','schema':{'type':'integer','minimum':1,'maximum':12000},'description':'An advertised, existing WebP rendition width, including compressed original resolution. Unprepared widths return 404; omitted returns the original. Private files require catalog.read.'})

    crawler_fields={'revision':{'type':'integer','minimum':1},'openai_search':{'type':'boolean'},'openai_training':{'type':'boolean'}}
    schemas['PublicationCrawlerPreferences']=obj(crawler_fields)
    schemas['PublicationCrawlerInput']=obj({('expected_revision' if k=='revision' else k):v for k,v in crawler_fields.items()})
    endpoint('/v1/admin/discovery/crawlers','get','PublicationCrawlerPreferences',auth='adminSession')
    endpoint('/v1/admin/discovery/crawlers','put','PublicationCrawlerPreferences','PublicationCrawlerInput',auth='adminSession')

    entity_page=obj({'document_id':{'type':'string','format':'uuid'},'revision_id':{'type':'string','format':'uuid'},'purpose':{'type':'string','enum':['shipping','returns','warranty','payment','buying-guide','category-guide','sizing-guide','materials-guide','ingredients-guide','comparison','faq','care']},'locale':{'type':'string'},'effective_date':{'type':'string','format':'date','nullable':True},'comparison_products':{'type':'array','maxItems':6,'items':{'type':'string','format':'uuid'}}})
    schemas['PublicationEntityPage']=entity_page
    entity_config=obj({**{k:{'type':'boolean'} for k in ['published','contact_published','locations_published']},**{k:{'type':'string','maxLength':1000} for k in ['legal_name','description','email','telephone','country','region']},'logo_id':{'type':'string','format':'uuid','nullable':True},**{k:{'type':'array','items':{'type':'string'}} for k in ['locations','delivery_areas','social_profiles']},'pages':{'type':'array','maxItems':100,'items':ref('PublicationEntityPage')}})
    entity_config['required']=[]
    schemas['PublicationEntityConfiguration']=entity_config
    schemas['PublicationEntityInput']=obj({'expected_revision':{'type':'integer','minimum':1},'configuration':ref('PublicationEntityConfiguration')})
    schemas['PublicationEntitySaved']=obj({'revision':{'type':'integer'}})
    schemas['PublicationEntityStatus']={'type':'object','required':['revision','locale','configuration','warnings','pages','documents','industry','coverage'],'properties':{'revision':{'type':'integer'},'locale':{'type':'string'},'configuration':ref('PublicationEntityConfiguration'),'warnings':{'type':'array','items':{'type':'string'}},'pages':{'type':'array','items':{'type':'object','additionalProperties':True}},'documents':{'type':'array','items':{'type':'object','additionalProperties':True}},'industry':{'type':'string','nullable':True},'coverage':{'type':'array','items':{'type':'object','additionalProperties':True}}},'additionalProperties':False}
    endpoint('/v1/admin/discovery/entity','get','PublicationEntityStatus',auth='adminSession')
    endpoint('/v1/admin/discovery/entity','put','PublicationEntitySaved','PublicationEntityInput',auth='adminSession')

    schemas['PublicationFeedEvent']=obj({'version':{'type':'integer','format':'int64'},'installation_id':{'type':'string','format':'uuid'},'item_key':{'type':'string'},'product_id':{'type':'string','format':'uuid'},'operation':{'type':'string','enum':['upsert','delete']},'payload':{'type':'object','additionalProperties':True}})
    schemas['PublicationFeedExport']=obj({'schema_version':{'type':'integer'},'until':{'type':'integer','format':'int64'},'next':{'type':'integer','format':'int64'},'next_key':{'type':'string'},'has_more':{'type':'boolean'},'items':{'type':'array','maxItems':100,'items':ref('PublicationFeedEvent')}})
    schemas['PublicationFeedStatus']=obj({'adapter':{'type':'string'},'freshness':{'type':'object','additionalProperties':True},'jobs':{'type':'array','items':{'type':'array','items':{}}},'errors':{'type':'array','items':{'type':'array','items':{}}},'batch_size':{'type':'integer'},'market':{'type':'string'},'external_submission':{'type':'string'}})
    schemas['PublicationFeedQueued']=obj({'queued':{'type':'boolean'}})
    endpoint('/v1/admin/discovery/feeds','get','PublicationFeedStatus',auth='adminSession')
    endpoint('/v1/admin/discovery/feeds/export','get','PublicationFeedExport',auth='adminSession')
    endpoint('/v1/admin/discovery/feeds/reconcile','post','PublicationFeedQueued',auth='adminSession')
    paths['/v1/admin/discovery/feeds/export']['get']['parameters']=[{'in':'query','name':name,'required':False,'schema':spec} for name,spec in {'after':{'type':'integer','format':'int64','minimum':0,'default':0},'until':{'type':'integer','format':'int64','minimum':0},'full':{'type':'boolean','default':False},'key':{'type':'string','maxLength':200}}.items()]

    schemas['DiscoveryAttributionEvidence']=obj({k:{'type':'string','maxLength':2048 if k=='referrer' else 80} for k in ['referrer','source','medium','campaign']})
    schemas['DiscoveryAttributionEvidence']['required']=[]
    schemas['DiscoveryAttributionInput']=obj({'id':{'type':'string','format':'uuid'},'session_id':{'type':'string','format':'uuid'},'path':{'type':'string','maxLength':250},'evidence':ref('DiscoveryAttributionEvidence'),'order_id':{'type':'string','format':'uuid','nullable':True}})
    schemas['DiscoveryAttributionInput']['required']=['id','session_id','path']
    schemas['DiscoveryAttributionAccepted']=obj({'accepted':{'type':'boolean'}})
    schemas['DiscoveryAnalytics']={'type':'object','additionalProperties':True,'required':['timezone','from','days','sampling','session_model','channels','top_landings','top_products','trend','conversions','revenue_authorized'],'properties':{'timezone':{'type':'string','enum':['UTC']},'from':{'type':'string','format':'date-time'},'days':{'type':'integer','minimum':1,'maximum':90},'sampling':{'type':'string'},'session_model':{'type':'string'},'revenue_authorized':{'type':'boolean'},**{k:{'type':'array','items':{'type':'object','additionalProperties':True}} for k in ['channels','top_landings','top_products','trend']},'conversions':{'type':'array','nullable':True,'items':{'type':'object','additionalProperties':True}}}}
    schemas['DiscoveryHealthFinding']=obj({'code':{'type':'string'},'severity':{'type':'string','enum':['Healthy','Warning','Error']},'resource':{'type':'string'},'evidence':{},'remediation':{'type':'string'},'observed_at':{'type':'string','format':'date-time'}})
    schemas['DiscoveryHealth']=obj({'installation_id':{'type':'string','format':'uuid'},'observed_at':{'type':'string','format':'date-time'},'scope':{'type':'string'},'findings':{'type':'array','items':ref('DiscoveryHealthFinding')},'observations':{'type':'object','nullable':True,'additionalProperties':True}})
    endpoint('/v1/discovery/attribution','post','DiscoveryAttributionAccepted','DiscoveryAttributionInput')
    endpoint('/v1/admin/discovery/analytics','get','DiscoveryAnalytics',auth='adminSession')
    endpoint('/v1/admin/discovery/health','get','DiscoveryHealth',auth='adminSession')
    paths['/v1/admin/discovery/analytics']['get']['parameters']=[{'in':'query','name':'days','required':False,'schema':{'type':'integer','minimum':1,'maximum':90,'default':30}}]
