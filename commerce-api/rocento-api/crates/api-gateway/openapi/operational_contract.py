"""Internal gateway operations omitted by the historical feature extensions."""
def extend(schemas, endpoint, paths):
    text={'type':'string'}; uuid={**text,'format':'uuid'}; boolean={'type':'boolean'}
    integer={'type':'integer','format':'int64'}; stamp={**text,'format':'date-time'}
    ref=lambda name:{'$ref':'#/components/schemas/'+name}
    arr=lambda item:{'type':'array','items':item}
    enum=lambda *items:{'type':'string','enum':list(items)}
    nullable=lambda item:{**item,'nullable':True}
    obj=lambda fields,optional=():{'type':'object','properties':fields,'required':[k for k in fields if k not in optional],'additionalProperties':False}
    grids=enum('catalog','inventory','categories','attributes','media','orders','customers','users','roles','audit','content','reviews','promotions','tax','support','attribute-definitions','adjustments','reservations','order-comments','sources','source-items','stocks','delivery-areas','cms-revisions','cms-releases')
    request={**{k:uuid for k in ['actor_id','entity_id','document_id','product_id','order_id','category_id','role_id']},**{k:text for k in ['action','entity_type','sort','status','kind','cursor']},'created_from':stamp,'created_to':stamp,'system':boolean,'active':boolean,'descending':{**boolean,'default':False},'q':{**text,'maxLength':200,'default':'','description':'At most 200 UTF-8 bytes.'},'limit':{'type':'integer','minimum':1,'maximum':200,'default':50}}
    schemas['GridRequest']=obj({key: value if key in ['q','descending'] else nullable(value) for key,value in request.items()},request)
    schemas['GridPage']=obj({'items':arr({'type':'object','additionalProperties':True,'description':'Allowlisted projection for the selected grid. Fields vary by grid; no arbitrary database columns are returned.'}),'next_cursor':nullable(text),'total_count':integer})
    endpoint('/v1/admin/grids/{name}','get','GridPage',auth='adminSession')
    endpoint('/v1/admin/grids/{name}/sorts','get','GridSorts',auth='adminSession')
    schemas['GridSorts']=arr(text)
    for path in ['/v1/admin/grids/{name}','/v1/admin/grids/{name}/sorts']:
        paths[path]['get']['parameters']=[{'name':'name','in':'path','required':True,'schema':grids}]
    paths['/v1/admin/grids/{name}']['get']['parameters'] += [{'name':name,'in':'query','schema':schema} for name,schema in request.items()]
    paths['/v1/admin/grids/{name}']['get']['description']='Requires the selected grid read permission. Only filters supported by that grid are accepted. Source-items/adjustments/reservations require product_id; order-comments require order_id; CMS revisions/releases require document_id. Treat next_cursor as opaque and preserve filters and sorting when paging. Obtain supported sort columns from /sorts.'
    schemas['ExportInput']=obj({'grid':grids,'request':ref('GridRequest'),'columns':{**arr(text),'minItems':1,'uniqueItems':True},'format':enum('csv','xlsx')})
    schemas['ExportAccepted']=obj({'id':uuid,'status':enum('queued')})
    schemas['ExportColumns']=obj({'columns':arr(text)})
    schemas['ExportCancelled']=obj({'id':uuid})
    schemas['ExportJob']=obj({'id':uuid,'owner_id':uuid,'grid':grids,'columns':arr(text),'format':enum('csv','xlsx'),'status':enum('queued','running','completed','failed','cancelled'),'rows_processed':integer,'bytes_written':integer,'error':nullable(text),'created_at':stamp,'heartbeat_at':nullable(stamp),'expires_at':stamp,'download_until':nullable(stamp)})
    endpoint('/v1/admin/exports','get','ExportJob',many=True,auth='adminSession')
    endpoint('/v1/admin/exports','post','ExportAccepted','ExportInput',202,auth='adminSession')
    paths['/v1/admin/exports']['post']['description']='Requires grid read and export permissions; at most three unexpired queued/running jobs per owner. Columns must come from the grid metadata. Server resets the cursor and uses its own page size. The job is not complete when this 202 response is returned.'
    endpoint('/v1/admin/exports/columns/{grid}','get','ExportColumns',auth='adminSession')
    paths['/v1/admin/exports/columns/{grid}']['get']['parameters']=[{'name':'grid','in':'path','required':True,'schema':grids}]
    endpoint('/v1/admin/exports/{id}','get','ExportJob',auth='adminSession')
    endpoint('/v1/admin/exports/{id}','delete','ExportCancelled',auth='adminSession')
    endpoint('/v1/admin/exports/{id}/download','get','Status',auth='adminSession')
    download=paths['/v1/admin/exports/{id}/download']['get']
    download['description']='Owner-scoped download; requires current permissions and an unexpired completed job. Returns 409 while the artifact is not completed.'
    download['responses']['200']['content']={kind:{'schema':{'type':'string','format':'binary'}} for kind in ['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}
    schemas['DeliveryAreaChoice']=obj({'id':uuid,'entity_id':{'type':'integer','format':'int64','minimum':1,'readOnly':True},'name':text,'center_lat':{'type':'number'},'center_lng':{'type':'number'}})
    endpoint('/v1/delivery-areas','get','DeliveryAreaChoice',many=True)
    endpoint('/v1/languages/interface','get','InterfaceBundle')

    quantity={'type':'integer','minimum':1,'maximum':1000000}
    schemas['InternalCartChange']={'oneOf':[obj({'action':enum(action),'product_id':uuid,'quantity':quantity}) for action in ['add','set']]+[obj({'action':enum('remove'),'product_id':uuid,'quantity':nullable(quantity)},['quantity']),obj({'action':enum('clear')})]}
    endpoint('/v1/assistant-tools/cart','post','AssistantCart','InternalCartChange')
    paths['/v1/assistant-tools/cart']['post']['description']='Requires cart_write capability. Request IDs are single-attempt: after an ambiguous result, read the cart before issuing a new action; repeated request IDs are rejected.'
    endpoint('/v1/assistant-tools/wishlist','post','Status','AssistantWishlistRemove',204)
    paths['/v1/assistant-tools/wishlist']['post']['responses']['204'].pop('content')
    paths['/v1/assistant-tools/wishlist']['delete']['responses']['200'].pop('content')
    schemas['InternalWishlistTransferInput']=obj({'product_ids':{**arr(uuid),'minItems':1,'maxItems':200,'uniqueItems':True}})
    schemas['InternalWishlistTransferResult']=obj({'items':arr(obj({'product_id':uuid,'name':text,'status':enum('transferred'),'detail':text})),'cart':ref('AssistantCart')})
    endpoint('/v1/assistant-tools/cart/wishlist-transfer','post','InternalWishlistTransferResult','InternalWishlistTransferInput')
    paths['/v1/assistant-tools/cart/wishlist-transfer']['post']['description']='Requires wishlist_cart_transfer capability. Atomically adds quantity one for every selected wishlist SKU and removes those wishlist entries. Reusing the same request ID and product IDs returns the persisted receipt.'
    schemas['InternalReorderInput']=obj({'order_number':{**integer,'minimum':1}})
    endpoint('/v1/assistant-tools/reorder','post','AssistantOrder','InternalReorderInput')
    paths['/v1/assistant-tools/reorder']['post']['description']='Requires order_reorder:<order_number> capability minted for an explicit customer command. Places a new order using current checkout rules and returns its receipt; this is not a read-only suggestion.'
    version=enum('1.0')
    schemas['InternalCompoundScope']=obj({'schema_version':version,'tenant_id':uuid,'customer_id':uuid,'conversation_id':uuid})
    operation={'schema_version':version,'action_id':uuid,'operation_id':uuid,'product_id':uuid,'quantity':quantity,'destination':enum('cart','wishlist'),'observed_at':{**integer,'minimum':0},'expires_at':integer}
    schemas['InternalCompoundOperation']=obj(operation)
    schemas['InternalCompoundCommand']=obj({'schema_version':version,'scope':ref('InternalCompoundScope'),'request_id':uuid,'revision':uuid,'actions':{**arr(ref('InternalCompoundOperation')),'minItems':2,'maxItems':2}})
    schemas['InternalCompoundDispatch']=obj({'schema_version':version,'command':ref('InternalCompoundCommand'),'action_id':uuid})
    schemas['InternalCompoundReceipt']=obj({'schema_version':version,'scope':ref('InternalCompoundScope'),'revision':uuid,**{key:operation[key] for key in ['action_id','operation_id','product_id','quantity','destination','observed_at']},'receipt_id':uuid,'outcome':enum('succeeded','failed')})
    schemas['InternalCompoundLookup']=obj({'schema_version':version,'receipt':nullable(ref('InternalCompoundReceipt'))})
    endpoint('/v1/assistant-tools/compound-actions','post','InternalCompoundReceipt','InternalCompoundDispatch')
    endpoint('/v1/assistant-tools/compound-actions/receipt','post','InternalCompoundLookup','InternalCompoundDispatch')
    for path in ['/v1/assistant-tools/compound-actions','/v1/assistant-tools/compound-actions/receipt']:
        paths[path]['post']['description']='Requires conversation-scoped compound_write or compound_read capability respectively. Scope and request ID must match the signed delegation. Exactly two distinct actions target cart and wishlist, with unique non-nil IDs; wishlist quantity is one and each observation expires within 30 seconds. Actions are separately transactional and ordered. A missing lookup receipt is not permission to repeat an ambiguous command.'

    # Every private tool authenticates a delegated capability, not customer login.
    for path, methods in paths.items():
        if path.startswith('/v1/assistant-tools/'):
            for operation in methods.values():
                operation['security']=[{'assistantCapability':[]}]
