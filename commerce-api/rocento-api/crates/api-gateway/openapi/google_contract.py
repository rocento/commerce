"""Installation-scoped Google integrations; only Maps browser keys are public."""
def extend(schemas, endpoint, paths):
    def obj(p,required=None): return {'type':'object','additionalProperties':False,'properties':p,'required':list(p) if required is None else required}
    text={'type':'string'}
    integer={'type':'integer','format':'int64'}
    boolean={'type':'boolean'}
    ref=lambda n:{'$ref':'#/components/schemas/'+n}
    config=obj({k:text for k in ['account_id','data_source_id','language','feed_label','measurement_id']})
    schemas['GoogleConfig']=config
    schemas['GoogleConnection']=obj({'service':{'type':'string','enum':['merchant','ga4','maps']},'revision':integer,'enabled':boolean,'config':ref('GoogleConfig'),'credential_configured':boolean,'editable':boolean,**{k:{'type':'string','nullable':True} for k in ['checked_at','check_code','last_sync_at','sync_code']},**{k:integer for k in ['sync_scanned','sync_submitted','sync_excluded','sync_rejected']}})
    schemas['GoogleConnections']={'type':'array','items':ref('GoogleConnection')}
    schemas['GoogleInput']=obj({'expected_revision':integer,'enabled':boolean,'config':ref('GoogleConfig'),'credential':{'type':'string','maxLength':16384,'writeOnly':True,'nullable':True},'clear_credential':boolean},['expected_revision','enabled','config'])
    schemas['GoogleRevision']=obj({'expected_revision':integer})
    schemas['GoogleResult']=obj({'ok':boolean,'code':text,'message':text})
    schemas['GooglePublic']=obj({'measurement_id':{'type':'string','nullable':True},'maps_browser_key':{'type':'string','nullable':True}})
    endpoint('/v1/admin/integrations/google','get','GoogleConnections',auth='adminSession')
    endpoint('/v1/admin/integrations/google/{service}','put','GoogleConnections','GoogleInput',auth='adminSession')
    for action,result in [('disconnect','GoogleConnections'),('test','GoogleResult')]:
        endpoint('/v1/admin/integrations/google/{service}/'+action,'post',result,'GoogleRevision',auth='adminSession')
    for p,operations in paths.items():
        if p.startswith('/v1/admin/integrations/google/{service}'):
            for op in operations.values():
                op.setdefault('parameters',[]).append({'name':'service','in':'path','required':True,'schema':{'type':'string','enum':['merchant','ga4','maps']}})
    endpoint('/v1/admin/integrations/google/merchant/sync','post','GoogleResult','GoogleRevision',auth='adminSession')
    endpoint('/v1/integrations/google/public','get','GooglePublic')
