"""M08 bounded merchant intelligence contract."""
def extend(schemas, endpoint, paths):
    def text(n): return {'type':'string','maxLength':n}
    def obj(fields): return {'type':'object','properties':fields,'required':list(fields),'additionalProperties':False}
    def array(item,n): return {'type':'array','items':item,'maxItems':n}
    question={'type':'string','enum':['orders','low_stock','top_sellers','slow_stock','category_decline','order_status']}
    date={'type':'string','format':'date'}
    common={'question':question,'from':date,'to':date,'currency':{'type':'string','pattern':'^[A-Z]{3}$'},'scope':{'type':'string','enum':['installation']}}
    schemas['MerchantInput']=obj({**common,'order_id':{'type':'string','format':'uuid','nullable':True},'stock_threshold':{'type':'integer','minimum':0,'maximum':1000000},'sales_threshold':{'type':'integer','minimum':0,'maximum':1000000}})
    schemas['MerchantInput']['properties'].update({'request_id':{'type':'string','format':'uuid'},'conversation_id':{'type':'string','format':'uuid'}})
    schemas['MerchantAnswer']=obj({**common,'request_id':{'type':'string','format':'uuid'},'conversation_id':{'type':'string','format':'uuid'},'helpful':{'type':'boolean','nullable':True},'title':text(100),'evaluated_at':{'type':'string','format':'date-time'},'columns':array(text(100),8),'rows':array(array(text(4000),8),20),'notes':array(text(1000),10),'truncated':{'type':'boolean'}})
    endpoint('/v1/admin/assistant/query','post','MerchantAnswer','MerchantInput',auth='adminSession')

    endpoint('/v1/admin/assistant/history','get','MerchantAnswer',auth='adminSession',many=True)
    endpoint('/v1/admin/assistant/feedback','post','Status','AssistantFeedback',auth='adminSession')
    schemas['MerchantMetrics']=obj({k:{'type':'integer','minimum':0} for k in ['turns','conversations','helpful','not_helpful']} | {'latency_ms':{'type':'number'}})
    endpoint('/v1/admin/assistant/metrics','get','MerchantMetrics',auth='adminSession')

    paths['/v1/admin/assistant/history']['get']['parameters']=[{'in':'query','name':'conversation_id','required':False,'schema':{'type':'string','format':'uuid'}}]
