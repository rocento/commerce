def extend(schemas, endpoint, paths):
    def ref(name): return {"$ref": f"#/components/schemas/{name}"}
    def obj(fields): return {"type":"object","properties":fields,"required":list(fields),"additionalProperties":False}
    def string(): return {"type":"string"}
    def enum(*values): return {"type":"string","enum":list(values)}
    def array(items): return {"type":"array","items":items}
    integer={"type":"integer"}
    timestamp={"type":"string","format":"date-time"}
    schemas['SegmentRule']=obj({"id":string(),"type":enum("customer","cart","order"),"attribute":string(),"operator":string(),"value":string()})
    fields={"name":string(),"description":string(),"status":enum("active","inactive"),"website":enum("Main Website"),"applyTo":enum("registered"),"match":enum("all","any"),"rules":array(ref("SegmentRule")),"revision":integer}
    schemas['CustomerSegmentInput']=obj(fields)
    schemas['CustomerSegment']=obj({**fields,"id":{"type":"string","format":"uuid"},"updatedAt":timestamp,"matchedCustomers":integer,"evaluatedAt":timestamp})
    schemas['SegmentField']=obj({"family":enum("customer","cart","order"),"attribute":string(),"operators":array(string())})
    base='/v1/admin/customer-segments'
    endpoint(base+'/count','get',auth='adminSession')
    paths[base+'/count']['get']['responses']['200']['content']['application/json']['schema']={'type':'integer','format':'int64'}
    endpoint(base,'get','CustomerSegment',auth='adminSession',many=True)
    paths[base]['get'].setdefault('parameters', []).append({'in':'query','name':'offset','schema':{'type':'integer','minimum':0,'maximum':1000000}})
    endpoint(base,'post','CustomerSegment','CustomerSegmentInput',auth='adminSession')
    endpoint(base+'/fields','get','SegmentField',auth='adminSession',many=True)
    endpoint(base+'/{id}','get','CustomerSegment',auth='adminSession')
    endpoint(base+'/{id}','put','CustomerSegment','CustomerSegmentInput',auth='adminSession')
    endpoint(base+'/{id}','delete',status=204,auth='adminSession')
    paths[base+'/{id}']['delete']['responses']['204']={'description':'Deleted'}
    paths[base+'/{id}']['delete']['parameters'].append({'in':'query','name':'revision','required':True,'schema':{'type':'integer','minimum':1}})
