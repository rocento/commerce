"""Mobile APIs derive configuration and build types from canonical JSON Schema."""
import json
from pathlib import Path


def extend(schemas, endpoint, paths):
    root = Path(__file__).resolve().parents[2] / 'domain-mobile/contract/v1'
    config = json.loads((root / 'schema.json').read_text())
    manifest = json.loads((root / 'build-manifest.schema.json').read_text())

    def convert(value):
        if isinstance(value, list):
            return [convert(v) for v in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, val in value.items():
            if key in ('$schema', '$id', '$defs', 'propertyNames'):
                continue
            result[key] = val.replace('#/$defs/', '#/components/schemas/Mobile_') if key == '$ref' else convert(val)
        return result

    schemas.update({'Mobile_' + key: convert(value) for key, value in config['$defs'].items()})
    schemas['MobileConfig'] = convert(config)
    schemas['MobileBuildManifest'] = convert(manifest)
    ref = lambda n: {'$ref': '#/components/schemas/' + n}
    string = {'type': 'string'}
    integer = {'type': 'integer', 'format': 'int64', 'minimum': 1}
    revision = {'type': 'integer', 'format': 'int64', 'minimum': 0}
    uid = {'type': 'string', 'format': 'uuid'}
    timestamp = {'type': 'string', 'format': 'date-time'}

    def obj(p, optional=()):
        return {'type': 'object', 'additionalProperties': False, 'properties': p, 'required': [k for k in p if k not in optional]}

    schemas['MobileIssue'] = obj({'path': string, 'code': string})
    schemas['MobileError'] = obj({'error': string, 'issues': {'type': 'array', 'items': ref('MobileIssue')}}, ['issues'])
    schemas['MobileDraft'] = obj({'revision': integer, 'config': ref('MobileConfig')})
    schemas['MobileSaveDraft'] = obj({'expectedRevision': revision, 'config': ref('MobileConfig')})
    schemas['MobilePublish'] = obj({'expectedRevision': integer})
    schemas['MobileRollback'] = obj({'expectedRevision': integer, 'targetVersion': integer})
    schemas['MobileValidation'] = obj({'valid': {'type': 'boolean', 'enum': [True]}})
    schemas['MobileVersion'] = obj({'version': integer, 'config': ref('MobileConfig'), 'checksum': {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}, 'publishedBy': uid, 'publishedAt': timestamp, 'rollbackTarget': {**integer, 'nullable': True}})
    schemas['MobileBuild'] = obj({'id': uid, 'platform': {'type': 'string', 'enum': ['ios', 'android']}, 'buildNumber': integer, 'sourceCommit': string, 'manifestChecksum': string, 'status': {'type': 'string', 'enum': ['queued', 'building', 'completed', 'failed']}, 'createdAt': timestamp})
    schemas['MobileQueueBuild'] = obj({'platform': {'type': 'string', 'enum': ['ios', 'android']}, 'manifest': ref('MobileBuildManifest')})
    schemas['MobileMerchant'] = obj({'id': uid, 'name': string, 'role': {'type':'string','enum':['owner','designer','operator','release_admin']}, 'entitlements': {'type':'object','additionalProperties':{'type':'boolean'}}})
    schemas['MobileAsset'] = obj({'id':uid,'name':string,'kind':{'type':'string','enum':['image','icon','splash']},'verified':{'type':'boolean'},'url':{**string,'nullable':True},'contentType':{**string,'nullable':True},'width':{**integer,'nullable':True},'height':{**integer,'nullable':True},'sizeBytes':{**integer,'nullable':True},'checksum':string})
    schemas['MobileAsset']['properties']['folderId'] = {**uid, 'nullable': True}
    schemas['MobileAssetFolder'] = obj({'id': uid, 'name': string, 'parentId': {**uid, 'nullable': True}, 'assetCount': revision})
    schemas['MobileSaveAssetFolder'] = obj({'name': {'type': 'string', 'minLength': 1, 'maxLength': 100}, 'parentId': {**uid, 'nullable': True}})
    schemas['MobileMoveAssets'] = obj({'ids': {'type': 'array', 'items': uid, 'minItems': 1, 'maxItems': 100, 'uniqueItems': True}, 'folderId': {**uid, 'nullable': True}})
    schemas['MobileRenameAsset'] = obj({'name': {'type': 'string', 'minLength': 1, 'maxLength': 200}})
    schemas['MobileAssetLibrary'] = obj({'items': {'type': 'array', 'items': ref('MobileAsset')}, 'total': revision})
    schemas['MobileAssetMutation'] = obj({'ok': {'type': 'boolean'}})
    for suffix, method, output, body, status, many in [
        ('asset-library','get','MobileAssetLibrary',None,200,False),
        ('asset-folders','get','MobileAssetFolder',None,200,True),
        ('asset-folders','post','MobileAssetFolder','MobileSaveAssetFolder',201,False),
        ('asset-folders/{folder}','put','MobileAssetFolder','MobileSaveAssetFolder',200,False),
        ('asset-folders/{folder}','delete','MobileAssetMutation',None,200,False),
        ('assets/move','post','MobileAssetMutation','MobileMoveAssets',200,False),
        ('assets/{asset}','put','MobileAssetMutation','MobileRenameAsset',200,False),
    ]:
        path = '/v1/merchants/{merchant}/' + suffix
        endpoint(path, method, output, body, status, 'adminSession', many=many)
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['description'] = 'Merchant-owned image organization shared across environments. Active membership required to read; owner or designer required to write. Folder deletion moves descendant images to Unfiled without changing IDs, URLs or app references. Writes are audited in the explicit environment.'
        op['parameters'] = [{'in': 'path', 'name': name, 'required': True, 'schema': uid} for name in ['merchant'] + (['folder'] if '{folder}' in suffix else ['asset'] if '{asset}' in suffix else [])] + [{'in':'query','name':'environment','required':True,'schema':{'type':'string','enum':['staging','production']}}]
        if suffix == 'asset-library':
            op['parameters'] += [{'in':'query','name':'folder','schema':string}, {'in':'query','name':'q','schema':{'type':'string','maxLength':200}}, {'in':'query','name':'offset','schema':{'type':'integer','minimum':0,'maximum':1000000}}, {'in':'query','name':'sort','schema':{'type':'string','enum':['recent','name']}}]
            op['description'] += ' Returns up to 48 verified images. folder accepts all, unfiled or a folder UUID. Search is a literal case-insensitive name substring across all matching assets. Newest order uses creation time.'
    schemas['MobilePreviewCategory'] = obj({'id':uid,'slug':string,'name':string,'imageUrl':{**string,'nullable':True}})
    schemas['MobilePreviewProduct'] = obj({'id':uid,'name':string,'description':{**string,'nullable':True},'productType':string,'parentId':{**uid,'nullable':True},'optionLabel':string,'price':string,'originalPrice':{**string,'nullable':True},'currency':string,'unit':string,'inStock':{'type':'boolean'},'imageUrl':{**string,'nullable':True}}, ['optionLabel'])
    schemas['MobileCatalogPreview'] = obj({'merchantId':uid,'locale':{'type':'string','enum':['en','ar']},'source':string,'categories':{'type':'array','items':ref('MobilePreviewCategory')},'products':{'type':'array','items':ref('MobilePreviewProduct')},'attributes':{'type':'array','items':{'type':'object','additionalProperties':True}},'facets':{'type':'object','additionalProperties':{'type':'object','additionalProperties':integer}},'total':integer,'nextOffset':{**integer,'nullable':True}})
    catalog_path = '/v1/merchants/{merchant}/app-preview/catalog'
    endpoint(catalog_path, 'get', 'MobileCatalogPreview', auth='adminSession')
    catalog_op = paths[catalog_path]['get']
    catalog_op['tags'] = ['Mobile App Studio']
    catalog_op['description'] = 'Read-only public catalog preview from a trusted operator-configured merchant storefront binding. Requires active mobile membership. No customer session or admin credentials are forwarded. Collection matches a visible category UUID or slug; unknown collections fail rather than returning unfiltered products. Returns up to 12 products for section previews, or 24 products when q is supplied for full-catalog discovery. Search, category, stock, price and sorting filters run in the storefront search service. Price filters and ordering use storefront catalog prices. nextOffset supports pagination up to offset 9999.'
    catalog_op['parameters'] = [{'in':'path','name':'merchant','required':True,'schema':uid},{'in':'query','name':'locale','required':True,'schema':{'type':'string','enum':['en','ar']}},{'in':'query','name':'collection','schema':{'type':'string','maxLength':128}},{'in':'query','name':'q','schema':{'type':'string','maxLength':120}},{'in':'query','name':'sort','schema':{'type':'string','pattern':'^(relevance|price_asc|price_desc|name_asc|name_desc|[A-Za-z0-9_-]{1,128}:(asc|desc))$'}},{'in':'query','name':'in_stock','schema':{'type':'boolean'}},{'in':'query','name':'min_price','schema':{'type':'string','maxLength':16}},{'in':'query','name':'max_price','schema':{'type':'string','maxLength':16}},{'in':'query','name':'attribute_filters','description':'JSON object of storefront attribute filters; values may be scalars or arrays.','schema':{'type':'string','maxLength':8192}},{'in':'query','name':'offset','schema':{'type':'integer','minimum':0,'maximum':9999}}]
    for status, description in [('401','Authentication required'),('403','Merchant membership required'),('422','Unbound merchant, unknown collection or invalid query'),('503','Catalog unavailable')]:
        catalog_op['responses'][status] = {'description':description,'content':{'application/json':{'schema':ref('MobileError')}}}
    schemas['MobilePreviewProductDetail'] = obj({'merchantId':uid,'locale':{'type':'string','enum':['en','ar']},'product':ref('MobilePreviewProduct'),'variants':{'type':'array','items':ref('MobilePreviewProduct')},'requiresDeliveryLocation':{'type':'boolean'}})
    product_path = '/v1/merchants/{merchant}/app-preview/products/{product}'
    endpoint(product_path,'get','MobilePreviewProductDetail',auth='adminSession')
    product_op = paths[product_path]['get']
    product_op['tags'] = ['Mobile App Studio']
    product_op['description'] = 'Read-only merchant-scoped public product and variant family. A configurable product requires a covered delivery pin to load localized options and area stock. Only explicit validated coordinates and locale are forwarded to the trusted storefront; no customer or admin credentials. Missing pin returns requiresDeliveryLocation=true and no variants.'
    product_op['parameters'] = [{'in':'path','name':name,'required':True,'schema':uid} for name in ['merchant','product']] + [{'in':'query','name':'locale','required':True,'schema':{'type':'string','enum':['en','ar']}},{'in':'query','name':'latitude','schema':{'type':'number','minimum':-90,'maximum':90}},{'in':'query','name':'longitude','schema':{'type':'number','minimum':-180,'maximum':180}}]
    for status, description in [('401','Authentication required'),('403','Merchant membership required'),('422','Invalid pin, uncovered location or unavailable product'),('503','Catalog unavailable')]:
        product_op['responses'][status] = {'description':description,'content':{'application/json':{'schema':ref('MobileError')}}}
    schemas['MobileAuditEvent'] = obj({'id':uid,'actorId':uid,'action':string,'details':{'type':'object','additionalProperties':True},'createdAt':timestamp})
    for suffix, method, output, body, many in [
        ('assets', 'get', 'MobileAsset', None, True),
        ('app-config/audit', 'get', 'MobileAuditEvent', None, True),
        ('app-config/draft', 'get', 'MobileDraft', None, False),
        ('app-config/draft', 'put', 'MobileDraft', 'MobileSaveDraft', False),
        ('app-config/validate', 'post', 'MobileValidation', None, False),
        ('app-config/publish', 'post', 'MobileVersion', 'MobilePublish', False),
        ('app-config/versions', 'get', 'MobileVersion', None, True),
        ('app-config/rollback', 'post', 'MobileVersion', 'MobileRollback', False),
        ('app-builds', 'get', 'MobileBuild', None, True),
        ('app-builds', 'post', 'MobileBuild', 'MobileQueueBuild', False),
        ('app-builds/{build}', 'get', 'MobileBuild', None, False),
    ]:
        path = '/v1/merchants/{merchant}/' + suffix
        endpoint(path, method, output, body, 202 if body == 'MobileQueueBuild' else 200, 'adminSession', many)
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['description'] = 'Requires active merchant membership; installation administrator permissions alone grant no access. Environment must be explicit. Draft writes use revision 0 only for first creation. Publishing advances the draft revision; refetch before further edits. Production publishes the validated current draft directly. Builds are queued only; signing and workers are a later milestone.'
        op.setdefault('parameters', []).extend([
            {'in': 'path', 'name': 'merchant', 'required': True, 'schema': uid},
            {'in': 'query', 'name': 'environment', 'required': True, 'schema': {'type': 'string', 'enum': ['staging', 'production']}},
        ])
        if '{build}' in path:
            op['parameters'].append({'in': 'path', 'name': 'build', 'required': True, 'schema': uid})
        if suffix in ('assets', 'app-config/audit'):
            op['parameters'].append({'in':'query','name':'beforeId','schema':uid,'description':'Exclusive cursor from the last returned record; 100 assets or 50 audit events per page.'})
        if suffix == 'app-config/versions':
            op['parameters'].append({'in': 'query', 'name': 'beforeVersion', 'schema': integer, 'description': 'Exclusive cursor. At most 50 versions, newest first.'})
        if body in ('MobilePublish', 'MobileRollback', 'MobileQueueBuild'):
            op['parameters'].append({'in': 'header', 'name': 'Idempotency-Key', 'required': True, 'schema': {'type': 'string', 'minLength': 8, 'maxLength': 128, 'pattern': '^[A-Za-z0-9_.:-]+$'}})
        op['responses']['default']['content']['application/json']['schema'] = ref('MobileError')
        for status, description in [('401', 'Missing or expired administrator session'), ('403', 'Merchant membership or role denied'), ('404', 'Resource absent in this merchant/environment'), ('409', 'Revision or idempotency conflict'), ('422', 'Config, entitlement, assets, staging or identity validation failed'), ('429', 'Per-session request limit exceeded'), ('503', 'Storage temporarily unavailable')]:
            op['responses'][status] = {'description': description, 'content': {'application/json': {'schema': ref('MobileError')}}}
    endpoint('/v1/mobile/config', 'get', 'MobileConfig', auth='mobileAppSession')
    op = paths['/v1/mobile/config']['get']
    op['description'] = 'Resolves tenant/environment/platform from a short-lived enrolled app session. Bundle ID and caller-provided tenant IDs grant no access. Authentication and runtime compatibility precede conditional caching. Unsupported locales use the configuration defaultLocale; all translations are returned. SHA-256 is computed over exact UTF-8 response body bytes, not re-encoded native JSON. Incompatible latest config returns 409 for native last-known-good fallback.'
    op['parameters'] = [
        {'in': 'query', 'name': 'platform', 'required': True, 'schema': {'type': 'string', 'enum': ['ios', 'android']}},
        {'in': 'query', 'name': 'runtimeVersion', 'required': True, 'schema': ref('Mobile_RuntimeVersion')},
        {'in': 'query', 'name': 'locale', 'required': True, 'schema': {'type': 'string', 'enum': ['en', 'ar']}},
        {'in': 'header', 'name': 'If-None-Match', 'schema': string},
    ]
    headers = {name: {'schema': string} for name in ['ETag', 'Cache-Control', 'Vary', 'X-Config-Checksum']}
    op['responses']['200']['headers'] = headers
    op['responses']['304'] = {'description': 'Authenticated, compatible config unchanged', 'headers': headers}
    for status, description in [('401', 'Invalid, expired, revoked or wrong-platform app session'), ('404', 'No published configuration'), ('409', 'Latest configuration is incompatible'), ('422', 'Invalid runtime or locale'), ('429', 'Per-session request limit exceeded')]:
        op['responses'][status] = {'description': description, 'content': {'application/json': {'schema': ref('MobileError')}}}

    endpoint('/v1/mobile/merchants', 'get', 'MobileMerchant', auth='adminSession', many=True)
    paths['/v1/mobile/merchants']['get']['description'] = 'Lists only active mobile merchant memberships for the signed-in administrator, with mobile role and entitlements. Installation super administrator permissions do not bypass membership.'
    upload_path = '/v1/merchants/{merchant}/assets'
    endpoint(upload_path, 'post', 'MobileAsset', None, 201, 'adminSession')
    op = paths[upload_path]['post']
    op['parameters'] = paths[upload_path]['get']['parameters'][:2]
    op['description'] = 'Owner/designer upload of one PNG, JPEG or WebP, at most 5 MiB and 4096 pixels per side. Decodes and sanitizes to immutable PNG in private merchant storage; rejects SVG, arbitrary URLs and unsupported fields. Assets are shared across this merchant environments, with the upload audit recorded in the explicit environment. Icon/splash builds remain separate.'
    op['requestBody'] = {'required':True,'content':{'multipart/form-data':{'schema':obj({'name':{'type':'string','minLength':1,'maxLength':200},'file':{'type':'string','format':'binary'},'folderId':uid}, ['folderId'])}}}
    content_path = '/v1/merchants/{merchant}/assets/{asset}/content'
    endpoint(content_path, 'get', 'MobileAsset', auth='adminSession')
    op = paths[content_path]['get']
    op['description'] = 'Private sanitized image bytes; requires active membership for the owning merchant. No arbitrary object key access or remote URL proxy. Trusted legacy URL assets use their verified HTTPS URL.'
    op['parameters'] = [{'in':'path','name':name,'required':True,'schema':uid} for name in ['merchant','asset']]
    op['responses']['200']['content'] = {'image/png':{'schema':{'type':'string','format':'binary'}}}
    for path,method in [('/v1/mobile/merchants','get'),(upload_path,'post'),(content_path,'get')]:
        op=paths[path][method]
        op['tags']=['Mobile App Studio']
        for status,description in [('401','Administrator session required'),('403','Merchant membership or role denied'),('404','Scoped asset absent'),('413','Upload exceeds body limit'),('422','Invalid image or metadata'),('429','Rate limit'),('503','Storage unavailable')]:
            op['responses'][status]={'description':description,'content':{'application/json':{'schema':ref('MobileError')}}}

    platform = {'type':'string','enum':['ios','android']}
    schemas['MobileNativeIdentity'] = obj({'id':uid,'platform':platform,'identifier':string})
    schemas['MobileDevice'] = obj({'id':uid,'platform':platform,'identifier':string,'createdAt':timestamp,'expiresAt':timestamp,'revokedAt':{**timestamp,'nullable':True}})
    schemas['MobileDeviceInvite'] = obj({'identityId':uid})
    schemas['MobileDeviceCode'] = obj({'code':{'type':'string','minLength':64,'maxLength':64},'expiresIn':{'type':'integer','enum':[900]}})
    binding = {'merchantId':uid,'platform':platform,'identifier':string}
    schemas['MobileEnroll'] = obj({**binding,'code':{'type':'string','minLength':64,'maxLength':64}})
    schemas['MobileRenew'] = obj({**binding,'deviceToken':{'type':'string','minLength':64,'maxLength':64}})
    schemas['MobileDeviceSession'] = obj({**binding,'environment':{'type':'string','enum':['production']},'deviceId':uid,'deviceToken':{**string,'nullable':True},'accessToken':string,'expiresIn':{'type':'integer','enum':[1800]}})
    schemas['MobileDeviceRevoked'] = obj({'revoked':{'type':'boolean','enum':[True]}})
    for suffix,method,output,body,many in [('identities','get','MobileNativeIdentity',None,True),('invitations','post','MobileDeviceCode','MobileDeviceInvite',False),('','get','MobileDevice',None,True),('{device}/revoke','post','MobileDeviceRevoked',None,False)]:
        path='/v1/merchants/{merchant}/app-devices'+('/'+suffix if suffix else '')
        endpoint(path,method,output,body,auth='adminSession',many=many)
        op=paths[path][method]
        op['tags']=['Mobile App Studio']
        op['description']='Production-only internal installations. Requires active merchant owner membership. Identities must already be provisioned through trusted onboarding. Invitation codes are secret, shown once, valid for 15 minutes and single use. Device credentials last 30 days; revocation denies config/assets and renewal. Customer credentials are independent. Device listing returns latest 100.'
        op['parameters']=[{'in':'path','name':'merchant','required':True,'schema':uid}]
        if '{device}' in path: op['parameters'].append({'in':'path','name':'device','required':True,'schema':uid})
    for suffix,body in [('enroll','MobileEnroll'),('session','MobileRenew')]:
        path='/v1/mobile/'+suffix
        endpoint(path,'post','MobileDeviceSession',body)
        paths[path]['post']['description']='Internal testing only. Requires a secret owner-issued invitation (enroll) or device credential (session), plus matching immutable production merchant/platform/identifier binding. Identity strings alone grant no access. X-Commerce-Request: 1 required. Responses are no-store. Renewal replaces the device access session without rotating or extending the 30-day device credential, allowing recovery after lost responses. This is not store attestation or public enrollment.'
        paths[path]['post']['tags']=['Mobile App Studio']
    path='/v1/mobile/assets/{asset}/content'
    endpoint(path,'get','MobileAsset',auth='mobileAppSession')
    op=paths[path]['get']
    op['description']='Authenticated sanitized PNG from the latest compatible published config only. Denies foreign, draft-only, unverified, expired and revoked access; never proxies remote URLs. Validate X-Asset-Checksum over exact bytes. No public cache.'
    op['parameters']=paths['/v1/mobile/config']['get']['parameters'][:3]+[{'in':'path','name':'asset','required':True,'schema':uid}]
    op['responses']['200']['content']={'image/png':{'schema':{'type':'string','format':'binary'}}}
    op['responses']['200']['headers']={name:{'schema':string} for name in ['X-Asset-Checksum','Cache-Control','Vary']}
    for path in ['/v1/mobile/enroll','/v1/mobile/session',path]+[p for p in paths if '/app-devices' in p]:
        for op in paths[path].values():
            for status,description in [('401','Missing, expired, used, revoked or mismatched credential'),('403','Owner membership denied'),('404','Scoped resource or published config absent'),('409','Published config incompatible'),('429','Request limit exceeded'),('503','Storage unavailable')]:
                op['responses'][status]={'description':description,'content':{'application/json':{'schema':ref('MobileError')}}}

    schemas['MobileCategoryChoice'] = obj({'id': uid, 'parentId': {**uid, 'nullable': True}, 'slug': string, 'name': string})
    path = '/v1/merchants/{merchant}/app-preview/categories'
    endpoint(path, 'get', 'MobileCategoryChoice', auth='adminSession', many=True)
    op = paths[path]['get']
    op['tags'] = ['Mobile App Studio']
    op['description'] = 'Read the connected storefront category hierarchy for the builder. Requires active merchant membership and a trusted MOBILE_CATALOG_ORIGINS binding. Returns names, IDs, slugs and parent IDs; no customer credentials or arbitrary origins are forwarded.'
    op['parameters'] = [{'in': 'path', 'name': 'merchant', 'required': True, 'schema': uid}]
    for status, description in [('401', 'Missing administrator session'), ('403', 'Merchant membership denied'), ('422', 'Catalog not connected'), ('429', 'Request limit exceeded'), ('503', 'Catalog temporarily unavailable')]:
        op['responses'][status] = {'description': description, 'content': {'application/json': {'schema': ref('MobileError')}}}

    schemas['MobilePreviewInstance'] = obj({'state': string, 'ready': {'type': 'boolean'}, 'activeSessions': {'type': 'integer', 'minimum': 0, 'nullable': True}})
    schemas['MobilePreviewInstanceAction'] = obj({'action': {'type': 'string', 'enum': ['start', 'stop']}})
    path = '/v1/merchants/{merchant}/app-preview/instance'
    for method in ['get', 'post']:
        endpoint(path, method, 'MobilePreviewInstance', 'MobilePreviewInstanceAction' if method == 'post' else None, auth='adminSession')
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op.setdefault('parameters', []).append({'in': 'path', 'name': 'merchant', 'required': True, 'schema': uid})
        op['description'] = 'Fixed operator-configured Android preview worker. Requires a current administrator session and active membership in the configured merchant; installation permissions alone grant no access. Status requires owner/designer membership; start/stop requires owner membership and records an audit event. The caller cannot choose an instance, worker URL or AWS credentials. Stop requires worker-confirmed absence of active previews; an unavailable worker is not evidence of idleness. activeSessions is null when the worker cannot be observed. This operation has no environment selector.'
        for status, description in [('401', 'Administrator session required'), ('403', 'Merchant role or mutation protection denied'), ('404', 'Merchant is not the configured preview merchant'), ('409', 'Unsupported action, unsettled instance state or active previews'), ('429', 'Request limit exceeded'), ('503', 'Worker, AWS controller or storage unavailable')]:
            op['responses'][status] = {'description': description, 'content': {'application/json': {'schema': ref('MobileError')}}}
        if method == 'post':
            op['responses']['422'] = {'description': 'Malformed action or unknown request fields'}

    schemas['MobilePreviewSession'] = obj({'id': uid, 'code': string, 'expiresAt': timestamp})
    schemas['MobilePreviewSessionStatus'] = obj({'id': uid, 'platform': {'type': 'string', 'enum': ['ios', 'android']}, 'implementation': {'type': 'string', 'enum': ['native', 'react-native']}, 'expiresAt': timestamp, 'revokedAt': {**timestamp, 'nullable': True}, 'appliedRevision': {**integer, 'nullable': True}, 'appliedAt': {**timestamp, 'nullable': True}})
    schemas['MobilePreviewAck'] = obj({'revision': integer, 'checksum': {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}})
    schemas['MobilePreviewApplied'] = obj({'applied': {'type': 'boolean', 'enum': [True]}})
    for suffix, method, output in [('', 'post', 'MobilePreviewSession'), ('/{session}', 'get', 'MobilePreviewSessionStatus'), ('/{session}', 'delete', 'MobileDeviceRevoked')]:
        path = '/v1/merchants/{merchant}/app-preview/sessions' + suffix
        endpoint(path, method, output, auth='adminSession')
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['description'] = 'Requires active owner/designer membership. Creates a 30-minute draft bearer capability, scoped to merchant/environment. Only its creator can inspect or revoke it. Starting again revokes the previous session for this editor/environment. Code is returned once; do not persist or log it. Applied revision is a native acknowledgement, never evidence of video streaming.'
        op['parameters'] = [{'in': 'path', 'name': 'merchant', 'required': True, 'schema': uid}]
        op['parameters'] += ([{'in': 'path', 'name': 'session', 'required': True, 'schema': uid}] if suffix else [{'in': 'query', 'name': 'environment', 'required': True, 'schema': {'type': 'string', 'enum': ['staging', 'production']}}])
        for status in ['401', '403', '404', '429', '503']:
            op['responses'][status] = {'description': 'Preview session access or storage failure', 'content': {'application/json': {'schema': ref('MobileError')}}}
    schemas['MobileWorkerPreviewSession'] = obj({'id': uid, 'expiresAt': timestamp})
    for suffix, method, output in [('/worker', 'post', 'MobileWorkerPreviewSession'), ('/{session}/frame', 'get', 'MobileAsset')]:
        path = '/v1/merchants/{merchant}/app-preview/sessions' + suffix
        endpoint(path, method, output, auth='adminSession')
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['description'] = 'Private native simulator worker. Requires active owner/designer membership; frames are restricted to the session creator and tenant, expire with the session and must never be cached. The worker receives a short-lived draft capability; no capability is returned to the browser. Frames are real simulator screenshots, independent of revision acknowledgements. No remote hosting availability is implied.'
        op['parameters'] = [{'in': 'path', 'name': 'merchant', 'required': True, 'schema': uid}]
        if method == 'get':
            op['parameters'].append({'in': 'path', 'name': 'session', 'required': True, 'schema': uid})
            op['responses']['200']['content'] = {'image/png': {'schema': {'type': 'string', 'format': 'binary'}}}
            op['responses']['202'] = {'description': 'Simulator is starting; no frame available yet'}
        else:
            op['parameters'] += [{'in': 'query', 'name': 'environment', 'required': True, 'schema': {'type': 'string', 'enum': ['staging', 'production']}}, {'in': 'header', 'name': 'X-Commerce-Request', 'required': True, 'schema': {'type': 'string', 'enum': ['1']}}]
        if method == 'post':
            op['parameters'] += [{'in': 'query', 'name': 'platform', 'schema': {'type': 'string', 'enum': ['ios', 'android'], 'default': 'ios'}}, {'in': 'query', 'name': 'implementation', 'schema': {'type': 'string', 'enum': ['native', 'react-native'], 'default': 'native'}}]
        for status in ['401', '403', '404', '429', '503']:
            op['responses'][status] = {'description': 'Session denied, worker unavailable or capacity exhausted'}
    coordinate = {'type': 'number', 'minimum': 0, 'maximum': 1}
    input_base = {'sequence': {'type': 'integer', 'minimum': 1, 'maximum': 9007199254740991}}
    schemas['MobilePreviewInput'] = {'oneOf': [
        obj({**input_base, 'kind': {'type': 'string', 'enum': ['tap']}, 'x': coordinate, 'y': coordinate}),
        obj({**input_base, 'kind': {'type': 'string', 'enum': ['swipe']}, 'x': coordinate, 'y': coordinate, 'endX': coordinate, 'endY': coordinate, 'duration': {'type': 'number', 'minimum': 0.05, 'maximum': 1.5}}),
        obj({**input_base, 'kind': {'type': 'string', 'enum': ['text']}, 'text': {'type': 'string', 'minLength': 1, 'maxLength': 128, 'pattern': '^[ -~]+$'}}),
        obj({**input_base, 'kind': {'type': 'string', 'enum': ['key']}, 'key': {'type': 'string', 'enum': ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Delete']}}),
    ]}
    for suffix, method in [('/video', 'get'), ('/input', 'post')]:
        path = '/v1/merchants/{merchant}/app-preview/sessions/{session}' + suffix
        endpoint(path, method, 'MobilePreviewApplied', 'MobilePreviewInput' if method == 'post' else None, auth='adminSession')
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['parameters'] = [{'in': 'path', 'name': name, 'required': True, 'schema': uid} for name in ['merchant', 'session']]
        op['description'] = 'Authenticated real simulator capture/control. Requires active creator membership and unexpired session. Video rechecks authorization during delivery; little-endian uint32 JPEG length followed by JPEG bytes, zero-length heartbeat, maximum JPEG 2 MiB. Input uses normalized coordinates, strictly increasing sequence numbers, no automatic replay, and printable English keyboard text. Native capability and worker address are never returned.'
        if method == 'get':
            op['responses']['200']['content'] = {'application/x-rocento-mjpeg': {'schema': {'type': 'string', 'format': 'binary'}}}
        else:
            op['parameters'].append({'in': 'header', 'name': 'X-Commerce-Request', 'required': True, 'schema': {'type': 'string', 'enum': ['1']}})
            op['responses'].pop('200')
            op['responses']['204'] = {'description': 'Native input applied'}
        for status in ['400', '401', '403', '404', '409', '429', '503']:
            op['responses'][status] = {'description': 'Input rejected, session denied, sequence consumed, or worker unavailable'}
    for suffix, method, output, body in [('', 'get', 'MobileConfig', None), ('/ack', 'post', 'MobilePreviewApplied', 'MobilePreviewAck'), ('/assets/{asset}', 'get', 'MobileAsset', None)]:
        path = '/v1/mobile/preview/{session}' + suffix
        endpoint(path, method, output, body, auth='mobileAppSession')
        op = paths[path][method]
        op['tags'] = ['Mobile App Studio']
        op['description'] = 'Uses the separate short-lived preview bearer token, NOT a published mobile enrollment token. Revalidates creator membership, session expiry, tenant and environment on every request. Snapshot is fully validated and runtime compatible; checksum hashes exact response bytes. ACK must match the delivered revision/checksum. Full snapshots recover missed revisions. No draft writes, commerce access or native executable code. No-store responses.'
        op['parameters'] = [{'in': 'path', 'name': 'session', 'required': True, 'schema': uid}, {'in': 'query', 'name': 'merchantId', 'required': True, 'schema': uid}, {'in': 'query', 'name': 'environment', 'required': True, 'schema': {'type': 'string', 'enum': ['staging', 'production']}}, {'in': 'query', 'name': 'runtimeVersion', 'required': True, 'schema': string}]
        if not suffix:
            op['responses']['200']['headers'] = {name: {'schema': string} for name in ['X-Preview-Session', 'X-Preview-Revision', 'X-Config-Checksum']}
        if '{asset}' in suffix:
            op['parameters'].append({'in': 'path', 'name': 'asset', 'required': True, 'schema': uid})
            op['responses']['200']['content'] = {'image/png': {'schema': {'type': 'string', 'format': 'binary'}}}
            op['responses']['200']['headers'] = {'X-Asset-Checksum': {'schema': string}}
        for status in ['401', '403', '404', '409', '422', '429', '503']:
            op['responses'][status] = {'description': 'Preview session access, validation or storage failure', 'content': {'application/json': {'schema': ref('MobileError')}}}
