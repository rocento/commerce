"""Commerce HTTP contract source. Regenerate JSON, then pnpm generate:api in frontend."""
import json
from pathlib import Path
S=lambda: {'type':'string'}
B=lambda: {'type':'boolean'}
N=lambda: {'type':'number'}
U=lambda: {'type':'string','format':'uuid'}
T=lambda: {'type':'string','format':'date-time'}
ref=lambda n: {'$ref':f'#/components/schemas/{n}'}
arr=lambda v: {'type':'array','items':v}
nullable=lambda v: {**v,'nullable':True}
def obj(props,optional=()): return {'type':'object','properties':props,'required':[k for k in props if k not in optional],'additionalProperties':False}
schemas={
 'Status':obj({'status':{'type':'string','enum':['ok']}}),
 'Error':obj({'error':S()}),
 'Credentials':obj({'identifier':S(),'password':S()}),
 'ChallengeRequest':obj({'identifier':S()}),
 'Verify':obj({'identifier':S(),'token':S()}),
 'Reset':obj({'identifier':S(),'token':S(),'password':S()}),
 'Customer':obj({'id':U(),'email':nullable(S()),'mobile_number':nullable(S()),'primary_identifier':{'type':'string','enum':['email','mobile']},'verified':B(),'created_at':T()}),
 'Auth':obj({'customer':ref('Customer'),'access_token':S()}),
 'AdminCredentials':obj({'email':S(),'password':S()}),
 'Admin':obj({'id':U(),'email':S(),'name':S(),'role_id':U(),'active':B(),'created_at':T()}),
 'Identity':obj({'user':ref('Admin'),'permissions':arr(S())}),
 'UserInput':obj({'email':S(),'name':S(),'role_id':U(),'active':B(),'password':S()},['password']),
 'RoleInput':obj({'name':S(),'permissions':arr(S())}),
 'Role':obj({'id':U(),'name':S(),'permissions':arr(S()),'system':B()}),
 'Audit':obj({'id':U(),'actor_id':nullable(U()),'action':S(),'entity_id':U(),'details':{'type':'object','additionalProperties':True},'created_at':T()}),
}
location={'label':{'type':'string','enum':['home','work','other']},'custom_label':S(),'latitude':{'type':'number','minimum':-90,'maximum':90},'longitude':{'type':'number','minimum':-180,'maximum':180},'formatted_address':S(),'building':S(),'floor':S(),'apartment':S(),'delivery_instructions':S(),'is_default':B()}
schemas['LocationInput']=obj(location,['custom_label','building','floor','apartment','delivery_instructions','is_default'])
schemas['Location']=obj({'id':U(),**location,'area_id':nullable(U()),'created_at':T(),'updated_at':T()})
schemas['LocationGeography']=nullable(obj({key:S() for key in ['country_code','state_code','state_name','city_id','city_name']}))
for name in ['LocationInput','Location']:
 schemas[name]['properties'].update({'location_method':{'type':'string','enum':['pin','neighborhood'],'description':'Whether coordinates describe an entrance pin or an approximate locality reference point.'},'geography':ref('LocationGeography')})
paths={}
def endpoint(path,method,output='Status',body=None,status=200,auth=None,many=False):
 schema=arr(ref(output)) if many else ref(output)
 op={'operationId':method+'_'+path.strip('/').replace('/','_').replace('{','').replace('}',''),'responses':{str(status):{'description':'Success','content':{'application/json':{'schema':schema}}},'default':{'description':'Request failed','content':{'application/json':{'schema':ref('Error')}}}}}
 if body:op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body)}}}
 parameters=[]
 if method not in ['get','head']:parameters.append({'in':'header','name':'X-Commerce-Request','required':True,'schema':{'type':'string','enum':['1']}})
 if '{id}' in path:parameters.append({'in':'path','name':'id','required':True,'schema':U()})
 if parameters:op['parameters']=parameters
 if auth:op['security']=[{auth:[]}]
 paths.setdefault(path,{})[method]=op
