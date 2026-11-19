"""Installation-local Meta configuration and consented delivery contracts."""
def extend(schemas, endpoint, paths):
    def obj(p, optional=()):
        return {'type':'object','additionalProperties':False,'required':[k for k in p if k not in optional],'properties':p}
    def ref(n): return {'$ref':'#/components/schemas/'+n}
    text={'type':'string'}
    boolean={'type':'boolean'}
    config={k:{**text,'maxLength':100} for k in ['api_version','waba_id','phone_number_id','confirmation_template','template_language','catalog_id','dataset_id','test_event_code']}
    config.update({k:boolean for k in ['whatsapp_enabled','catalog_enabled','conversions_enabled']})
    schemas['MetaConfig']=obj(config)
    schemas['MetaSettings']=obj({'revision':{'type':'integer'},'config':ref('MetaConfig'),'configured_secrets':{'type':'array','items':text},'editable':boolean,'last_webhook_at':{'type':'string','format':'date-time','nullable':True},'last_feed_at':{'type':'string','format':'date-time','nullable':True}})
    schemas['MetaInput']=obj({'expected_revision':{'type':'integer'},'config':ref('MetaConfig'),'secrets':{'type':'object','additionalProperties':{'type':'string','maxLength':4096,'writeOnly':True},'writeOnly':True},'clear_secrets':{'type':'array','items':text}},['secrets','clear_secrets'])
    schemas['MetaTestResult']=obj({'ok':boolean,'message':text})
    schemas['MetaQueued']=obj({'queued':boolean})
    schemas['MetaTestMessage']=obj({'phone':text,'consent':boolean,'request_id':{'type':'string','format':'uuid'}})
    schemas['MetaPublicStatus']=obj({'whatsapp':boolean,'conversions':boolean})
    schemas['MetaConsent']=obj({
        'whatsapp':{'type':'boolean','description':'Defaults to false when omitted.'},
        'conversions':{'type':'boolean','description':'Defaults to false when omitted.'},
        'phone':{'type':'string','description':'Defaults to an empty string when omitted. For new WhatsApp consent, use + followed by 8 to 15 ASCII digits, with a nonzero first digit. Ignored when whatsapp is false. Replaying an already placed owned order preserves its existing consent receipt.'},
    }, ['whatsapp','conversions','phone'])
    # OpenAPI 3.0 requires a nonempty required array; all consent fields default.
    schemas['MetaConsent'].pop('required')
    schemas['PlaceInput']['properties']['meta_consent']=ref('MetaConsent')
    schemas['MetaJob']=obj({'id':{'type':'string','format':'uuid'},'kind':{'type':'string','enum':['whatsapp','conversions']},'status':{'type':'string','enum':['pending','accepted','failed','unknown','cancelled']},'attempts':{'type':'integer'},'created_at':{'type':'string','format':'date-time'},'delivery_status':{'type':'string','nullable':True},'error_code':{'type':'string','nullable':True}})
    endpoint('/v1/admin/integrations/meta','get','MetaSettings',auth='adminSession')
    endpoint('/v1/admin/integrations/meta','put','MetaSettings','MetaInput',auth='adminSession')
    endpoint('/v1/admin/integrations/meta/test/{kind}','post','MetaTestResult',auth='adminSession')
    paths['/v1/admin/integrations/meta/test/{kind}']['post']['parameters']=[{'name':'kind','in':'path','required':True,'schema':{'type':'string','enum':['whatsapp','catalog','conversions']}}]
    endpoint('/v1/admin/integrations/meta/whatsapp/test','post','MetaQueued','MetaTestMessage',auth='adminSession',status='202')
    endpoint('/v1/admin/integrations/meta/jobs','get','MetaJob',auth='adminSession',many=True)
    endpoint('/v1/integrations/meta/status','get','MetaPublicStatus')
    paths['/v1/integrations/meta/catalog.csv']={'get':{'responses':{'200':{'description':'Complete published simple/variant product feed, capped at 10000 items; requires indexable production installation.','content':{'text/csv':{'schema':text}}},'404':{'description':'Feed or publication disabled'},'429':{'description':'Download limit reached'}}}}
    paths['/v1/integrations/meta/webhook']={
        'get':{'parameters':[{'name':name,'in':'query','required':True,'schema':text} for name in ['hub.mode','hub.verify_token','hub.challenge']], 'responses':{'200':{'description':'Verified challenge','content':{'text/plain':{'schema':text}}},'403':{'description':'Verification failed'}}},
        'post':{'parameters':[{'name':'X-Hub-Signature-256','in':'header','required':True,'schema':text}], 'requestBody':{'required':True,'content':{'application/json':{'schema':{'type':'object'}}}},'responses':{'200':{'description':'Signature verified; matching account delivery statuses acknowledged'},'403':{'description':'Invalid signature'}}}}
