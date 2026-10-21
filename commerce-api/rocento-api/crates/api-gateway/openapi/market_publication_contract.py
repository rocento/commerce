"""Market draft preparation and single-storefront publication contracts."""
def extend(schemas, endpoint, paths):
    s={'type':'string'}; b={'type':'boolean'}; n={'type':'integer'}; u={**s,'format':'uuid'}
    ref=lambda key:{'$ref':'#/components/schemas/'+key}
    arr=lambda item:{'type':'array','items':item}
    nullable=lambda item:{'allOf':[item],'nullable':True} if '$ref' in item else {**item,'nullable':True}
    obj=lambda fields,optional=():{'type':'object','properties':fields,'required':[key for key in fields if key not in optional],'additionalProperties':False}
    draft={'id':u,'name':s,'country':s,'currency':s,'locales':arr(s),'default_locale':s}
    schemas['MarketDraft']=obj({**draft,'revision':n})
    schemas['MarketDraftInput']=obj({**draft,'expected_revision':n})
    schemas['ActiveMarket']=obj({'revision':n,'release_id':nullable(u),'market_id':nullable(u),'name':nullable(s),'created_at':nullable({**s,'format':'date-time'})})
    schemas['MarketList']=obj({'items':arr(ref('MarketDraft')),'live':ref('MarketConfiguration'),'locales':arr(s),'source_locale':s,'activation_available':b,'active':ref('ActiveMarket')})
    schemas['MarketOverrideInput']=obj({'available':nullable(b),'price':nullable(s),'currency':s,'expected_revision':n})
    schemas['MarketOverride']=obj({'source':obj({'name':s,'available':b,'price':s,'currency':s},('price','currency')),'currency':s,'override':obj({'available':nullable(b),'price':nullable(s),'revision':n})})
    schemas['MarketRevision']=obj({'revision':n})
    schemas['MarketReadiness']=obj({'token':s,'ready':b,'active_revision':n,'available_products':n,'missing_prices':n,'overridden_products':n,'source_locale':s,'checks':arr(obj({'code':s,'ready':b,'message':s})),'delivery':obj({'amount':s,'currency':s}),'tax':arr(obj({'id':u,'name':s,'rate_bps':n,'tax_delivery':b,'min_lat':{'type':'number'},'max_lat':{'type':'number'},'min_lon':{'type':'number'},'max_lon':{'type':'number'},'priority':n,'updated_at':{**s,'format':'date-time'}}))})
    schemas['MarketPreview']=obj({'items':arr(obj({'id':u,'sku':s,'name':s,'available':b,'source_price':s,'source_currency':s,'price':nullable(s),'currency':s,'inherited':b})),'total':n,'offset':n,'limit':n})
    schemas['MarketPublishInput']=obj({'token':s,'reason':{**s,'minLength':1,'maxLength':300}})
    schemas['MarketRelease']=obj({'release_id':u,'revision':n})
    schemas['MarketRestoreInput']=obj({'expected_revision':n,'reason':{**s,'minLength':1,'maxLength':300}})
    schemas['CurrentMarket']=obj({'revision':n,'release_id':nullable(u),'id':nullable(u),'name':s,'country':s,'currency':s})
    endpoint('/v1/admin/markets','get','MarketList',auth='adminSession')
    endpoint('/v1/admin/markets','post','MarketDraft','MarketDraftInput',auth='adminSession')
    for method,response,body in [('get','MarketOverride',None),('put','MarketRevision','MarketOverrideInput')]:
        endpoint('/v1/admin/markets/{market}/{kind}/{id}',method,response,body,auth='adminSession')
        paths['/v1/admin/markets/{market}/{kind}/{id}'][method].setdefault('parameters', []).extend([
            {'in':'path','name':'market','required':True,'schema':u},
            {'in':'path','name':'kind','required':True,'schema':{'type':'string','enum':['product','category','navigation']}},
        ])
    endpoint('/v1/admin/markets/{id}/readiness','get','MarketReadiness',auth='adminSession')
    endpoint('/v1/admin/markets/{id}/preview','get','MarketPreview',auth='adminSession')
    paths['/v1/admin/markets/{id}/preview']['get'].setdefault('parameters',[]).extend([{'name':'q','in':'query','schema':{**s,'maxLength':200}},{'name':'offset','in':'query','schema':{**n,'minimum':0,'maximum':1000000}}])
    endpoint('/v1/admin/markets/{id}/publish','post','MarketRelease','MarketPublishInput',auth='adminSession')
    endpoint('/v1/admin/markets/restore-defaults','post','MarketRevision','MarketRestoreInput',auth='adminSession')
    endpoint('/v1/markets/current','get','CurrentMarket')