for suffix,body,out,status in [('register','Credentials','Customer',201),('login','Credentials','Auth',200),('refresh',None,'Auth',200),('logout',None,'Status',200),('request-verification','ChallengeRequest','Status',200),('verify','Verify','Status',200),('forgot-password','ChallengeRequest','Status',200),('reset-password','Reset','Status',200)]:endpoint('/v1/customer/auth/'+suffix,'post',out,body,status,auth='customerRefresh' if suffix in ['refresh','logout'] else None)
paths['/v1/customer/auth/refresh']['post']['responses']['204']={'description':'No customer refresh cookie is present; the visitor is signed out. No credentials are issued.'}
paths['/v1/customer/auth/refresh']['post']['security'].append({})
endpoint('/v1/customer/me','get','Customer',auth='customerBearer')
schemas['CustomerPushRegistration']=obj({'customer_id':U(),'platform':{'type':'string','enum':['ios','android']},'app_id':S(),'token':{'type':'string','minLength':32,'maxLength':4096},'locale':{'type':'string','enum':['en','ar']}})
endpoint('/v1/customer/push-devices/{id}','put','Status','CustomerPushRegistration',auth='customerBearer')
endpoint('/v1/customer/push-devices/{id}','delete',auth='customerBearer')
paths['/v1/customer/push-devices/{id}']['put']['description']='Opt in this installation to order pushes. Requires configured APNs/FCM and matching app ID. customer_id must match the signed-in account; the registration is bound to its session. Refresh on foreground and provider token changes. No token is returned.'
paths['/v1/customer/push-devices/{id}']['delete']['description']='Revoke only the signed-in customer’s installation and discard its queued pushes. Idempotent, including when delivery is unconfigured.'

endpoint('/v1/customer/checkout-eligibility','get',auth='customerBearer')
endpoint('/v1/customer/locations','get','Location',auth='customerBearer',many=True)
endpoint('/v1/customer/locations','post','Location','LocationInput',201,'customerBearer')
endpoint('/v1/customer/locations/{id}','put','Location','LocationInput',auth='customerBearer')
endpoint('/v1/customer/locations/{id}','delete',auth='customerBearer')
endpoint('/v1/admin/auth/login','post','Identity','AdminCredentials')
endpoint('/v1/admin/auth/logout','post',auth='adminSession')
endpoint('/v1/admin/me','get','Identity',auth='adminSession')
for name,typ,inp in [('users','Admin','UserInput'),('roles','Role','RoleInput')]:
 endpoint('/v1/admin/'+name,'get',typ,auth='adminSession',many=True)
 endpoint('/v1/admin/'+name,'post',typ,inp,201,'adminSession')
 endpoint('/v1/admin/'+name+'/{id}','put',typ,inp,auth='adminSession')
 endpoint('/v1/admin/'+name+'/{id}','delete',auth='adminSession')
endpoint('/v1/admin/audit','get','Audit',auth='adminSession',many=True)
for path,method in [
 ('/v1/customer/auth/register','post'),('/v1/customer/auth/login','post'),
 ('/v1/customer/auth/reset-password','post'),('/v1/admin/auth/login','post'),
 ('/v1/admin/users','post'),('/v1/admin/users/{id}','put'),
]:
 paths[path][method]['responses']['503']={
  'description':'Password hashing capacity is temporarily exhausted; retry after the indicated delay.',
  'headers':{'Retry-After':{'description':'Retry delay in seconds.','schema':{'type':'integer','enum':[3]}}},
  'content':{'application/json':{'schema':ref('Error')}},
 }
category={'name':S(),'slug':S(),'parent_id':nullable(U())}
attribute={'code':S(),'name':S(),'kind':{'type':'string','enum':['text','number','boolean']},'required':B()}
product={'sku':S(),'slug':S(),'name':S(),'description':S(),'price':{'type':'string','pattern':r'^\d+(\.\d{1,2})?$'},'currency':{'type':'string','enum':['USD']},'unit':{'type':'string','enum':['each','lb','kg','oz','pack','L']},'category_id':U(),'attributes':{'type':'object','additionalProperties':True},'media_ids':arr(U()),'active':B(),'in_stock':B()}
for name,fields in [('Category',category),('Attribute',attribute),('Product',product)]:
 schemas[name+'Input']=obj(fields)
 schemas[name]=obj({'id':U(),**fields,**({'updated_at':T()} if name=='Product' else {})})
schemas['Category']['properties'].update({'thumbnail':nullable(S()),'banner':nullable(S())})
schemas['Category']['required'].extend(['thumbnail','banner'])
schemas['CatalogImageVariant']=obj({'width':{'type':'integer','minimum':1},'height':{'type':'integer','minimum':1}})
schemas['CatalogImage']=obj({'id':U(),'alt':S(),'width':{'type':'integer','minimum':1},'height':{'type':'integer','minimum':1},'variants':arr(ref('CatalogImageVariant'))})
for name in ['Category','Product']:
 schemas[name]['properties']['images']={'type':'object','additionalProperties':ref('CatalogImage'),'description':'Dimensions and available WebP renditions for media referenced by this shopper projection. Missing entries retain the original image.'}
