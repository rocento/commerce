"""Permission-gated operator tracking; report stage data is JSON, never executable HTML."""
def extend(schemas, endpoint, paths):
    def obj(properties):
        return {'type':'object','additionalProperties':False,'required':list(properties),'properties':properties}
    def ref(name):
        return {'$ref':'#/components/schemas/'+name}
    uid={'type':'string','format':'uuid'}
    text={'type':'string'}
    integer={'type':'integer'}
    schemas['AssistantTrackingRow']=obj({
        'request_id':uid,'created_at':{'type':'string','format':'date-time'},
        'outcome':text,'latency_ms':integer,'conversation_id':{**uid,'nullable':True},
        'route':text,'intent':{**text,'nullable':True},'model':{**text,'nullable':True},
        'model_calls':integer,'input_tokens':integer,'output_tokens':integer,
        'question_preview':{**text,'nullable':True},'report_available':{'type':'boolean'},
    })
    schemas['AssistantTrackingList']=obj({
        'capture_enabled':{'type':'boolean'},'retention_days':integer,
        'items':{'type':'array','items':ref('AssistantTrackingRow'),'maxItems':50},
        'next_cursor':{**text,'nullable':True},
    })
    schemas['AssistantTrackingStage']=obj({'stage':text,'data':{}})
    schemas['AssistantTrackingReport']=obj({'version':integer,'request_id':uid,
        'truncated':{'type':'boolean'},'redacted':{'type':'boolean'},
        'events':{'type':'array','items':ref('AssistantTrackingStage'),'maxItems':96}})
    base='/v1/admin/assistant/tracking'
    endpoint(base,'get','AssistantTrackingList',auth='adminSession')
    paths[base]['get']['parameters']=[{'name':name,'in':'query','required':False,'schema':schema} for name,schema in [
        ('limit',{'type':'integer','minimum':1,'maximum':50}),
        ('hours',{'type':'integer','minimum':1,'maximum':168}),
        ('outcome',{'type':'string','enum':['completed','unavailable','disconnected','denied']}),
        ('request_id',uid),('cursor',{'type':'string','maxLength':100})]]
    for suffix in ['/{id}','/{id}/export']:
        endpoint(base+suffix,'get','AssistantTrackingReport',auth='adminSession')
        paths[base+suffix]['get']['parameters']=[{'name':'id','in':'path','required':True,'schema':uid}]

    schemas['AssistantCaptureInput']=obj({'enabled':{'type':'boolean'}})
    schemas['AssistantCaptureStatus']=obj({'enabled':{'type':'boolean'},'editable':{'type':'boolean'},'source':text})
    endpoint(base+'/settings','get','AssistantCaptureStatus',auth='adminSession')
    endpoint(base+'/settings','put','AssistantCaptureStatus','AssistantCaptureInput',auth='adminSession')

    schemas['AssistantLiveEvent']=obj({'sequence':{'type':'integer','minimum':0},'request_id':uid,'kind':{'type':'string','enum':['stage','finished']},'data':{}})
    schemas['AssistantLiveBatch']=obj({'cursor':text,'reset':{'type':'boolean'},'capture_enabled':{'type':'boolean'},'events':{'type':'array','maxItems':128,'items':ref('AssistantLiveEvent')}})
    endpoint(base+'/live','get','AssistantLiveBatch',auth='adminSession')
    paths[base+'/live']['get']['parameters']=[{'name':'cursor','in':'query','required':False,'schema':{'type':'string','maxLength':100}}]
