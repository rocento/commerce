"""Assistant v1 schemas, added to the existing Commerce contract source."""
def extend(schemas, endpoint, paths):
    import json
    from pathlib import Path
    schemas.update(json.loads((Path(__file__).with_name("shopper_tools.json")).read_text())["schemas"])
    endpoint('/v1/assistant-tools/shopper', 'post', 'ShopperCatalogResult', 'ShopperToolRequest')
    def string(maximum=4000):
        return {'type': 'string', 'maxLength': maximum, 'minLength': 1}
    uuid = {'type': 'string', 'format': 'uuid'}
    def enum(*values):
        return {'type': 'string', 'enum': list(values)}
    def ref(name):
        return {'$ref': '#/components/schemas/' + name}
    def obj(fields, optional=()):
        return {'type': 'object', 'properties': fields, 'required': [k for k in fields if k not in optional], 'additionalProperties': False}
    def array(item, maximum, minimum=0):
        return {'type': 'array', 'items': item, 'maxItems': maximum, 'minItems': minimum}
    route = {**string(46), 'pattern': r'^/products/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'}
    schemas.update({
        'AssistantProductAttribute': obj({'name': string(100), 'value': string(250)}),
        'AssistantSource': obj({'kind': enum('catalog'), 'product_id': uuid, 'route': route}),
        'AssistantProduct': obj({'id': uuid, 'name': string(1000), 'image_id': {**uuid, 'nullable': True}, 'price': {**string(19), 'pattern': r'^\d{1,12}(\.\d{1,6})?$'}, 'currency': {**string(3), 'pattern': r'^[A-Z]{3}$'}, 'in_stock': {'type':'boolean','nullable':True}, 'route':route, 'attributes':array(ref('AssistantProductAttribute'),20), 'reasons':array(string(350),20), 'unmet':array(string(250),20), 'original_price':{**string(19), 'pattern': r'^\d{1,12}(\.\d{1,6})?$'}}, ['original_price']),
        'AssistantComparisonRow': obj({'label':string(100),'values':array(string(250),5,2)}),
        'AssistantAction': obj({'label':string(100),'route':enum('/search')}),
        'AssistantTransferItem': obj({'name':string(1000),'status':enum('transferred','not_transferred','not_confirmed'),'detail':string(250)}, ['detail']),
        'AssistantWishlistRemove': obj({'product_id':uuid}),
        'AssistantCartRemoval': obj({'product_id':uuid,'name':string(1000),'quantity':{'type':'integer','minimum':1,'maximum':1000000},'remaining_quantity':{'type':'integer','minimum':0,'maximum':1000000},'cart_quantity':{'type':'integer','minimum':0},'cart_subtotal':string(40),'currency':{**string(3),'pattern':r'^[A-Z]{3}$'}}),
        'AssistantCartRemovalChoice': obj({'items':array(ref('AssistantCartItem'),5,1),'quantity':{'type':'integer','minimum':1,'maximum':1000000,'nullable':True}}),
        'AssistantProductPrompt': obj({'query':string(120),'quantity':{'type':'integer','minimum':1,'maximum':1000000},'action':enum('choose','cart','wishlist','compare','remove')}),
        'AssistantCompoundProduct': obj({'name':string(1000),'sku':{**string(200),'pattern':'^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'}}),
        'AssistantCompoundActionChoice': obj({'destination':enum('cart','wishlist'),'quantity':{'type':'integer','minimum':1,'maximum':1000000},'choices':array(ref('AssistantCompoundProduct'),5,1)}),
        'AssistantCompoundChoice': obj({'actions':array(ref('AssistantCompoundActionChoice'),2,2)}),
        'AssistantBlock': obj({'kind':enum('text','product_card','product_list','comparison_table','recommendation_group','action','cart_summary','basket_proposal','saved_addresses','wishlist_manage','wishlist_transfer','product_prompt','cart_removal','cart_removal_choice','compound_choice'), 'text':string(8000), 'title':string(200), 'products':array(ref('AssistantProduct'),8,1), 'rows':array(ref('AssistantComparisonRow'),24,1), 'action':ref('AssistantAction'), 'sources':array(ref('AssistantSource'),8,1), 'cart':ref('AssistantCartView'), 'proposal_id':uuid, 'compound_choice':ref('AssistantCompoundChoice'), 'product_prompt':ref('AssistantProductPrompt'), 'cart_removal':ref('AssistantCartRemoval'), 'cart_removal_choice':ref('AssistantCartRemovalChoice'), 'transfer_items':array(ref('AssistantTransferItem'),5,1)}, ['text','title','products','rows','action','sources','cart','proposal_id','transfer_items','product_prompt','cart_removal','cart_removal_choice','compound_choice']),
    })
    schemas.update({
        'AssistantFeedback': obj({'request_id':uuid,'helpful':{'type':'boolean'}}),
        'AssistantHistoryTurn': obj({'response_source':{**enum('R','L'),'nullable':True},'conversation_id':uuid,'request_id':uuid,'question':string(4000),'answer':{'type':'string','maxLength':8000},'blocks':array(ref('AssistantBlock'),8),'helpful':{'type':'boolean','nullable':True},'created_at':{'type':'string','format':'date-time'}}, ['blocks','helpful','response_source']),
        'AssistantClarification': obj({'original_message': string(4000), 'question': string(1000), 'revision': uuid, 'kind': enum('shopping'), 'choices': array(string(120), 8), 'optional': {'type':'boolean'}}, ['revision','kind','choices','optional']),
        'AssistantChatInput': obj({'request_id': uuid, 'message': string(), 'order_id': uuid, 'product_id': uuid, 'cart_context': {'type':'boolean'}, 'ticket': ref('AssistantTicketInput'), 'conversation_id': uuid, 'shopping_mode':enum('shop','optimize','buy_again'), 'clarification':ref('AssistantClarification')}, ['order_id','product_id','cart_context','ticket','conversation_id','shopping_mode','clarification']),
        'AssistantOrderArgs': obj({'order_id': uuid}),
        'AssistantCartItem': obj({'product_id':uuid,'name':string(1000),'price':string(40),'currency':string(3),'quantity':{'type':'integer','minimum':1,'maximum':1000000},'line_total':string(40)}),
        'AssistantCart': obj({'items':array(ref('AssistantCartItem'),200),'subtotal':string(40),'discount_amount':string(40),'currency':string(3),'fully_reserved':{'type':'boolean'}}),
        'AssistantCartView': obj({'items':array(ref('AssistantCartItem'),200),'total_lines':{'type':'integer','minimum':0},'total_quantity':{'type':'integer','minimum':0},'subtotal':string(40),'discount_amount':string(40),'currency':string(3),'fully_reserved':{'type':'boolean'}}),
        'AssistantDelivery': obj({'configured':{'type':'boolean'},'deliverable':{'type':'boolean'},'area_id':{**uuid,'nullable':True}}),
        'AssistantShipment': obj({'tracking_reference': {'type': 'string', 'maxLength': 500}, 'status': string(50)}),
        'AssistantOrder': obj({'id': uuid, 'number': {'type': 'integer'}, 'status': string(50), 'subtotal': string(40), 'discount_amount': string(40), 'tax_amount': string(40), 'delivery_fee': string(40), 'total': string(40), 'currency': string(3), 'cancellation_available': {'type': 'boolean'}, 'shipments': {'type': 'array', 'items': ref('AssistantShipment'), 'maxItems': 100}}),
        'AssistantSavedLocation': obj({'id':uuid,'label':string(100),'formatted_address':string(1000),'is_default':{'type':'boolean'}}),
        'AssistantTicketInput': obj({'request_id': uuid, 'subject': string(160), 'category': enum('order_issue','product_question','complaint','payment_dispute','other'), 'body': string(2000), 'order_id': uuid, 'contact_name': string(100), 'contact': string(254)}, ['order_id','contact_name','contact']),
        'AssistantTicket': obj({'id': uuid, 'number': {'type':'integer'}, 'subject': string(160), 'category': enum('order_issue','product_question','complaint','payment_dispute','other'), 'status': enum('open','in_progress','resolved','closed'), 'priority': enum('normal','high'), 'order_id': {**uuid,'nullable': True}, 'created_at': {'type':'string','format':'date-time'}}),
        'AssistantTicketMessage': obj({'id': uuid, 'sender': enum('customer','admin','assistant_summary'), 'body': string(2000), 'created_at': {'type':'string','format':'date-time'}}),
        'AssistantTicketDetail': obj({'ticket': ref('AssistantTicket'), 'messages': {'type':'array','items':ref('AssistantTicketMessage')}, 'contact_name': {**string(100), 'nullable': True}, 'contact': {**string(254), 'nullable': True}}),
        'AssistantReply': obj({'request_id': uuid, 'body': string(2000), 'status': enum('open','in_progress','resolved','closed')}, ['status']),
        'AssistantFailure': obj({'code': enum('provider_timeout','provider_rate_limit','tool_unavailable','catalog_failure','stale_proposal','invalid_provider_response','authentication_needed','unsupported_action','internal_failure'), 'message': string(400), 'retryable': {'type':'boolean'}, 'recovery': enum('retry','sign_in','refresh_proposal','browse_catalog','contact_support'), 'request_reference': uuid}, []),
        'AssistantEvent': obj({'response_source':enum('R','L'),'version': enum('1'), 'request_id': uuid, 'sequence': {'type':'integer','minimum':0}, 'type': enum('message.delta','card.order','ticket.created','progress','content.blocks','error','done'), 'clarification':ref('AssistantClarification'),'saved':{'type':'boolean'},'failure':ref('AssistantFailure'),'blocks': array(ref('AssistantBlock'),8,1), 'stage': enum('preparing','catalog','order','support','responding'), 'text': string(8000), 'order': ref('AssistantOrder'), 'ticket': ref('AssistantTicketDetail'), 'code': enum('login_required','unavailable','area_unavailable','open_address_form','open_checkout','clear_comparison','unknown','support_required')}, ['stage','text','order','ticket','code','blocks','saved','failure','clarification','response_source']),
    })
    endpoint('/v1/assistant/feedback','post','Status','AssistantFeedback',auth='customerBearer')
    endpoint('/v1/admin/assistant/usage','get','AssistantUsage',auth='adminSession')
    schemas['AssistantModelUsage'] = obj({'provider':string(100),'model':string(100),'input_tokens':{'type':'integer','minimum':0},'output_tokens':{'type':'integer','minimum':0},'turns':{'type':'integer','minimum':0}})
    schemas['AssistantRouteUsage'] = obj({'route':string(100),'turns':{'type':'integer','minimum':0}})
    schemas['AssistantUsage'] = obj({k:{'type':'integer','minimum':0} for k in ['turns','conversations','errors','helpful','not_helpful','input_tokens','output_tokens','tool_calls','retrieval_count','usage_recorded','model_calls','estimated_cost_micros','cost_recorded']} | {'latency_ms':{'type':'number'},'models':array(ref('AssistantModelUsage'),10),'routes':array(ref('AssistantRouteUsage'),10)})
    schemas['AssistantDeliveryEvent'] = obj({'conversation_id':uuid,'request_id':uuid,'location_id':uuid})
    schemas['AssistantEventSaved'] = obj({'saved':{'type':'boolean'}})
    endpoint('/v1/assistant/delivery-event','post','AssistantEventSaved','AssistantDeliveryEvent',auth='customerBearer')
    endpoint('/v1/assistant/history','get','AssistantHistoryTurn',auth='customerBearer',many=True)
    paths['/v1/assistant/history']['get']['parameters']=[{'in':'query','name':'conversation_id','required':False,'schema':uuid}]
    endpoint('/v1/assistant/chat','post','AssistantEvent','AssistantChatInput')
    schemas['AssistantHttpError'] = obj({'error': string(400), 'failure': ref('AssistantFailure')}, ['failure'])
    paths['/v1/assistant/chat']['post'].setdefault('parameters', []).extend([
        {'in':'header','name':'X-Commerce-Assistant-Errors','required':False,'schema':enum('1')},
        {'in':'header','name':'X-Commerce-Request-Reference','required':False,'schema':uuid},
    ])
    paths['/v1/assistant/chat']['post']['responses']['default'] = {'description':'Customer-safe error; typed failure is opt-in.', 'content': {'application/json': {'schema': ref('AssistantHttpError')}}}
    paths['/v1/assistant/chat']['post']['responses']['200']['content'] = {'text/event-stream': {'schema': ref('AssistantEvent')}}
    endpoint('/v1/assistant-tools/orders/{id}','get','AssistantOrder')
    endpoint('/v1/assistant-tools/orders/by-number/{number}','get','AssistantOrder')
    paths['/v1/assistant-tools/orders/by-number/{number}']['get']['parameters']=[{'in':'path','name':'number','required':True,'schema':{'type':'integer','format':'int64','minimum':1}}]
    endpoint('/v1/assistant-tools/orders','get','AssistantOrder',many=True)
    endpoint('/v1/assistant-tools/cart','get','AssistantCart')
    endpoint('/v1/assistant-tools/wishlist','get','IdList')
    endpoint('/v1/assistant-tools/wishlist','delete','Status','AssistantWishlistRemove')
    endpoint('/v1/assistant-tools/locations','get','AssistantSavedLocation',many=True)
    endpoint('/v1/assistant-tools/support/tickets','get','AssistantTicket',many=True)
    endpoint('/v1/assistant-tools/support/tickets/{id}','get','AssistantTicketDetail')
    endpoint('/v1/assistant-tools/delivery','get','AssistantDelivery')
    endpoint('/v1/assistant-tools/support/tickets','post','AssistantTicketDetail','AssistantTicketInput',201)
    endpoint('/v1/support/session','post')
    endpoint('/v1/support/tickets','post','AssistantTicketDetail','AssistantTicketInput',201)
    for who, auth in [('customer','customerBearer'),('admin','adminSession')]:
        root='/v1/'+who+'/support/tickets'
        endpoint(root,'get','AssistantTicket',auth=auth,many=True)
        endpoint(root+'/{id}','get','AssistantTicketDetail',auth=auth)
        endpoint(root+'/{id}/messages','post','AssistantTicketDetail','AssistantReply',auth=auth)