schemas['Media']=obj({'id':U(),'content_type':S(),'alt':S(),'object_key':S(),'size_bytes':N()})
schemas['MediaInput']=obj({'alt':S()})
schemas['SearchResults']=obj({'hits':arr(ref('Product')),'total':N(),'offset':N(),'limit':N()})
schemas['AnalyticsEvent']=obj({'id':U(),'session_id':U(),'event_type':{'type':'string','enum':['page_view','search_query']},'path':S(),'query':S(),'result_count':N()},['query','result_count'])
endpoint('/v1/catalog/categories','get','Category',many=True)
schemas['CategoryAvailability']={'type':'object','additionalProperties':{'type':'integer','minimum':0}}
endpoint('/v1/catalog/category-availability','get','CategoryAvailability')
endpoint('/v1/catalog/products/{id}','get','Product')
schemas['BestsellerPeriod']={'type':'string','enum':['today','last_week','last_month','last_year']}
schemas['BestsellerResults']=obj({'products':arr(ref('Product')),'period':ref('BestsellerPeriod'),'start':T(),'end':T(),'timezone':{'type':'string','enum':['UTC']},'metric':{'type':'string','enum':['completed_order_units']},'ranked_limit':{'type':'integer'},'scope':{'type':'string','enum':['delivery_area','global'],'description':'Ranks sales in the selected delivery area when available; otherwise uses store-wide completed sales.'}})
endpoint('/v1/catalog/bestsellers','get','BestsellerResults')
paths['/v1/catalog/bestsellers']['get']['parameters']=[{'in':'query','name':'period','schema':ref('BestsellerPeriod')},{'in':'query','name':'limit','schema':{'type':'integer','minimum':1,'maximum':24,'default':8}}]

endpoint('/v1/catalog/media/{id}','get','Media')
endpoint('/v1/catalog/media/{id}/content','get','Media')
paths['/v1/catalog/media/{id}/content']['get']['responses']['200']['content']={'image/png':{'schema':{'type':'string','format':'binary'}},'image/jpeg':{'schema':{'type':'string','format':'binary'}},'image/webp':{'schema':{'type':'string','format':'binary'}}}
endpoint('/v1/search','get','SearchResults')
for name in ['Product', 'ProductInput']:
 schemas[name]['properties']['category_ids']={**arr(U()),'maxItems':50,'description':'Assigned categories, including the primary category. Omit on updates to preserve assignments.'}
paths['/v1/search']['get']['parameters']=[{'in':'query','name':name,'schema':schema} for name,schema in [('q',S()),('category_id',U()),('category_ids',{'type':'string','maxLength':1850,'description':'Comma-separated category UUIDs, at most 50. Matches any selected category; combines with other filters.'}),('min_price',S()),('max_price',S()),('in_stock',B()),('offset',{'type':'integer','minimum':0,'maximum':9999})]]
for name,typ in [('products','Product'),('categories','Category'),('attributes','Attribute')]:
 endpoint('/v1/admin/catalog/'+name,'get',typ,auth='adminSession',many=True)
 endpoint('/v1/admin/catalog/'+name,'post',typ,typ+'Input',201,'adminSession')
 endpoint('/v1/admin/catalog/'+name+'/{id}','put',typ,typ+'Input',auth='adminSession')
 endpoint('/v1/admin/catalog/'+name+'/{id}','delete',auth='adminSession')
