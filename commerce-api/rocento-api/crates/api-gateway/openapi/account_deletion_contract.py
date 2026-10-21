"""Merchant-configured account deletion and independently authenticated receipts."""
def extend(schemas, endpoint, paths):
    def obj(p): return {'type':'object','properties':p,'required':list(p),'additionalProperties':False}
    def ref(n): return {'$ref':'#/components/schemas/'+n}
    s={'type':'string'}; u={**s,'format':'uuid'}; b={'type':'boolean'}; t={**s,'format':'date-time'}
    fields={'legal_entity':{**s,'minLength':1,'maxLength':200},'jurisdictions':{'type':'array','items':{**s,'minLength':1,'maxLength':120},'minItems':1,'maxItems':30},'financial_days':{'type':'integer','minimum':0,'maximum':36525},'retain_contact':b,'retain_address':b}
    schemas['RetentionPolicyInput']=obj(fields)
    schemas['RetentionPolicy']=obj({**fields,'id':u,'merchant_id':u,'approved_by':u,'approved_at':t,'active':b})
    receipt={'request_id':u,'receipt_token':{**s,'pattern':'^[A-Fa-f0-9]{64}$'}}
    schemas['DeletionReceipt']=obj(receipt)
    schemas['DeletionRequest']=obj({**receipt,'policy_id':u,'password':s,'confirm':b})
    schemas['DeletionStatus']=obj({'id':u,'state':{**s,'enum':['requested','waiting','processing','failed','complete']},'waiting_reason':{**s,'nullable':True},'requested_at':t,'completed_at':{**t,'nullable':True},'retained_until':{**t,'nullable':True}})
    schemas['DeletionHold']=obj({'until':{**t,'nullable':True},'reason':{**s,'minLength':3,'maxLength':500}})
    schemas['DeletionSaved']=obj({'saved':b})
    schemas['RetainedTransaction']={'type':'object','additionalProperties':True}
    endpoint('/v1/customer/deletion-policy','get','RetentionPolicy',auth='customerBearer')
    endpoint('/v1/customer/account-deletion','post','DeletionStatus','DeletionRequest',auth='customerBearer')
    endpoint('/v1/customer/account-deletion/status','post','DeletionStatus','DeletionReceipt')
    endpoint('/v1/admin/customer-retention','get','RetentionPolicy',auth='adminSession')
    endpoint('/v1/admin/customer-retention','put','RetentionPolicy','RetentionPolicyInput',auth='adminSession')
    endpoint('/v1/admin/account-deletions/{id}/hold','post','DeletionSaved','DeletionHold',auth='adminSession')
    endpoint('/v1/admin/account-deletions/{id}/records','get','RetainedTransaction',auth='adminSession',many=True)
    for path in ['/v1/customer/deletion-policy','/v1/admin/customer-retention']:
        paths[path]['get']['responses']['200']['content']['application/json']['schema']={'allOf':[ref('RetentionPolicy')],'nullable':True}
