"""M12 source inventory and shipment contracts."""
def extend(schemas, endpoint, obj, ref, arr, S, B, N, U, T, nullable):
    integer={'type':'integer'}
    source={'code':S(),'name':S(),'is_enabled':B(),'address':S(),'latitude':nullable(N()),'longitude':nullable(N()),'contact_name':S(),'contact_phone':S(),'priority':integer}
    schemas['InventorySourceInput']=obj(source)
    schemas['InventorySource']=obj({'id':U(),**source})
    schemas['SourceLink']=obj({'source_id':U(),'priority':integer})
    stock={'code':S(),'name':S(),'is_default':B(),'is_global':{**B(),'default':False,'description':'Expose available stock worldwide; delivery coverage is checked separately.'},'sources':arr(ref('SourceLink'))}
    schemas['StockPoolInput']=obj(stock)
    schemas['StockPoolInput']['required'].remove('is_global')
    schemas['StockPool']=obj({'id':U(),**stock})
    schemas['StockPoolSaved']=obj({'id':U()})
    item={'source_id':U(),'quantity':integer,'status':{'type':'string','enum':['in_stock','out_of_stock']},'notify_stock_qty':integer}
    schemas['SourceItemInput']=obj({**item,'reason':S()})
    schemas['SourceItem']=obj({**item,'name':S(),'product_id':U(),'reserved':integer,'is_assigned':{**B(),'description':'True when a persisted source assignment exists, including sold-out inventory.'}})
    for name,typ in [('sources','InventorySource'),('stocks','StockPool')]:
        path='/v1/admin/inventory/'+name
        endpoint(path,'get',typ,auth='adminSession',many=True)
        endpoint(path,'post',typ if name=='sources' else 'StockPoolSaved',typ+'Input',auth='adminSession')
        endpoint(path+'/{id}','put',typ if name=='sources' else 'StockPoolSaved',typ+'Input',auth='adminSession')
        endpoint(path+'/{id}','delete',auth='adminSession')
    endpoint('/v1/admin/inventory/{id}/sources','get','SourceItem',auth='adminSession',many=True)
    endpoint('/v1/admin/inventory/{id}/sources','put','Status','SourceItemInput',auth='adminSession')
    shipment=schemas['Shipment']['properties']
    shipment.update({'source_id':U(),'source_name':S(),'dispatched_by':nullable(U()),'dispatched_at':nullable(T()),'status':{'type':'string','enum':['pending','shipped','delivered','delivery_failed','cancelled']}})
    schemas['Shipment']=obj(shipment)
    schemas['OrderDetail']['properties']['shipments']=arr(ref('Dispatch'))
    schemas['OrderDetail']['required'].append('shipments')
    schemas['DispatchInput']['properties']['shipment_id']=U()
    endpoint('/v1/admin/shipments/{id}/status','post','OrderDetail','OrderTransition',auth='adminSession')