paths['/v1/admin/catalog/products']['get']['parameters']=[{'in':'query','name':'offset','schema':{'type':'integer','minimum':0}}]
schemas['CatalogOffer'] = obj({'product_id':U(),'currency':S(),'original_price':S(),'discounted_price':S(),'savings':S(),'discount_percent':S()})
schemas['Product']['properties']['catalog_offer'] = ref('CatalogOffer')
endpoint('/v1/admin/catalog/products/{id}','get','Product',auth='adminSession')
endpoint('/v1/admin/catalog/media','get','Media',auth='adminSession',many=True)
endpoint('/v1/admin/catalog/media','post','Media',status=201,auth='adminSession')
paths['/v1/admin/catalog/media']['post']['requestBody']={'required':True,'content':{'multipart/form-data':{'schema':obj({'file':{'type':'string','format':'binary'},'alt':S()})}}}
endpoint('/v1/admin/catalog/media/{id}','put','Media','MediaInput',auth='adminSession')
endpoint('/v1/admin/catalog/media/{id}','delete',auth='adminSession')
folder_input={'name':{'type':'string','minLength':1,'maxLength':100},'parent_id':nullable(U())}
schemas['MediaFolderInput']=obj(folder_input)
schemas['MediaFolder']=obj({'id':U(),**folder_input,'media_count':{'type':'integer','minimum':0}})
schemas['LibraryMedia']=obj({**schemas['Media']['properties'],'folder_id':nullable(U()),'file_name':S()})
schemas['MediaLibraryPage']=obj({'items':arr(ref('LibraryMedia')),'total':{'type':'integer'},'offset':{'type':'integer'},'limit':{'type':'integer'}})
schemas['MoveMediaInput']=obj({'ids':{'type':'array','items':U(),'minItems':1,'maxItems':500},'folder_id':nullable(U())})
endpoint('/v1/admin/catalog/media/folders','get','MediaFolder',auth='adminSession',many=True)
endpoint('/v1/admin/catalog/media/folders','post','MediaFolder','MediaFolderInput',201,'adminSession')
endpoint('/v1/admin/catalog/media/folders/{id}','put','MediaFolder','MediaFolderInput',auth='adminSession')
endpoint('/v1/admin/catalog/media/folders/{id}','delete',auth='adminSession')
endpoint('/v1/admin/catalog/media/library','get','MediaLibraryPage',auth='adminSession')
paths['/v1/admin/catalog/media/library']['get']['parameters']=[{'in':'query','name':name,'schema':schema} for name,schema in [('folder',S()),('q',{'type':'string','maxLength':200}),('offset',{'type':'integer','minimum':0}),('limit',{'type':'integer','minimum':1,'maximum':100})]]
endpoint('/v1/admin/catalog/media/move','post','Status','MoveMediaInput',auth='adminSession')
paths['/v1/admin/catalog/media']['post']['requestBody']['content']['multipart/form-data']['schema']['properties']['folder_id']=U()

endpoint('/v1/analytics/events','post',body='AnalyticsEvent',status=201)
paths['/v1/analytics/events']['post']['responses']['202']={'description':'Durably queued in the isolated engagement database for asynchronous journey and ClickHouse processing. Does not mean ClickHouse ingestion has completed.','content':{'application/json':{'schema':obj({'status':{'type':'string','enum':['queued']}})}}}
schemas['InventorySummary']=obj({'product_id':U(),'sku':S(),'name':S(),'stock':ref('Stock')})
schemas['Stock']=obj({'product_id':U(),'on_hand':N(),'reserved':N(),'available':N()})
schemas['Reservation']=obj({'cart_id':U(),'product_id':U(),'quantity':N(),'expires_at':T()})
schemas['StockAdjustment']=obj({'id':U(),'product_id':U(),'actor_id':U(),'before_quantity':N(),'after_quantity':N(),'reason':S(),'created_at':T()})
schemas['InventoryDetail']=obj({'product':ref('Product'),'stock':ref('Stock'),'reservations':arr(ref('Reservation')),'adjustments':arr(ref('StockAdjustment'))})
schemas['AdjustStock']=obj({'on_hand':{'type':'integer','minimum':0,'maximum':1000000},'reason':S()})
schemas['CartItem']=obj({'product_id':U(),'sku':S(),'name':S(),'unit':S(),'price':S(),'currency':S(),'quantity':N(),'reserved_quantity':N(),'available':N(),'expires_at':nullable(T()),'line_total':S()})
schemas['Cart']=obj({'id':U(),'customer_id':nullable(U()),'items':arr(ref('CartItem')),'subtotal':S(),'currency':S(),'fully_reserved':B()})

