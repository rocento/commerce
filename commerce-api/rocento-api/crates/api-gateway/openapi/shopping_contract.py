"""Browser proposal contracts; applying is never an assistant tool."""
def extend(schemas, endpoint, paths):
    def ref(n): return {'$ref': '#/components/schemas/' + n}
    def obj(p): return {'type':'object','properties':p,'required':list(p),'additionalProperties':False}
    def arr(v): return {'type':'array','items':v}
    def null(v): return {'allOf':[v],'nullable':True} if '$ref' in v else {**v,'nullable':True}
    s={'type':'string'}; n={'type':'integer'}; b={'type':'boolean'}; u={**s,'format':'uuid'}
    mode={**s,'enum':['shop','optimize','buy_again']}
    schemas['ShoppingGoal']=obj({'purpose':s,'budget':null(s),'currency':null(s),'all_inclusive':b,'budget_exclusive':b,'people':null(n),'locked_products':arr(u),'excluded_products':arr(u),'locked_brands':arr(s),'allow_substitutions':b,'delivery_date':null(s),'assumptions':arr(s),'unresolved':arr(s),'saving_target':null(s)})
    schemas['BasketSelection']=obj({'product_id':u,'quantity':{'type':'integer','minimum':1,'maximum':1000000},'replaces':null(u),'required_attributes':{'type':'object','additionalProperties':True},'reason':s})
    schemas['BasketSelection']['properties'].update({'min_price':null(s),'max_price':null(s),'exclusive_max':b,'exclusive_min':b})
    schemas['BasketDraft']=obj({'task_id':u,'task_revision':n,'source_revision':n,'mode':mode,'auto_select':b,'goal':ref('ShoppingGoal'),'location_id':null(u),'order_id':null(u),'selections':arr(ref('BasketSelection'))})
    schemas['BasketTotals']=obj({'subtotal':s,'discount':s,'merchandise_total':s,'tax':null(s),'delivery':null(s),'payable':null(s),'currency':s,'promotions':arr(s)})
    schemas['BasketProposalLine']=obj({'selection':ref('BasketSelection'),'product':null(ref('Product')),'previous':null(ref('Product')),'historical_price':null(s),'available':n})
    schemas['BasketQuotedItem']=obj({'product_id':u,'name':s,'sku':s,'unit':s,'quantity':n,'price':s,'currency':s,'line_total':s,'variant_attributes':{'type':'object','additionalProperties':True}})
    schemas['BasketProposal']=obj({'id':u,'draft':ref('BasketDraft'),'expires_at':{**s,'format':'date-time'},'lines':arr(ref('BasketProposalLine')),'current_items':arr(ref('BasketQuotedItem')),'resulting_items':arr(ref('BasketQuotedItem')),'before':ref('BasketTotals'),'after':ref('BasketTotals'),'savings':null(s),'issues':arr(s),'notes':arr(s),'can_apply':b,'applied':b})
    schemas['ShoppingContext']=obj({'cart':ref('Cart'),'source_revision':n,'task_revision':n,'draft':null(ref('BasketDraft')),'cancelled':b,'locations':arr(obj({'id':u,'label':s,'is_default':b})),'proposal_id':null(u),'proposed_items':arr(obj({'product_id':u,'name':null(s),'quantity':n})),'supported_payment_methods':arr({**s,'enum':['cod']}),'delivery_slots_available':b})
    schemas['ShoppingContext']['properties']['execution_enabled']=b
    date={**s,'format':'date-time'}
    state={**s,'enum':['created','planned','executing','verifying','replanning','needs_input','awaiting_confirmation','completed','cancelled','expired','blocked']}
    schemas['ShoppingExecutionReceipt']=obj({'schema_version':{**s,'enum':['1.0']},'goal_id':u,'revision':{'type':'integer','minimum':1},'state':state,'verdict':{**s,'enum':['pass','needs_input','stale','blocked']},'playbook':{**s,'enum':['playbook://commerce/shop','playbook://commerce/optimize','playbook://commerce/buy-again-ui']},'version':{**s,'enum':['1.0.0']},'proposal_id':u,'observed_at':date,'expires_at':date,'reasons':arr(s)})
    schemas['ShoppingExecutionObservation']=obj({'product_id':u,'price':s,'currency':s,'unit':s,'quantity':n,'available':null(n),'observed_at':date,'expires_at':date,'source':s})
    schemas['ShoppingActionEnvelope']=obj({'store_id':u,'cart_id':u,'customer_id':null(u),'scope':{**s,'enum':['cart_read_propose','cart_write']},'risk':{**s,'enum':['R0','R2']},'confirmation':{**s,'enum':['none','consumed']},'proposal_id':u,'idempotency_key':null(u),'expected_revision':n,'expires_at':date})
    schemas['ShoppingExecutionGoal']=obj({'receipt':ref('ShoppingExecutionReceipt'),'saved_by_customer':b,'goal_expires_at':date,'goal':ref('ShoppingGoal'),'selected':arr(u),'rejected':arr(u),'skill_versions':arr(s),'transitions':arr(state),'observations':arr(ref('ShoppingExecutionObservation')),'envelope':ref('ShoppingActionEnvelope'),'revalidations':n,'max_revalidations':n,'failed_verifications':n,'max_failed_verifications':n,'max_parallelism':n,'max_mutations':n,'deadline_ms':n})
    schemas['ShoppingGoalRevision']=obj({'revision':{'type':'integer','minimum':1}})
    schemas['BasketProposal']['properties']['execution']=ref('ShoppingExecutionReceipt')
    endpoint('/v1/cart/shopping/{task}/goal','get','ShoppingExecutionGoal')
    endpoint('/v1/cart/shopping/{task}/goal','post','ShoppingExecutionGoal','ShoppingGoalRevision')
    endpoint('/v1/cart/shopping/{task}/resume','post','BasketProposal','ShoppingGoalRevision')
    for path in ['/v1/cart/shopping/{task}/goal','/v1/cart/shopping/{task}/resume']:
        for op in paths[path].values():
            op.setdefault('parameters', []).append({'in':'path','name':'task','required':True,'schema':u})

    schemas['BasketApply']=obj({'idempotency_key':u})
    endpoint('/v1/cart/shopping/{task}','get','ShoppingContext')
    endpoint('/v1/cart/shopping/{task}','delete','Status')
    endpoint('/v1/cart/proposals','post','BasketProposal','BasketDraft')
    endpoint('/v1/cart/proposals/{id}','get','BasketProposal')
    endpoint('/v1/cart/proposals/{id}/apply','post','Cart','BasketApply')
    for path in ['/v1/cart/shopping/{task}', '/v1/cart/proposals', '/v1/cart/proposals/{id}', '/v1/cart/proposals/{id}/apply']:
        for op in paths[path].values():
            op.setdefault('parameters', []).append({'in':'header','name':'X-Commerce-Assistant-Errors','required':False,'schema':{'type':'string','enum':['1']}})
            op['responses']['default'] = {'description':'Customer-safe error; typed failure is opt-in.', 'content': {'application/json': {'schema': ref('AssistantHttpError')}}}
    endpoint('/v1/assistant-tools/baskets/{cart}','get','ShoppingContext')
    paths['/v1/assistant-tools/baskets/{cart}']['get'].setdefault('parameters', []).append({'in':'query','name':'task_id','required':True,'schema':u})
    endpoint('/v1/assistant-tools/baskets/{cart}','post','BasketProposal','BasketDraft')

    for path in ['/v1/cart/shopping/{task}', '/v1/assistant-tools/baskets/{cart}']:
        name = 'task' if '{task}' in path else 'cart'
        for op in paths[path].values():
            op.setdefault('parameters', []).append({'in':'path','name':name,'required':True,'schema':u})
