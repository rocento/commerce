def extend(schemas, endpoint, paths):
    def ref(n): return {'$ref': '#/components/schemas/' + n}
    def obj(p): return {'type': 'object', 'properties': p, 'required': list(p), 'additionalProperties': False}
    def enum(*v): return {'type': 'string', 'enum': list(v)}
    def array(t, maximum): return {'type': 'array', 'items': t, 'maxItems': maximum}
    uuid = {'type': 'string', 'format': 'uuid'}
    date = {'type': 'string', 'format': 'date-time', 'nullable': True}
    condition = obj({'field': enum('sku','category','product_type','price','attribute'), 'operator': enum('eq','ne','gte','lte'), 'value': {'type':'string','minLength':1,'maxLength':128}, 'attribute_code': {'type':'string','nullable':True,'maxLength':64}})
    condition['required'].remove('attribute_code')
    schemas['RelationshipCondition'] = condition
    schemas['RelationshipConditions'] = obj({'any': {'type':'boolean'}, 'conditions': array(ref('RelationshipCondition'),20)})
    fields = {'name': {'type':'string','minLength':1,'maxLength':120}, 'kind':enum('related','upsell','cross_sell'), 'active': {'type':'boolean'}, 'priority': {'type':'integer','minimum':1}, 'starts_at':date, 'ends_at':date, 'result_limit': {'type':'integer','minimum':1,'maximum':20}, 'stop_processing': {'type':'boolean'}, 'source':ref('RelationshipConditions'), 'target':ref('RelationshipConditions'), 'manual_ids':array(uuid,20), 'segment_ids':array(uuid,20), 'revision':{'type':'integer','minimum':0}}
    schemas['RelationshipInput'] = obj(fields)
    schemas['RelationshipRule'] = obj({**fields, 'id':uuid, 'updated_at':{'type':'string','format':'date-time'}})
    base='/v1/admin/catalog/relationship-rules'
    schemas['RelationshipAttribute'] = obj({'attribute_code':{'type':'string'},'label':{'type':'string'}})
    endpoint(base+'/attributes','get','RelationshipAttribute',auth='adminSession',many=True)
    endpoint(base,'get','RelationshipRule',auth='adminSession',many=True)
    endpoint(base,'post','RelationshipRule','RelationshipInput',auth='adminSession')
    endpoint(base+'/{id}','put','RelationshipRule','RelationshipInput',auth='adminSession')
    endpoint(base+'/{id}','delete',status=204,auth='adminSession')
    paths[base+'/{id}']['delete']['responses']['204']={'description':'Deleted'}
    paths[base+'/{id}']['delete']['parameters'].append({'in':'query','name':'revision','required':True,'schema':{'type':'integer','minimum':1}})
    for path in [base,base+'/{id}']:
        for method,op in paths[path].items():
            op['description']='Catalog-scoped relationship rules. Requires catalog.read'+(' and catalog.write. Mutations use optimistic revision checks and transactional audit/outbox records.' if method!='get' else '. Maximum 200 rules, ordered by priority then UUID.')
    endpoint('/v1/catalog/relationships','get','Product',many=True)
    op=paths['/v1/catalog/relationships']['get']
    op['security']=[{'customerBearer':[]},{}]
    op['description']='Evaluate published catalog relationships. Returns up to 20 available products with current shopper pricing and localization; Cache-Control: no-store. Source IDs are excluded, manual selections precede automatic matches. Segment membership is derived from authentication. Catalog price predicates use the published base price before customer promotions. End times are exclusive. Deterministic ordering within rules.'
    op['parameters']=[{'in':'query','name':'sources','required':True,'schema':{'type':'string'},'description':'Comma-separated UUIDs, 1–50; pass every cart product for cross-sells.'},{'in':'query','name':'kind','required':True,'schema':enum('related','upsell','cross_sell')},{'in':'header','name':'X-Storefront-Locale','schema':{'type':'string'}}]