schemas['AppliedDiscount']=obj({'rule_id':U(),'name':S(),'scope':S(),'kind':S(),'value':S(),'coupon_code':nullable(S()),'amount':S()})
discounts={'discount_amount':S(),'discount_snapshot':arr(ref('AppliedDiscount')),'coupon_code':nullable(S())}
schemas['Cart']['properties'].update({**discounts,'coupon_error':nullable(S())})
schemas['Cart']['required']+=list(discounts)+['coupon_error']
schemas['CouponInput']=obj({'code':S()})
endpoint('/v1/cart/coupon','put','Cart','CouponInput')
schemas['CartAdd']=obj({'product_id':U(),'quantity':{'type':'integer','minimum':1,'maximum':1000000}})
schemas['CartQuantity']=obj({'quantity':{'type':'integer','minimum':1,'maximum':1000000}})
endpoint('/v1/cart','post','Cart')
endpoint('/v1/cart/items','post','Cart','CartAdd')
endpoint('/v1/cart/items/{id}','put','Cart','CartQuantity')
endpoint('/v1/cart/items/{id}','delete','Cart')
endpoint('/v1/inventory/{id}','get','Stock')
endpoint('/v1/admin/inventory','get','InventorySummary',auth='adminSession',many=True)
paths['/v1/admin/inventory']['get']['parameters']=[{'in':'query','name':'offset','schema':{'type':'integer','minimum':0}}]
endpoint('/v1/admin/inventory/{id}','get','InventoryDetail',auth='adminSession')
endpoint('/v1/admin/inventory/{id}','put','Stock','AdjustStock',auth='adminSession')
schemas['WarehouseQuantity']=obj({'source_id':U(),'source':S(),'on_hand':N(),'saleable':N()})
schemas['ReplenishmentPolicyInput']=obj({'supplier':S(),'planning_group':S(),'lead_time_days':N(),'target_cover_days':N(),'safety_stock_days':N(),'minimum_order_qty':N(),'order_multiple':N(),'enabled':B()})
schemas['ReplenishmentRecommendation']=obj({'product_id':U(),'sku':S(),'product':S(),'image_id':nullable(U()),'supplier':S(),'planning_group':S(),'on_hand':N(),'reserved':N(),'saleable_qty':N(),'is_in_stock':B(),'sales_velocity':N(),'sells_out_in_days':nullable(N()),'days_of_stock':nullable(N()),'replenishment_qty':N(),'replenishment_in_days':nullable(N()),'recommended_date':nullable(T()),'overstock_qty':N(),'last_sold_at':nullable(T()),'sales_7_days':N(),'sales_30_days':N(),'sales_90_days':N(),'total_sales':N(),'lead_time_days':N(),'target_cover_days':N(),'safety_stock_days':N(),'minimum_order_qty':N(),'order_multiple':N(),'enabled':B(),'warehouse_quantities':arr(ref('WarehouseQuantity'))})
schemas['ReplenishmentRefresh']=obj({'refreshed_at':T()})
endpoint('/v1/admin/replenishment','get','ReplenishmentRecommendation',auth='adminSession',many=True)
endpoint('/v1/admin/replenishment/{id}','put','ReplenishmentRecommendation','ReplenishmentPolicyInput',auth='adminSession')
endpoint('/v1/admin/replenishment/refresh','post','ReplenishmentRefresh',auth='adminSession')

