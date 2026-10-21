"""M10 decimal settlement, physical selling rules and immutable order facts."""
def extend(schemas, endpoint, paths):
    s={'type':'string'}; b={'type':'boolean'}; u={**s,'format':'uuid'}
    ref=lambda n:{'$ref':'#/components/schemas/'+n}
    obj=lambda p,optional=():{'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    nullable=lambda p:{'allOf':[p],'nullable':True} if '$ref' in p else {**p,'nullable':True}
    enum=lambda *v:{'type':'string','enum':list(v)}
    decimal={'type':'string','pattern':r'^\d+(\.\d{1,6})?$','maxLength':30}
    money={'type':'string','pattern':r'^\d+(\.\d{1,2})?$','maxLength':30}
    count={'type':'integer','minimum':1,'maximum':1000000}
    schemas['CheckoutMarket']=obj({'id':nullable(u),'release_id':nullable(u),'revision':{'type':'integer'},'store_revision':{'type':'integer'},'country':s,'currency':s})
    schemas['Cart']['properties']['market']=ref('CheckoutMarket')
    schemas['CheckoutSnapshot']['properties']['market']=nullable(ref('CheckoutMarket'))
    schemas['Order']['properties']['market_context']=nullable(ref('CheckoutMarket'))
    schemas['MarketConfiguration']=obj({'enabled':b,'currency':enum('USD','EGP'),'version':{'type':'integer','minimum':1},'region':enum('US','EG'),'industry':enum('general','grocery')})
    schemas['MarketConfigurationInput']=obj({'enabled':b,'currency':enum('USD','EGP'),'expected_version':{'type':'integer','minimum':1},'region':enum('US','EG'),'industry':enum('general','grocery'),'delivery_fee':money,'reason':{**s,'minLength':1,'maxLength':300}})
    schemas['SellingRule']=obj({'kind':enum('piece','pack','case','weight','volume','variable_weight'),'measure_unit':enum('piece','kg','litre'),'measure_per_unit':decimal,'minimum':count,'maximum':count,'increment':count,'estimated_weight':nullable(decimal),'final_weight':nullable(decimal),'regulated':b})
    schemas['MarketProduct']=obj({'product_id':u,'rule':nullable(ref('SellingRule')),'price_basis':enum('per_sellable_unit')})
    schemas['MarketMeasure']=obj({'quantity':decimal})
    facts={'market_version':{'type':'integer'},'policy_pack':obj({'region':enum('US','EG'),'industry':enum('general','grocery'),'regulated_goods_enabled':{'type':'boolean','enum':[False]},'legal_compliance_claim':{'type':'boolean','enum':[False]}}),'schema_version':enum('1.0.0'),'sku':s,'title':s,'unit':s,'category_id':u,'parent_id':nullable(u),'selected_options':{'type':'object','additionalProperties':True},'attributes':{'type':'object','additionalProperties':True},'compatibility_digest':s,'currency':enum('USD','EGP'),'selling_rule':nullable(ref('SellingRule')),'price_basis':enum('per_sellable_unit'),'minor_unit_digits':{'type':'integer','enum':[2]}}
    schemas['MarketFacts']=obj(facts)
    schemas['MarketDeliveryCheck']=obj({'available':b,'reason':enum('available','date_required','sign_in_and_address_required','scheduling_disabled','outside_delivery_area','handling_unverified','no_capacity'),'date':s,'reservation_required':b})
    schemas['ShoppingContext']['properties'].update({'market':ref('MarketConfiguration'),'selling_units':{'type':'array','items':ref('MarketProduct'),'maxItems':50},'selling_units_exhaustive':b})
    schemas['OrderItem']['properties']['market_facts']=ref('MarketFacts')
    schemas['BasketProposal']['properties']['market_facts']={'type':'object','additionalProperties':ref('MarketFacts')}
    schemas['BasketProposal']['properties']['delivery_check']=nullable(ref('MarketDeliveryCheck'))
    for name in ['Product','ProductInput']:
        if name in schemas:schemas[name]['properties']['currency']=enum('USD','EGP')
    endpoint('/v1/market','get','MarketConfiguration')
    endpoint('/v1/market/products/{id}','get','MarketProduct')
    endpoint('/v1/cart/items/{id}/measure','put','Cart','MarketMeasure')
    endpoint('/v1/admin/market','put','MarketConfiguration','MarketConfigurationInput',auth='adminSession')
    endpoint('/v1/admin/market/products/{id}','put','MarketProduct','SellingRule',auth='adminSession')
