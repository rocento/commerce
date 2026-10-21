"""Delivery zones and implicit pin headers for M13."""
def extend(schemas, endpoint, paths, obj, ref, arr, S, B, N, U, nullable):
    integer={'type':'integer'}
    schemas['AreaStockLink']=obj({'stock_id':U(),'priority':integer})
    area={'name':S(),'center_lat':N(),'center_lng':N(),'radius_km':N(),'priority':integer,'is_active':B(),'stocks':arr(ref('AreaStockLink'))}
    schemas['DeliveryAreaInput']=obj(area)
    schemas['DeliveryArea']=obj({'id':U(),**area})
    schemas['DeliveryStatus']=obj({'configured':B(),'deliverable':B(),'area_id':nullable(U())})
    endpoint('/v1/delivery-area','get','DeliveryStatus')
    endpoint('/v1/admin/inventory/delivery-areas','get','DeliveryArea',auth='adminSession',many=True)
    endpoint('/v1/admin/inventory/delivery-areas','post','StockPoolSaved','DeliveryAreaInput',auth='adminSession')
    endpoint('/v1/admin/inventory/delivery-areas/{id}','put','StockPoolSaved','DeliveryAreaInput',auth='adminSession')
    for path,operations in paths.items():
        if path.startswith(('/v1/catalog/','/v1/search','/v1/inventory/','/v1/cart','/v1/delivery-area')):
            for op in operations.values():
                if not isinstance(op,dict): continue
                op.setdefault('parameters',[]).extend([{'name':name,'in':'header','required':False,'schema':schema} for name,schema in [('x-delivery-context',S()),('x-delivery-latitude',N()),('x-delivery-longitude',N())]])