state={'type':'string','enum':['placed','confirmed','fulfilling','shipped','delivered','cash_collected','cancelled','delivery_failed']}
money=S()
schemas['OrderItem']=obj({'product_id':U(),'sku':S(),'name':S(),'unit':S(),'quantity':{'type':'integer'},'price':money,'line_total':money,'discount_amount':money,'discount_snapshot':arr(ref('AppliedDiscount'))})
# Opaque immutable metadata supplied by the concurrent market extension.
schemas['OrderItem']['properties']['market_facts']=nullable({'type':'object','additionalProperties':True})
schemas['OrderContact']=obj({'email':nullable(S()),'mobile_number':nullable(S()),'primary_identifier':S()})
schemas['TaxAssessment']=obj({'rule_id':nullable(U()),'name':S(),'rate_bps':{'type':'integer'},'tax_delivery':B(),'taxable_base':money,'amount':money})
totals={**discounts,'subtotal':money,'delivery_fee':money,'tax_amount':money,'tax_snapshot':ref('TaxAssessment'),'total':money,'currency':S()}
schemas['CheckoutSnapshot']=obj({'items':arr(ref('OrderItem')),'location':ref('Location'),'contact':ref('OrderContact'),**totals,'payment_method':{'type':'string','enum':['cod']}})
schemas['CheckoutQuote']=obj({'id':U(),'expires_at':T(),'snapshot':ref('CheckoutSnapshot')})
schemas['QuoteInput']=obj({'location_id':U()})
schemas['PlaceInput']=obj({'quote_id':U(),'idempotency_key':U()})
schemas['Order']=obj({'id':U(),'number':{'type':'integer'},'customer_id':U(),'quote_id':U(),'idempotency_key':U(),'status':state,'location':ref('Location'),'contact':ref('OrderContact'),**totals,'created_at':T(),'updated_at':T()})
schemas['OrderHistory']=obj({'id':U(),'order_id':U(),'status':state,'actor_id':nullable(U()),'reason':S(),'created_at':T()})
schemas['Payment']=obj({'order_id':U(),'method':S(),'amount_due':money,'currency':S(),'collected_at':nullable(T()),'collected_by':nullable(U())})
schemas['ManualRefund']=obj({'id':U(),'order_id':U(),'amount':money,'reason':S(),'actor_id':U(),'created_at':T()})
schemas['OrderDetail']=obj({'order':ref('Order'),'items':arr(ref('OrderItem')),'history':arr(ref('OrderHistory')),'payment':ref('Payment'),'refunds':arr(ref('ManualRefund')),'dispatch':nullable(ref('Dispatch'))})
schemas['OrderSales']=obj({'order':ref('Order'),'items':arr(ref('OrderItem'))})
schemas['OrderTransition']=obj({'status':state,'reason':S()})
schemas['OrderReason']=obj({'reason':S()})
endpoint('/v1/customer/checkout/quote','post','CheckoutQuote','QuoteInput',auth='customerBearer')
endpoint('/v1/customer/checkout/place','post','OrderDetail','PlaceInput',auth='customerBearer')
for who,auth in [('customer','customerBearer'),('admin','adminSession')]:
 endpoint('/v1/'+who+'/orders','get','Order',auth=auth,many=True)
 paths['/v1/'+who+'/orders']['get']['parameters']=[{'in':'query','name':'offset','schema':{'type':'integer','minimum':0}}]
 endpoint('/v1/'+who+'/orders/{id}','get','OrderDetail',auth=auth)
endpoint('/v1/admin/orders/{id}/status','post','OrderDetail','OrderTransition',auth='adminSession')
endpoint('/v1/admin/orders/sales','get','OrderSales',auth='adminSession',many=True)
paths['/v1/admin/orders/sales']['get']['parameters']=[{'in':'query','name':'offset','schema':{'type':'integer','minimum':0,'maximum':1000000}}]
endpoint('/v1/admin/orders/{id}/refund','post','OrderDetail','OrderReason',auth='adminSession')

schemas['Shipment']=obj({'id':U(),'order_id':U(),'tracking_reference':S(),'status':{'type':'string','enum':['shipped','delivered','delivery_failed']},'dispatched_by':U(),'dispatched_at':T(),'updated_at':T()})
schemas['ShipmentItem']=obj({'product_id':U(),'quantity':{'type':'integer'}})
schemas['Dispatch']=obj({'shipment':ref('Shipment'),'items':arr(ref('ShipmentItem'))})
schemas['DispatchInput']=obj({'tracking_reference':S(),'reason':S()})
schemas['DeliveryFee']=obj({'amount':money,'currency':S(),'updated_at':T()})
schemas['DeliveryFeeInput']=obj({'amount':money,'reason':S()})
rule={'name':S(),'min_lat':N(),'max_lat':N(),'min_lon':N(),'max_lon':N(),'rate_bps':{'type':'integer','minimum':0,'maximum':10000},'tax_delivery':B(),'priority':{'type':'integer','minimum':0,'maximum':10000},'active':B()}
schemas['TaxRuleInput']=obj(rule)
schemas['TaxRule']=obj({'id':U(),**rule,'updated_at':T()})
endpoint('/v1/admin/orders/{id}/dispatch','post','OrderDetail','DispatchInput',auth='adminSession')
endpoint('/v1/admin/settings/delivery-fee','get','DeliveryFee',auth='adminSession')
endpoint('/v1/admin/settings/delivery-fee','put','DeliveryFee','DeliveryFeeInput',auth='adminSession')
fee_rule_scope={'area_id':nullable(U()),'country_code':S(),'state_code':S(),'city_id':S(),'location_name':S(),'source_id':nullable(U())}
schemas['DeliveryFeeRule']=obj({'id':U(),**fee_rule_scope,'amount':money})
schemas['DeliveryFeeRuleInput']=obj({**fee_rule_scope,'amount':nullable(money),'reason':S()})
schemas['DeliveryFeeChoices']=obj({'areas':arr(obj({'id':U(),'name':S()})),'sources':arr(obj({'id':U(),'name':S()}))})
endpoint('/v1/admin/settings/delivery-fee-rules','get','DeliveryFeeRule',auth='adminSession',many=True)
schemas['DeliveryFeeRuleSaved']=obj({'ok':B()})
endpoint('/v1/admin/settings/delivery-fee-rules','put','DeliveryFeeRuleSaved','DeliveryFeeRuleInput',auth='adminSession')
endpoint('/v1/admin/settings/delivery-fee-choices','get','DeliveryFeeChoices',auth='adminSession')

