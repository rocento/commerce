"""Fulfillment scheduling and capacity HTTP contracts."""
def extend(schemas, endpoint, paths):
    def obj(p, optional=()): return {'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
    def ref(n): return {'$ref':'#/components/schemas/'+n}
    def arr(s): return {'type':'array','items':s}
    def nullable(s): return {**s,'nullable':True}
    text={'type':'string'}; number={'type':'integer'}; uid={'type':'string','format':'uuid'}; stamp={'type':'string','format':'date-time'}; date={'type':'string','format':'date'}; boolean={'type':'boolean'}
    dimensions={'type':'object','additionalProperties':{'type':'integer','minimum':0}}
    schemas['Error']['properties']['code']=text
    schemas['Error']['properties']['alternatives']=arr(ref('DeliverySlot'))
    schemas['CapacityWindow']=obj({'weekday':{'type':'integer','minimum':0,'maximum':6},'start':text,'end':text,'cutoff':nullable(text)})
    schemas['CapacityException']=obj({'from':date,'through':date,'closed':boolean,'windows':arr(ref('CapacityWindow'))})
    schemas['ScheduleConfig']=obj({'selection_required':boolean,'windows':arr(ref('CapacityWindow')),'duration_minutes':nullable(number),'spacing_minutes':number,'lead_minutes':number,'cutoff':nullable(text),'min_days':number,'max_days':number,'ttl_minutes':number,'release_before':{'type':'string','enum':['never','confirmed','fulfilling','shipped']},'exceptions':arr(ref('CapacityException'))},['selection_required'])
    schemas['FulfillmentSchedule']=obj({'id':uid,'source_id':uid,'area_id':nullable(uid),'method':text,'enabled':boolean,'timezone':text,'config':ref('ScheduleConfig')})
    schemas['CapacityRule']=obj({'id':uid,'overrides_rule_id':nullable(uid),'source_id':nullable(uid),'area_id':nullable(uid),'method':nullable(text),'timezone':text,'local_start':nullable(text),'period':{'type':'string','enum':['slot','hour','day']},'limits':dimensions,'overflow_percent':number,'starts_on':nullable(date),'ends_on':nullable(date),'enabled':boolean})
    slot={'schedule_id':uid,'source_id':uid,'method':text,'timezone':text,'starts_at':stamp,'ends_at':stamp,'availability':text}
    schemas['DeliverySlot']=obj(slot)
    schemas['DeliveryOptions']=obj({'enabled':boolean,'slots':arr(ref('DeliverySlot'))})
    schemas['CapacitySelection']=obj({'schedule_id':uid,'location_id':uid,'starts_at':stamp,'ends_at':stamp,'idempotency_key':uid})
    schemas['CapacityHold']=obj({'id':uid,'status':text,'expires_at':stamp,'source_id':uid,'method':text,'starts_at':stamp,'ends_at':stamp})
    scheduled={'timezone':text,'id':uid,'source_id':uid,'area_id':nullable(uid),'method':text,'starts_at':stamp,'ends_at':stamp,'requirement':dimensions}
    schemas['ScheduledDelivery']=obj(scheduled)
    schemas['ScheduledOrderDelivery']=obj({**scheduled,'source_name':text,'status':text,'timezone':text})
    schemas['CheckoutSnapshot']['properties']['scheduled_delivery']=ref('ScheduledDelivery')
    schemas['OrderDetail']['properties']['scheduled_deliveries']=arr(ref('ScheduledOrderDelivery'))
    schemas['OrderDetail']['required'].append('scheduled_deliveries')
    schemas['SaveFulfillmentSchedule']=obj({'schedule':ref('FulfillmentSchedule'),'reason':text})
    schemas['SaveCapacityRule']=obj({'rule':ref('CapacityRule'),'reason':text,'acknowledge_existing_bookings':boolean},['acknowledge_existing_bookings'])
    pair={'type':'array','items':text,'minItems':2,'maxItems':2}
    schemas['CapacityConfiguration']=obj({'enabled':boolean,'schedules':arr(ref('FulfillmentSchedule')),'rules':arr(ref('CapacityRule')),'sources':arr(pair),'areas':arr(pair)})
    schemas['CapacityConstraint']=obj({'rule_id':uid,'period':text,'dimension':text,'limit':number,'effective':number,'used':number,'remaining':number})
    schemas['CapacityRow']=obj({'slot':ref('DeliverySlot'),'area_id':nullable(uid),'reserved':number,'confirmed':number,'utilization':{'type':'number'},'status':text,'caps':arr(ref('CapacityConstraint'))})
    schemas['CapacityOverview']=obj({'date':date,'slots':arr(ref('CapacityRow'))})
    endpoint('/v1/fulfillment/delivery-options','get','DeliveryOptions',auth='customerBearer')
    paths['/v1/fulfillment/delivery-options']['get']['parameters']=[{'name':k,'in':'query','required':True,'schema':v} for k,v in [('location_id',uid),('date',date)]]
    endpoint('/v1/fulfillment/reservations','post','CapacityHold','CapacitySelection',auth='customerBearer')
    endpoint('/v1/fulfillment/reservations/{id}','delete',auth='customerBearer')
    schemas['CapacitySettings']=obj({'enabled':boolean,'reason':text})
    endpoint('/v1/admin/fulfillment/settings','post',body='CapacitySettings',auth='adminSession')
    endpoint('/v1/admin/fulfillment/configuration','get','CapacityConfiguration',auth='adminSession')
    endpoint('/v1/admin/fulfillment/capacity','get','CapacityOverview',auth='adminSession')
    paths['/v1/admin/fulfillment/capacity']['get']['parameters']=[{'name':'date','in':'query','required':True,'schema':date}]
    endpoint('/v1/admin/fulfillment/schedules','post',body='SaveFulfillmentSchedule',auth='adminSession')
    endpoint('/v1/admin/fulfillment/capacity-rules','post',body='SaveCapacityRule',auth='adminSession')
    capabilities={k:boolean for k in ['delivery_enabled','pickup_enabled','scheduled_delivery_enabled','asap_delivery_enabled','capacity_management_enabled','checkout_capacity_holds_enabled','geo_fencing_enabled','global_delivery_enabled','multi_source_fulfillment_enabled','split_order_scheduling_enabled','automatic_source_routing_enabled','customer_delivery_slot_selection_enabled','admin_manual_scheduling_enabled','pickup_scheduling_enabled']}
    capabilities['global_delivery_enabled']={**boolean,'description':'Allow delivery worldwide from default and global stock pools, bypassing area and city restrictions. Defaults to false.'}
    capabilities.update(split_delivery_mode={'type':'string','enum':['same_window_required','independent_windows']},delivery_city_ids=arr(text))
    schemas['FulfillmentCapabilities']=obj(capabilities)
    schemas['FulfillmentCapabilityOverrides']=obj(capabilities,list(capabilities))
    schemas['FulfillmentRequest']=obj({'method':{'type':'string','enum':['delivery','pickup']},'location_id':nullable(uid),'source_id':nullable(uid),'date':date,'asap':boolean},['location_id','source_id','asap'])
    schemas['FulfillmentWindow']=obj({k:slot[k] for k in ['source_id','schedule_id','starts_at','ends_at']})
    schemas['FulfillmentSelection']=obj({'request':ref('FulfillmentRequest'),'windows':arr(ref('FulfillmentWindow')),'idempotency_key':uid})
    item=obj({'product_id':uid,'quantity':number})
    group=obj({'id':uid,'source_id':uid,'source_name':text,'method':text,'schedule_id':nullable(uid),'starts_at':stamp,'ends_at':stamp,'timezone':text,'items':arr(item)})
    schemas['FulfillmentPlan']=obj({'id':uid,'method':text,'store_id':uid,'location_id':nullable(uid),'expires_at':stamp,'status':text,'groups':arr(group)})
    schemas['CheckoutSnapshot']['properties']['fulfillment_plan']=ref('FulfillmentPlan')
    schemas['OrderDetail']['properties']['fulfillment_plan']=nullable(ref('FulfillmentPlan'))
    schemas['Shipment']['properties']['method']={'type':'string','enum':['delivery','pickup']}
    schemas['Shipment']['properties']['status']['enum']+=['pickup_ready','picked_up']
    schemas['Order']['properties']['status']['enum']+=['pickup_ready','picked_up']
    schemas['QuoteInput']['properties']['location_id']=nullable(uid)
    schemas['QuoteInput']['required']=[]
    schemas['FulfillmentOptions']=obj({'capabilities':ref('FulfillmentCapabilities'),'groups':arr(obj({'source_id':uid,'source_name':text,'items':arr(obj({'product_id':uid,'quantity':number,'stock_id':uid})),'requirement':dimensions,'slots':arr(ref('DeliverySlot'))})),'common_windows':arr(arr(stamp))})
    location=obj({'id':uid,'name':text,'instructions':text,'preparation_minutes':number})
    schemas['FulfillmentAvailability']=obj({'store_id':uid,'capabilities':ref('FulfillmentCapabilities'),'methods':arr(obj({'type':text,'scheduling':boolean,'asap':boolean,'locations':arr(location)},['asap','locations']))})
    schemas['SaveFulfillmentCapabilities']=obj({'store_id':nullable(uid),'capabilities':ref('FulfillmentCapabilityOverrides'),'reason':text})
    schemas['FulfillmentBranchInput']=obj({'address':{'type':'string','minLength':1,'maxLength':500},'delivery_enabled':boolean,'pickup_enabled':boolean,'stock_id':uid},['stock_id'])
    schemas['FulfillmentStoreInput']=obj({'id':uid,'name':text,'reason':text,'branch':ref('FulfillmentBranchInput')},['branch'])
    source={'store_id':uid,'source_id':uid,'pickup_enabled':boolean,'pickup_instructions':text,'preparation_minutes':number}
    schemas['FulfillmentSourceInput']=obj({**source,'reason':text})
    schemas['FulfillmentSettingsView']=obj({'system':ref('FulfillmentCapabilityOverrides'),'stores':arr(obj({'id':uid,'name':text,'overrides':ref('FulfillmentCapabilityOverrides'),'resolved':ref('FulfillmentCapabilities')})),'locations':arr(obj({'id':uid,'name':text})),'sources':arr(obj(source))})
    schemas['FulfillmentStores']=arr(obj({'id':uid,'name':text,'is_default':boolean}))
    schemas['FulfillmentStoreChoice']=obj({'store_id':uid})
    schemas['Error']['properties']['capability']=text
    endpoint('/v1/fulfillment/availability','get','FulfillmentAvailability',auth='customerBearer')
    endpoint('/v1/fulfillment/plan-options','post','FulfillmentOptions','FulfillmentRequest',auth='customerBearer')
    endpoint('/v1/fulfillment/plans','post','FulfillmentPlan','FulfillmentSelection',auth='customerBearer')
    endpoint('/v1/fulfillment/plans/{id}','delete',auth='customerBearer')
    endpoint('/v1/fulfillment/stores','get','FulfillmentStores')
    endpoint('/v1/fulfillment/store','post',body='FulfillmentStoreChoice',auth='customerBearer')
    endpoint('/v1/admin/fulfillment/capabilities','get','FulfillmentSettingsView',auth='adminSession')
    endpoint('/v1/admin/fulfillment/capabilities','post',body='SaveFulfillmentCapabilities',auth='adminSession')
    endpoint('/v1/admin/fulfillment/stores','post',body='FulfillmentStoreInput',auth='adminSession')
    endpoint('/v1/admin/fulfillment/store-sources','post',body='FulfillmentSourceInput',auth='adminSession')
    endpoint('/v1/fulfillment/capabilities','get','FulfillmentCapabilities')

    schemas['CapacityConfiguration']['properties']['controls']=obj({k:boolean for k in ['capacity','scheduling','pickup','geofencing']})
    import copy
    schemas['FulfillmentLocation']=copy.deepcopy(schemas['Location'])
    schemas['FulfillmentLocation']['properties']['location_method']['enum'].append('pickup')
    for name in ['CheckoutSnapshot','Order']: schemas[name]['properties']['location']=ref('FulfillmentLocation')
    schemas['ShoppingContext']['properties']['fulfillment_capabilities']=ref('FulfillmentCapabilities')
    schemas['ShoppingContext']['properties']['fulfillment_availability_endpoint']=text

    schemas['ShoppingContext']['properties']['fulfillment_availability']=nullable(ref('FulfillmentAvailability'))

    schemas['CapacityConfiguration']['properties']['legacy_controls']=boolean
