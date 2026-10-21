"""Storefront language list and admin translation contract."""
def extend(schemas, endpoint, paths):
    def obj(fields):
        return {'type': 'object', 'properties': fields, 'required': list(fields), 'additionalProperties': False}
    def ref(name):
        return {'$ref': '#/components/schemas/' + name}
    string = {'type': 'string'}
    integer = {'type': 'integer', 'minimum': 0}
    text_fields = {'type': 'object', 'additionalProperties': string}
    language = {'locale': string, 'name': string, 'native_name': string, 'direction': {'type': 'string', 'enum': ['ltr', 'rtl']}}
    schemas['StorefrontLanguage'] = obj({**language, 'revision': integer})
    schemas['StorefrontLanguageInput'] = obj({**language, 'expected_revision': integer})
    schemas['StorefrontLanguageSettings'] = obj({'source_locale': string, 'languages': {'type': 'array', 'items': ref('StorefrontLanguage')}, 'publication_available': {'type': 'boolean', 'enum': [False]}})
    schemas['PublicStorefrontLanguages'] = obj({'source_locale': string, 'languages': {'type': 'array', 'items': ref('StorefrontLanguage')}})
    schemas['CatalogTranslation'] = obj({'entity_id': {'type': 'string', 'format': 'uuid'}, 'name': string, 'source': text_fields, 'fields': text_fields, 'revision': integer, 'status': {'type': 'string', 'enum': ['missing', 'draft', 'needs_review', 'reviewed']}})
    schemas['CatalogTranslationInput'] = obj({'expected_revision': integer, 'source': text_fields, 'fields': text_fields, 'reviewed': {'type': 'boolean'}})
    schemas['CatalogTranslationPage'] = obj({'items': {'type': 'array', 'items': ref('CatalogTranslation')}, **{key: integer for key in ['total', 'missing', 'needs_review', 'reviewed', 'draft', 'offset', 'limit']}})
    schemas['CatalogTranslationSaved'] = obj({'revision': integer, 'status': {'type': 'string', 'enum': ['draft', 'reviewed']}})
    base = '/v1/admin/languages'
    endpoint('/v1/languages', 'get', 'PublicStorefrontLanguages')
    endpoint(base, 'get', 'StorefrontLanguageSettings', auth='adminSession')
    endpoint(base, 'post', 'StorefrontLanguage', 'StorefrontLanguageInput', auth='adminSession')
    listing = base + '/{locale}/translations'
    saving = listing + '/{kind}/{id}'
    endpoint(listing, 'get', 'CatalogTranslationPage', auth='adminSession')
    endpoint(saving, 'get', 'CatalogTranslation', auth='adminSession')
    endpoint(saving, 'put', 'CatalogTranslationSaved', 'CatalogTranslationInput', auth='adminSession')
    for path, method in [(listing, 'get'), (saving, 'get'), (saving, 'put')]:
        paths[path][method].setdefault('parameters', []).append({'in': 'path', 'name': 'locale', 'required': True, 'schema': string})
    paths[saving]['get']['parameters'].append({'in': 'path', 'name': 'kind', 'required': True, 'schema': {'type': 'string', 'enum': ['product', 'category', 'navigation', 'attribute']}})
    paths[saving]['put']['parameters'].append({'in': 'path', 'name': 'kind', 'required': True, 'schema': {'type': 'string', 'enum': ['product', 'category', 'navigation', 'attribute']}})
    for name, schema in [('kind', {'type': 'string', 'enum': ['product', 'category', 'navigation', 'attribute'], 'default': 'product'}), ('q', {'type': 'string', 'maxLength': 200}), ('offset', integer)]:
        paths[listing]['get']['parameters'].append({'in': 'query', 'name': name, 'schema': schema})
    # Interface copy has built-in en/ar values and independent draft overrides.
    forms = {'type': 'string', 'enum': ['zero', 'one', 'two', 'few', 'many', 'other']}
    locale = {'type': 'string', 'enum': ['en', 'ar']}
    schemas['InterfaceMessage'] = obj({'key': string, 'group': string, 'plural': {**string, 'nullable': True}, 'en': text_fields, 'ar': text_fields})
    schemas['InterfaceOverride'] = obj({'key': string, 'locale': locale, 'form': forms, 'text': string, 'source_text': string})
    schemas['InterfaceBundle'] = obj({'revision': integer, 'catalog_version': string, 'messages': {'type': 'array', 'items': ref('InterfaceMessage')}, 'overrides': {'type': 'array', 'items': ref('InterfaceOverride')}})
    schemas['InterfaceChange'] = obj({'key': string, 'locale': locale, 'form': forms, 'before': string, 'after': string})
    schemas['InterfaceImportIssue'] = obj({'row': integer, 'field': string, 'message': string})
    schemas['InterfacePreview'] = obj({'revision': integer, 'catalog_version': string, 'changes': {'type': 'array', 'items': ref('InterfaceChange')}, 'errors': {'type': 'array', 'items': ref('InterfaceImportIssue')}})
    csv = {'type': 'string', 'maxLength': 262144, 'description': 'UTF-8 CSV up to 256 KiB, key, optional form, and en and/or ar columns.'}
    guard = {'expected_revision': integer, 'catalog_version': string}
    schemas['InterfaceCsvInput'] = obj({'csv': csv})
    schemas['InterfaceImportInput'] = obj({'csv': csv, **guard})
    schemas['InterfaceEditInput'] = obj({'key': string, 'locale': locale, 'form': forms, 'text': {**string, 'nullable': True, 'maxLength': 4000, 'description': 'Null restores built-in text.'}, **guard})
    schemas['InterfaceSaved'] = obj({'revision': integer, 'changed': integer})
    base = '/v1/admin/languages/interface'
    endpoint(base, 'get', 'InterfaceBundle', auth='adminSession')
    endpoint(base, 'put', 'InterfaceSaved', 'InterfaceEditInput', auth='adminSession')
    endpoint(base + '/preview', 'post', 'InterfacePreview', 'InterfaceCsvInput', auth='adminSession')
    endpoint(base + '/import', 'put', 'InterfaceSaved', 'InterfaceImportInput', auth='adminSession')
    endpoint(base + '/export', 'get', auth='adminSession')
    paths[base + '/export']['get']['responses']['200'] = {'description': 'UTF-8 CSV with BOM and reversible spreadsheet formula escaping', 'content': {'text/csv': {'schema': {'type': 'string'}}}}