endpoint('/v1/admin/tax/rules','get','TaxRule',auth='adminSession',many=True)
endpoint('/v1/admin/tax/rules','post','TaxRule','TaxRuleInput',auth='adminSession')
endpoint('/v1/admin/tax/rules/{id}','put','TaxRule','TaxRuleInput',auth='adminSession')

promotion={'name':S(),'scope':{'type':'string','enum':['catalog','cart']},'kind':{'type':'string','enum':['percentage','fixed']},'value':S(),'coupon_code':nullable(S()),'min_subtotal':S(),'skus':arr(S()),'category_ids':arr(U()),'customer_group':{'type':'string','enum':['all','guest','registered','verified']},'priority':{'type':'integer','minimum':0,'maximum':10000},'active':B(),'starts_at':nullable(T()),'ends_at':nullable(T())}
schemas['PromotionInput']=obj(promotion)
schemas['Promotion']=obj({'id':U(),**promotion,'updated_at':T()})
endpoint('/v1/admin/promotions','get','Promotion',auth='adminSession',many=True)
endpoint('/v1/admin/promotions','post','Promotion','PromotionInput',auth='adminSession')
endpoint('/v1/admin/promotions/{id}','put','Promotion','PromotionInput',auth='adminSession')
endpoint('/v1/admin/promotions/{id}','delete',auth='adminSession')
from merchant_contract import extend as extend_merchant
extend_merchant(schemas, endpoint, paths)
from assistant_settings_contract import extend as extend_assistant_settings
extend_assistant_settings(schemas, endpoint, paths)
from assistant_tracking_contract import extend as extend_assistant_tracking
extend_assistant_tracking(schemas, endpoint, paths)
from discoverability_contract import extend as extend_discoverability
extend_discoverability(schemas, endpoint, paths)
from assistant_contract import extend
extend(schemas, endpoint, paths)
from m7_contract import extend as extend_m7
extend_m7(schemas, endpoint, paths)
from reporting_contract import extend as extend_reporting
extend_reporting(schemas, endpoint, paths)
from msi_contract import extend as extend_msi
extend_msi(schemas, endpoint, obj, ref, arr, S, B, N, U, T, nullable)
from m11_contract import extend as extend_m11
extend_m11(schemas, endpoint, paths)
from m13_contract import extend as extend_m13
extend_m13(schemas, endpoint, paths, obj, ref, arr, S, B, N, U, nullable)
from theme_contract import extend as extend_theme
extend_theme(schemas, endpoint, paths)
from mobile_contract import extend as extend_mobile
extend_mobile(schemas, endpoint, paths)
from segments_contract import extend as extend_segments
extend_segments(schemas, endpoint, paths)
schemas['Readiness']=obj({'status':{'type':'string','enum':['ready','unavailable']},'dependencies':obj({'database':{'type':'string','enum':['ready','unavailable']},'workers':{'type':'string','enum':['running','not_configured','unavailable']}})})
endpoint('/ready','get','Readiness')
paths['/ready']['get']['responses']['503']={'description':'Not ready','content':{'application/json':{'schema':ref('Readiness')}}}
schemas['AssistantReport']=obj({'configured':B(),'window_hours':{'type':'integer'},'evaluated_at':T(),**{key:{'type':'integer','minimum':0} for key in ['total','completed','unavailable','disconnected']},'average_latency_ms':nullable(N())})
endpoint('/v1/admin/reports/assistant','get','AssistantReport',auth='adminSession')
from catalog_schema_contract import extend as extend_catalog_schema
extend_catalog_schema(schemas,endpoint,paths)
from shopping_contract import extend as extend_shopping
extend_shopping(schemas,endpoint,paths)
from customer_journey_contract import extend as extend_customer_journey
extend_customer_journey(schemas,endpoint,paths)
from discovery_contract import extend as extend_discovery
extend_discovery(schemas, endpoint, paths)
from memory_contract import extend as extend_memory
extend_memory(schemas, endpoint, paths)
from capacity_contract import extend as extend_capacity
extend_capacity(schemas, endpoint, paths)
from trust_contract import extend as extend_trust
extend_trust(schemas, endpoint, paths)
from market_contract import extend as extend_market
extend_market(schemas, endpoint, paths)
from market_publication_contract import extend as extend_market_publication
extend_market_publication(schemas, endpoint, paths)
from languages_contract import extend as extend_languages
extend_languages(schemas, endpoint, paths)
from entity_id_contract import extend as extend_entity_id
extend_entity_id(schemas, paths)
from operational_contract import extend as extend_operational
extend_operational(schemas, endpoint, paths)
from publication_snapshot_contract import extend as extend_publication_snapshot
extend_publication_snapshot(schemas, endpoint, paths)
from api_reference_contract import extend as extend_api_reference
extend_api_reference(schemas, endpoint, paths)
from order_statuses_contract import extend as extend_order_statuses
extend_order_statuses(schemas, endpoint, paths)
from email_templates_contract import extend as extend_email_templates
extend_email_templates(schemas, endpoint, paths)
from marketing_notifications_contract import extend as extend_marketing_notifications
extend_marketing_notifications(schemas, endpoint, paths)
from storefront_notifications_contract import extend as extend_storefront_notifications
extend_storefront_notifications(schemas, endpoint, paths)
from relationships_contract import extend as extend_relationships
extend_relationships(schemas, endpoint, paths)
from account_deletion_contract import extend as extend_account_deletion
extend_account_deletion(schemas, endpoint, paths)
from admission_contract import extend as extend_admission
extend_admission(paths)
# Catalog reads are anonymous by default, but credentials personalize offers.
for path in ['/v1/catalog/categories','/v1/catalog/products/{id}','/v1/catalog/products/{id}/family','/v1/catalog/bestsellers','/v1/search']:
 operation=paths[path]['get']
 operation.setdefault('parameters',[]).append({'name':'X-Storefront-Locale','in':'header','schema':{'type':'string'},'description':'Configured locale returned by GET /v1/languages (for example en or ar). Only reviewed translations whose source is current are applied. Omitted, unknown or unavailable translations fall back to source text; prices and identifiers do not change.'})
 if path != '/v1/catalog/categories':
  operation['security']=[{'customerBearer':[]},{}]
  operation['description']='Anonymous requests receive public offers. A valid customer bearer token enables eligible customer-specific offers; a supplied invalid or expired token returns 401 rather than silently falling back to anonymous pricing.'
  operation['responses']['401']={'description':'Supplied customer bearer token is invalid or expired. Omit credentials for an anonymous catalog read.','content':{'application/json':{'schema':ref('Error')}}}
