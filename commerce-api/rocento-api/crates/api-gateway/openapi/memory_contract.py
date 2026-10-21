"""M08 independent memory contracts. Customer preferences never grant commerce authority."""
def extend(schemas,endpoint,paths):
    S=lambda maximum=200:{'type':'string','maxLength':maximum}
    U=lambda:{'type':'string','format':'uuid'}
    T=lambda:{'type':'string','format':'date-time'}
    B=lambda:{'type':'boolean'}
    I=lambda maximum=100000:{'type':'integer','minimum':0,'maximum':maximum}
    enum=lambda *v:{'type':'string','enum':list(v)}
    ref=lambda n:{'$ref':'#/components/schemas/'+n}
    null=lambda v:{**v,'nullable':True}
    arr=lambda v,n:{'type':'array','items':v,'maxItems':n}
    obj=lambda p,optional=():{'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    attributes=enum('product','brand','color','style','metal','material')
    context={'category_id':U(),'occasion':enum('any','everyday','gift','work','travel'),'recipient':enum('self','other'),'goal_id':null(U())}
    schemas['MemorySnapshot']=obj({'query':S(200),'attributes':{'type':'object','additionalProperties':S(100),'maxProperties':10},'min_price':null(S(20)),'max_price':null(S(20)),'currency':null(S(3)),'brand':null(S(100)),'category':null(S(100)),'exclusive_max':B(),'in_stock':B(),'intended_use':null(S(100)),'recipient':null(enum('self','other')),'occasion':null(enum('everyday','gift','work','travel')),'excluded_brands':arr(S(100),10),'shown_brands':arr(S(100),5),'product_ids':arr(U(),5)})
    schemas['MemoryContext']=obj({'revision':I(),'snapshot':null(ref('MemorySnapshot'))})
    schemas['MemoryPreferenceInput']=obj({'attribute':attributes,'value':S(100),**context,'dislike':B(),'replaces':null(U())},('replaces',))
    schemas['MemoryEvidence']=obj({'id':U(),'attribute':attributes,'value':S(100),**context,'signal':enum('explicit_like','explicit_dislike'),'weight':{'type':'integer','enum':[-100,100]},'provenance':enum('customer_control'),'consent_version':I(),'created_at':T(),'expires_at':T()})
    schemas['MemorySignal']=obj({'product_id':U(),'category_id':U(),'name':S(1000),'kind':enum('view','purchase','return'),'weight':{'type':'integer','minimum':-60,'maximum':60},'observed_at':T()})
    schemas['MemoryCategory']=obj({'id':U(),'name':S(1000)})
    schemas['MemoryProduct']=obj({'id':U(),'name':S(1000),'category_id':U()})
    schemas['MemoryView']=obj({'schema_version':enum('1.0.0'),'enabled':B(),'guest':B(),'personalized':B(),'journey_consent':B(),'consent_version':I(),'expires_at':null(T()),'half_life_days':{**I(90),'minimum':1},'preferences':arr(ref('MemoryEvidence'),100),'signals':arr(ref('MemorySignal'),20),'context':ref('MemoryContext'),'categories':arr(ref('MemoryCategory'),100),'products':arr(ref('MemoryProduct'),5)})
    schemas['MemoryConsent']=obj({'personalized':B(),'journey':B(),'expected_version':I()})
    schemas['MemoryConsentRecord']=obj({'version':I(),'personalized':B(),'journey':B(),'purpose':S(),'created_at':T()})
    schemas['MemoryExport']=obj({'schema_version':enum('1.0.0'),'memory':ref('MemoryView'),'contexts':arr(obj({'conversation_id':U(),'snapshot':ref('MemorySnapshot')}),10),'consents':arr(ref('MemoryConsentRecord'),100)})
    schemas['MemoryUpdate']=obj({'conversation_id':U(),'expected_revision':I(),'snapshot':ref('MemorySnapshot')})
    schemas['MemoryConfiguration']=obj({'enabled':B(),'allowed_categories':arr(U(),100),'view_weight':I(20),'purchase_weight':I(20),'return_weight':{'type':'integer','minimum':-20,'maximum':0},'half_life_days':{**I(90),'minimum':1},'retention_days':{**I(90),'minimum':1}})
    for path,method,result,body in [('','get','MemoryView',None),('','put','MemoryView','MemoryConsent'),('','delete','Status',None),('/export','get','MemoryExport',None),('/preferences','post','MemoryEvidence','MemoryPreferenceInput'),('/preferences/{id}','delete','Status',None),('/context/{id}','delete','Status',None)]:
        endpoint('/v1/assistant/memory'+path,method,result,body)
    paths['/v1/assistant/memory']['get']['parameters']=[{'in':'query','name':'conversation_id','schema':U()}]
    endpoint('/v1/assistant-tools/memory','get','MemoryView')
    paths['/v1/assistant-tools/memory']['get']['parameters']=[{'in':'query','name':'conversation_id','schema':U()}]
    endpoint('/v1/assistant-tools/memory','put','Status','MemoryUpdate')
    endpoint('/v1/admin/assistant/memory','get','MemoryConfiguration',auth='adminSession')
    endpoint('/v1/admin/assistant/memory','put','MemoryConfiguration','MemoryConfiguration',auth='adminSession')
    schemas['SavedGoal']=obj({'task_id':U(),'name':S(100),'archived':B(),'version':I(),'revision':I(),'mode':enum('shop','optimize','buy_again'),'expires_at':T(),'state':S(40)})
    schemas['SavedGoals']=obj({'goals':arr(ref('SavedGoal'),50)})
    schemas['SavedGoalMetadata']=obj({'expected_version':I(),'name':S(100),'archived':B()})
    endpoint('/v1/cart/saved-goals','get','SavedGoals')
    endpoint('/v1/cart/saved-goals/{task}','put','Status','SavedGoalMetadata')
    endpoint('/v1/cart/saved-goals/{task}','delete','Status')
    for method in ['put','delete']:
        paths['/v1/cart/saved-goals/{task}'][method]['parameters']=[{'in':'path','name':'task','required':True,'schema':U()},{'in':'header','name':'X-Commerce-Request','required':True,'schema':enum('1')}]
    paths['/v1/cart/saved-goals/{task}']['delete']['parameters'].append({'in':'query','name':'version','required':True,'schema':I()})
    paths['/v1/assistant/chat']['post'].setdefault('parameters',[]).append({'in':'header','name':'X-Commerce-Personalize','schema':enum('0'),'description':'Opt out of optional preference and journey ranking for this request.'})
