"""M09 cart-only delegation. Financial scopes are named explicitly but never executable."""
def extend(schemas, endpoint, paths):
    S=lambda n=200:{'type':'string','maxLength':n}
    U=lambda:{'type':'string','format':'uuid'}
    T=lambda:{'type':'string','format':'date-time'}
    B=lambda:{'type':'boolean'}
    I=lambda lo=0,hi=1000:{'type':'integer','minimum':lo,'maximum':hi}
    E=lambda *v:{'type':'string','enum':list(v)}
    R=lambda n:{'$ref':'#/components/schemas/'+n}
    N=lambda s:{**s,'nullable':True}
    A=lambda s,n=100:{'type':'array','items':s,'maxItems':n}
    O=lambda p,optional=():{'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    money={'type':'string','pattern':r'^\d+(\.\d{1,2})?$','maxLength':30}
    scope=E('cart.read','cart.propose','cart.apply','order.place','payment.authorize','order.refund')
    common={'agent_id':U(),'allowed_scopes':A(scope,6),'denied_scopes':A(scope,6),'product_ids':A(U()),'category_ids':A(U(),50),'location_id':N(U()),'max_amount':money,'max_total':money,'currency':S(3),'max_actions':I(1,100)}
    schemas['TrustGrantInput']=O({**common,'duration_seconds':I(30,900)})
    schemas['TrustGrant']=O({**common,'id':U(),'tenant_id':U(),'customer_id':N(U()),'session_id':N(U()),'cart_id':U(),'channel':E('browser','signed_http'),'nonce':U(),'key_fingerprint':S(),'used_actions':I(),'spent':money,'confirmation_required':E(True),'policy_version':E('1.0.0'),'issued_at':T(),'expires_at':T(),'revoked_at':N(T())})
    schemas['TrustGrant']['properties']['confirmation_required']={'type':'boolean','enum':[True]}
    schemas['TrustAction']=O({'id':U(),'grant_id':U(),'tenant_id':U(),'agent_id':U(),'cart_id':U(),'proposal_id':U(),'idempotency_key':U(),'action':E('cart.apply'),'risk':E('R2'),'fingerprint':S(64),'expected_revision':I(0,9007199254740991),'state':E('proposed','authorized','executing','committed','rejected','expired','failed','indeterminate','reconciled','compensated','closed'),'amount':money,'currency':S(3),'confirmed_at':T(),'confirmation_session':N(U()),'expires_at':T(),'created_at':T(),'updated_at':T(),'failure_code':N(S())})
    schemas['TrustConfirmation']=O({'proposal_id':U(),'idempotency_key':U(),'grant_id':N(U())},('grant_id',))
    schemas['TrustConfirmed']=O({'schema_version':E('1.0.0'),'enabled':B(),'action':N(R('TrustAction'))})
    schemas['TrustHistory']=O({'schema_version':E('1.0.0'),'enabled':B(),'grants':A(R('TrustGrant')),'actions':A(R('TrustAction'))})
    schemas['TrustConfiguration']=O({'tenant_id':N(U()),'enabled':B(),'signed_http_enabled':B(),'denied_scopes':A(scope,6),'policy_version':E('1.0.0')})
    registration={'name':S(100),'enabled':B(),'public_key':N(S(8192)),'allowed_scopes':A(scope,3),'max_requests':I(1,120),'max_daily_actions':I(1,1000),'max_daily_amount':money,'currency':S(3)}
    schemas['TrustAgentInput']=O(registration)
    schemas['TrustAgent']=O({**{k:v for k,v in registration.items() if k!='public_key'},'id':U(),'tenant_id':U(),'protocol':E('browser','signed_http'),'key_fingerprint':S()})
    schemas['TrustCapabilities']=O({'schema_version':E('1.0.0'),'enabled':B(),'supported_scopes':A(scope,3),'denied_scopes':A(scope,6),'protocol':E('signed_http'),'confirmation_required':B(),'financial_actions_enabled':B(),'agents':A(O({'id':U(),'name':S(100),'allowed_scopes':A(scope,3)}))})
    schemas['TrustOperation']={'oneOf':[O({'operation':E('read')}),O({'operation':E('propose'),'draft':R('BasketDraft')}),O({'operation':E('apply'),'action_id':U()}),O({'operation':E('status'),'action_id':U()})]}
    schemas['TrustRequest']=O({'grant_id':U(),'request':R('TrustOperation')})
    schemas['TrustResult']=O({'schema_version':E('1.0.0'),'result':{'oneOf':[O({'cart':N(R('Cart'))}),O({'proposal':R('BasketProposal')}),O({'action':R('TrustAction')})]}})
    for path,method,result,body in [('', 'get','TrustHistory',None),('/confirm','post','TrustConfirmed','TrustConfirmation'),('/grants','post','TrustGrant','TrustGrantInput'),('/grants/{id}','delete','Status',None),('/actions/{id}','get','TrustAction',None)]:endpoint('/v1/cart/trust'+path,method,result,body)
    endpoint('/v1/agents/capabilities','get','TrustCapabilities')
    endpoint('/v1/agents/actions','post','TrustResult','TrustRequest')
    paths['/v1/agents/actions']['post']['description']='RS256 proof signed by the registered agent key. Claims: iss=rocento-registered-agent, aud=rocento-cart-actions-v1, tenant_id, agent_id, grant_id, grant_nonce, unique UUID jti, iat, exp (at most 60 seconds), body_sha256 (SHA-256 lowercase hex of exact UTF-8 request body). X-Commerce-Request: 1 required. No customer token or payment data. A fresh proof is required for status lookup; never blindly repeat an ambiguous action.'
    paths['/v1/agents/actions']['post']['security']=[{'agentProof':[]}]
    endpoint('/v1/admin/assistant/trust','get','TrustConfiguration',auth='adminSession')
    endpoint('/v1/admin/assistant/trust','put','TrustConfiguration','TrustConfiguration',auth='adminSession')
    endpoint('/v1/admin/assistant/trust/agents/{id}','put','TrustAgent','TrustAgentInput',auth='adminSession')