contract={'openapi':'3.0.3','info':{'title':'Commerce API','version':'0.8.0'},'servers':[{'url':'/api'}],'paths':paths,'components':{'schemas':schemas,'securitySchemes':{'customerBearer':{'type':'http','scheme':'bearer','bearerFormat':'JWT'},'customerRefresh':{'type':'apiKey','in':'cookie','name':'customer_refresh'},'adminSession':{'type':'apiKey','in':'cookie','name':'admin_session'}}}}
contract['components']['securitySchemes']['mobileAppSession']={'type':'http','scheme':'bearer','description':'Short-lived opaque app enrollment session, bound server-side to merchant/environment/platform; never embed an API secret in a binary.'}
contract['components']['securitySchemes']['agentProof']={'type':'http','scheme':'bearer','bearerFormat':'RS256 request proof'}
contract['components']['securitySchemes']['inboxGuest']={'type':'apiKey','in':'cookie','name':'inbox_guest'}
contract['components']['securitySchemes']['assistantCapability']={'type':'http','scheme':'bearer','bearerFormat':'Delegated JWT','description':'Internal assistant capability minted by the gateway for an exact tenant, customer, request and tool scope. Customer access tokens are not accepted here.'}
from contract_checks import normalize_nullable, validate_paths
contract=normalize_nullable(contract)
validate_paths(contract)
Path(__file__).resolve().parents[3].joinpath('openapi.json').write_text(json.dumps(contract,indent=2)+'\n')
