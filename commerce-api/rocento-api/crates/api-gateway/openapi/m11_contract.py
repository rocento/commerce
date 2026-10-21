"""M11 additive attribute, family, profile and order contracts."""
def extend(s,e,paths):
 S=lambda:{'type':'string'}
 U=lambda:{'type':'string','format':'uuid'}
 I=lambda:{'type':'integer'}
 B=lambda:{'type':'boolean'}
 R=lambda n:{'$ref':'#/components/schemas/'+n}
 A=lambda x:{'type':'array','items':x}
 null=lambda x:{**x,'nullable':True}
 obj=lambda p,optional=():{'type':'object','properties':p,'required':[k for k in p if k not in optional],'additionalProperties':False}
 enum=lambda *v:{'type':'string','enum':list(v)}
 values={'type':'object','additionalProperties':True}
 flags=['is_required','is_unique','is_searchable','is_filterable','is_comparable','is_visible_on_front','used_for_promo_rules','used_for_configurations']
 s['AttributeDefinition']=obj({'id':U(),'entity_type':enum('product','customer','category'),'attribute_code':S(),'label':S(),'input_type':enum('text','textarea','boolean','select','multiselect','price','date','media_image'),'scope':enum('global'),**{f:B() for f in flags},'swatch_type':enum('none','text','color'),'options':A(obj({'value':S(),'label':S()})),'version':I()})
 s['AttributeSetMember']=obj({'definition_id':U(),'group_name':S(),'position':I()})
 s['AttributeSet']=obj({'id':U(),'name':S(),'description':S(),'version':I(),'members':A(R('AttributeSetMember'))})
 s['Product']['properties'].update({'product_type':enum('simple','configurable','grouped','bundle'),'parent_id':null(U()),'variant_attributes':values,'attribute_set_id':null(U())})
 s['Product']['required']+=['product_type','parent_id','variant_attributes','attribute_set_id']
 s['ProductInput']['properties']['attribute_set_id']=null(U())
 s['ProductInput']['required'].append('attribute_set_id')
 s['ProductLink']=obj({'child_id':U(),'option_label':S(),'quantity':I()})
 s['ProductStructure']=obj({'product_type':enum('simple','configurable','grouped','bundle'),'configurable_attributes':A(S()),'children':A(R('ProductLink'))})
 s['ProductFamily']=obj({'structure':R('ProductStructure'),'children':A(R('Product'))})
 profile={'first_name':S(),'last_name':S(),'date_of_birth':null({'type':'string','format':'date'}),'gender':enum('','female','male','other','prefer_not_to_say'),'attributes':values}
 s['ProfileInput']=obj(profile)
 s['ProfileInput']['required'].remove('date_of_birth')
 for key in ['first_name','last_name']:
  s['ProfileInput']['properties'][key]={'type':'string','maxLength':120,'description':'At most 120 UTF-8 bytes before trimming. Empty names are permitted; multibyte text can reach the byte limit before 120 characters.'}
 s['ProfileInput']['properties']['date_of_birth']={**profile['date_of_birth'],'description':'ISO calendar date YYYY-MM-DD from 1900-01-01 through the current UTC date, or null. Omission also clears the date.'}
 s['CustomerProfile']=obj({**profile,'customer_group':S(),'company_id':null(U()),'negotiated_price_list_id':null(U())})
 s['AdminCustomerProfile']=obj({**s['CustomerProfile']['properties'],'account':R('Customer'),'locations':A(R('Location'))})
 s['AttributeValues']=values
 s['BundleSelection']=obj({'selected':A(U())})
 s['OrderExtensions']=obj({'state':enum('new','processing','complete','canceled','holded'),'delivery_location_snapshot':R('Location'),'gift_message':null(S())})
 s['OrderComment']=obj({'id':U(),'order_id':U(),'admin_id':U(),'body':S(),'created_at':S()})
 s['CommentInput']=obj({'body':S()})
 for name in ['QuoteInput','CheckoutSnapshot','Order']:s[name]['properties']['gift_message']=null(S())
 for p,out,auth in [('/v1/catalog/attribute-definitions','AttributeDefinition',None),('/v1/admin/attribute-definitions','AttributeDefinition','adminSession'),('/v1/customer/attribute-definitions','AttributeDefinition','customerBearer')]:e(p,'get',out,auth=auth,many=True)
 for p in ['/v1/catalog/attribute-definitions','/v1/customer/attribute-definitions']:paths[p]['get']['parameters']=[{'name':'locale','in':'query','required':False,'schema':{'type':'string'},'description':'Configured language for reviewed labels; missing translations use source labels.'}]
 paths['/v1/admin/attribute-definitions']['get']['parameters']=[{'in':'query','name':'entity_type','required':True,'schema':enum('product','category','customer')}]
 e('/v1/admin/attribute-definitions','post','AttributeDefinition','AttributeDefinition',auth='adminSession')
 e('/v1/admin/attribute-definitions/{id}','delete',auth='adminSession')
 e('/v1/admin/attribute-sets','get','AttributeSet',auth='adminSession',many=True)
 e('/v1/admin/attribute-sets','post','AttributeSet','AttributeSet',auth='adminSession')
 e('/v1/admin/attribute-sets/{id}','delete',auth='adminSession')
 e('/v1/catalog/products/{id}/family','get','ProductFamily')
 e('/v1/admin/catalog/products/{id}/family','get','ProductFamily',auth='adminSession')
 e('/v1/admin/catalog/products/{id}/family','put','ProductFamily','ProductStructure',auth='adminSession')
 e('/v1/admin/catalog/categories/{id}/attributes','get','AttributeValues',auth='adminSession')
 e('/v1/admin/catalog/categories/{id}/attributes','put','AttributeValues','AttributeValues',auth='adminSession')
 e('/v1/customer/profile','get','CustomerProfile',auth='customerBearer')
 e('/v1/customer/profile','put','CustomerProfile','ProfileInput',auth='customerBearer')
 paths['/v1/customer/profile']['put']['responses']['400']={'description':'Name exceeds 120 UTF-8 bytes, gender is unsupported, or date of birth falls outside 1900-01-01 through today in UTC.','content':{'application/json':{'schema':R('Error'),'example':{'error':'Invalid name, gender or date of birth'}}}}
 e('/v1/admin/customers/{id}/profile','get','AdminCustomerProfile',auth='adminSession')
 e('/v1/cart/bundles/{id}','post','Cart','BundleSelection')
 for who,auth in [('customer','customerBearer'),('admin','adminSession')]:e('/v1/'+who+'/orders/{id}/extensions','get','OrderExtensions',auth=auth)
 e('/v1/admin/orders/{id}/comments','get','OrderComment',auth='adminSession',many=True)
 e('/v1/admin/orders/{id}/comments','post','OrderComment','CommentInput',auth='adminSession')
 paths['/v1/search']['get']['parameters'].append({'in':'query','name':'attribute_filters','schema':S(),'description':'JSON object of enabled attribute codes and exact scalar values or arrays of up to 50 alternatives (OR within an attribute, AND across attributes)'})

 e('/v1/admin/promotions/{id}/attribute-conditions','get','AttributeValues',auth='adminSession')
 e('/v1/admin/promotions/{id}/attribute-conditions','put','AttributeValues','AttributeValues',auth='adminSession')
