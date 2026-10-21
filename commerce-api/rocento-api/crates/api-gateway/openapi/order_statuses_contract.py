"""Configurable display statuses, independent from protected order workflow actions."""
def extend(schemas, endpoint, paths):
    def ref(n): return {'$ref': '#/components/schemas/' + n}
    def obj(p): return {'type':'object','properties':p,'required':list(p),'additionalProperties':False}
    s={'type':'string'}; b={'type':'boolean'}; n={'type':'integer','format':'int64','minimum':0}
    state=schemas['Order']['properties']['status']
    tone={'type':'string','enum':['neutral','info','success','warning','danger']}
    translations={'type':'object','additionalProperties':{'type':'string','minLength':1,'maxLength':80},'maxProperties':50}
    label={**s,'minLength':1,'maxLength':80}
    code={**s,'pattern':'^[a-z][a-z0-9_]{1,47}$'}
    reason={**s,'minLength':3,'maxLength':500}
    fields={'code':code,'state':state,'label':label,'translations':translations,'description':{**s,'maxLength':500},'tone':tone,'customer_visible':b,'is_default':b,'active':b}
    schemas['OrderStatusDisplay']=obj({'code':code,'label':label,'translations':translations,'tone':tone})
    schemas['Order']['properties'].update({'status_revision':n,'status_display':ref('OrderStatusDisplay')})
    schemas['OrderStatusDefinition']=obj({**fields,'id':{'type':'string','format':'uuid'},'is_system':b,'revision':n,'updated_at':{'type':'string','format':'date-time'}})
    schemas['OrderStatusInput']=obj({**fields,'expected_revision':n,'reason':reason})
    schemas['OrderStatusAssignment']=obj({'code':code,'expected_revision':n,'reason':reason})
    schemas['OrderStatusLabelHistory']=obj({**{k:{'type':'string','format':'uuid'} for k in ['id','order_id','actor_id']},'state':state,'previous_code':code,'code':code,'previous_label':label,'label':label,'reason':reason,'created_at':{'type':'string','format':'date-time'}})
    endpoint('/v1/admin/order-statuses','get','OrderStatusDefinition',auth='adminSession',many=True)
    endpoint('/v1/admin/order-statuses','post','OrderStatusDefinition','OrderStatusInput',auth='adminSession')
    endpoint('/v1/admin/order-statuses/{code}','put','OrderStatusDefinition','OrderStatusInput',auth='adminSession')
    paths['/v1/admin/order-statuses/{code}']['put']['parameters'].append({'name':'code','in':'path','required':True,'schema':code})
    endpoint('/v1/admin/orders/{id}/status-label','get','OrderStatusLabelHistory',auth='adminSession',many=True)
    endpoint('/v1/admin/orders/{id}/status-label','post',body='OrderStatusAssignment',auth='adminSession')
