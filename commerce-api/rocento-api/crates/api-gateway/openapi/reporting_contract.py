"""M8 read-only reporting contract."""
def extend(schemas, endpoint, paths):
    S=lambda:{'type':'string'}
    N=lambda:{'type':'integer','minimum':0}
    def obj(p): return {'type':'object','properties':p,'required':list(p),'additionalProperties':False}
    def arr(n): return {'type':'array','items':{'$ref':'#/components/schemas/'+n}}
    schemas['AnalyticsEvent']['properties']['event_type']['enum'] += ['cart_added','checkout_started','order_placed']
    schemas['AnalyticsEvent']['properties']['source']={'type':'string','enum':['direct','search','social','email','referral','unknown']}
    schemas['ReportRun']=obj({'generation':S(),'started_at':S(),'completed_at':S(),'age_seconds':N()})
    schemas['SalesDay']=obj({'day':S(),'currency':S(),'orders':N(),'cancelled':N(),'gross':S(),'refunds':S(),'net':S()})
    schemas['ProductPerformance']=obj({'product_id':S(),'sku':S(),'name':S(),'currency':S(),'units':N(),'revenue':S()})
    schemas['ReportFunnel']=obj({k:N() for k in ['visitors','carts','checkouts','purchases']})
    schemas['TrafficSource']=obj({'source':S(),'sessions':N()})
    schemas['RetentionCohort']=obj({'cohort':S(),'month':N(),'customers':N(),'returning':N()})
    schemas['CustomerLtv']=obj({'currency':S(),'customers':N(),'value':S(),'average':S()})
    schemas['DashboardReport']=obj({'from':S(),'to':S(),'run':{'$ref':'#/components/schemas/ReportRun'},'sales':arr('SalesDay'),'products':arr('ProductPerformance'),'funnel':{'$ref':'#/components/schemas/ReportFunnel'},'traffic':arr('TrafficSource'),'cohorts':arr('RetentionCohort'),'ltv':arr('CustomerLtv')})
    endpoint('/v1/admin/reports/trace-probe','get','Status',auth='adminSession')
    path='/v1/admin/reports/dashboard'
    endpoint(path,'get','DashboardReport',auth='adminSession')
    paths[path]['get']['parameters']=[{'in':'query','name':n,'required':True,'schema':{'type':'string','format':'date'}} for n in ['from','to']]
