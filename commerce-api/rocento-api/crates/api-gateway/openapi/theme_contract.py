"""Theme HTTP schemas derived from the authoritative component contract."""
import json
from pathlib import Path

def extend(schemas, endpoint, paths):
    contract = json.loads(Path(__file__).resolve().parents[3].joinpath('theme-contract.json').read_text())
    def obj(properties, optional=()):
        return {'type': 'object', 'properties': properties, 'required': [k for k in properties if k not in optional], 'additionalProperties': False}
    def ref(name): return {'$ref': '#/components/schemas/' + name}
    def string(): return {'type': 'string'}
    def uid(): return {'type': 'string', 'format': 'uuid'}
    def integer(): return {'type': 'integer', 'minimum': 0}
    def nullable(value): return {**value, 'nullable': True}
    def prop(p):
        kind = p['kind']
        if kind == 'number': return {'type': 'integer', 'minimum': p['min'], 'maximum': p['max']}
        if kind == 'asset': return nullable(uid())
        if kind == 'select': return {'type': 'string', 'enum': p['options']}
        if kind == 'color': return {'type': 'string', 'pattern': '^#[a-fA-F0-9]{6}$'}
        return {'type': 'string', 'maxLength': p.get('max', 2000), 'minLength': p.get('min', 0)}
    sections = []
    for kind, definition in contract['components'].items():
        name = 'ThemeSection_' + kind
        translation_fields = {}
        for key, property in definition['settings'].items():
            if property['kind'] == 'text' and key != 'query':
                translation_fields[key] = obj({'source': {**prop(property), 'minLength': 0}, 'value': prop(property)})
        translations = {'type': 'object', 'maxProperties': 32, 'additionalProperties': obj(translation_fields, translation_fields.keys()), 'description': 'Canonical language[-Script][-REGION] locale keys. Plain-text overrides with reviewed source snapshots; source changes require review before publication.'}
        schemas[name] = obj({'id': {'type': 'string', 'maxLength': 80}, 'component': {'type': 'string', 'enum': [kind]}, 'version': {'type': 'integer', 'enum': [definition['version']]}, 'enabled': {'type': 'boolean'}, 'settings': obj({k: prop(v) for k, v in definition['settings'].items()}, [k for k in definition['settings'] if kind == 'footer_options' and (k == 'back_to_top_label' or k.startswith('install_'))]), 'translations': translations}, ['translations'])
        sections.append(ref(name))
    section_list = {'type': 'array', 'maxItems': 30, 'items': {'oneOf': sections}}
    schemas['ThemeConfiguration'] = obj({'schema_version': {'type': 'string', 'enum': [contract['schema_version']]}, 'tokens': obj({k: prop(v) for k, v in contract['tokens'].items()}, ['font.arabic.body', 'font.arabic.heading']), 'global': obj({k: section_list for k in ['top', 'bottom']}), 'pages': obj({k: section_list for k in ['home', 'category', 'product', 'search', 'cart']})})
    schemas['Theme'] = obj({'id': uid(), 'name': string(), 'owner_channel': string(), 'revision': integer(), 'configuration': ref('ThemeConfiguration'), 'published_version': nullable(uid()), 'updated_at': {'type': 'string', 'format': 'date-time'}})
    schemas['ThemeVersion'] = obj({'id': uid(), 'theme_id': uid(), 'number': integer(), 'configuration': ref('ThemeConfiguration'), 'created_by': uid(), 'published_at': {'type': 'string', 'format': 'date-time'}, 'source_version': nullable(uid())})
    schemas['ThemeCreate'] = obj({'name': string(), 'owner_channel': string(), 'source': nullable(uid())}, ['source'])
    schemas['ThemeUpdate'] = obj({'expected_revision': integer(), 'configuration': ref('ThemeConfiguration')})
    schemas['ThemePublish'] = obj({'expected_revision': integer(), 'source_version': nullable(uid())}, ['source_version'])
    schemas['ThemeTargetRule'] = obj({'id': uid(), 'theme_id': uid(), 'enabled': {'type': 'boolean'}, 'segment_id': nullable(uid()), 'area_id': nullable(uid()), 'stock_id': nullable(uid()), 'city': nullable({'type': 'string', 'maxLength': 100})}, ['segment_id', 'area_id', 'stock_id', 'city'])
    rules = {'type': 'array', 'maxItems': 30, 'items': ref('ThemeTargetRule')}
    schemas['ThemeAssignment'] = obj({'channel': string(), 'theme_id': nullable(uid()), 'revision': integer(), 'rules': rules})
    schemas['ThemeAssign'] = obj({'theme_id': nullable(uid()), 'expected_revision': integer(), 'rules': rules}, ['rules'])
    schemas['ThemeValidation'] = obj({'valid': {'type': 'boolean'}})
    schemas['ResolvedTheme'] = obj({'version_id': nullable(uid()), 'configuration': ref('ThemeConfiguration'), 'cities': {'type': 'array', 'items': string()}, 'images': {'type': 'object', 'additionalProperties': ref('CatalogImage'), 'description': 'Dimensions and existing renditions for media referenced by this resolved theme.'}, 'discovery_attribution_enabled': {'type': 'boolean', 'description': 'Whether this deployment is bound to the installation and accepts discovery attribution.'}}, ['images', 'discovery_attribution_enabled'])
    named = {'type': 'array', 'items': obj({'id': uid(), 'name': string()})}
    schemas['ThemeTargetOptions'] = obj({'segments': named, 'stocks': named, 'areas': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': True}}})
    schemas['ThemeContract'] = obj({'schema_version': string(), 'tokens': {'type': 'object', 'additionalProperties': {'type': 'object'}}, 'components': {'type': 'object', 'additionalProperties': {'type': 'object'}}, 'default': ref('ThemeConfiguration')})
    for path, method, output, body, many in [
        ('', 'get', 'Theme', None, True), ('', 'post', 'Theme', 'ThemeCreate', False),
        ('/contract', 'get', 'ThemeContract', None, False),
        ('/{id}', 'get', 'Theme', None, False), ('/{id}', 'put', 'Theme', 'ThemeUpdate', False),
        ('/{id}/preview', 'get', 'ThemeConfiguration', None, False),
        ('/{id}/validate', 'post', 'ThemeValidation', None, False),
        ('/{id}/publish', 'post', 'ThemeVersion', 'ThemePublish', False),
        ('/{id}/versions', 'get', 'ThemeVersion', None, True),
        ('/{id}/versions/{version}', 'get', 'ThemeVersion', None, False),
        ('/assignments', 'get', 'ThemeAssignment', None, True),
        ('/target-options/{channel}', 'get', 'ThemeTargetOptions', None, False),
        ('/assignments/{channel}', 'put', 'ThemeAssignment', 'ThemeAssign', False),
    ]:
        full_path = '/v1/admin/themes' + path
        endpoint(full_path, method, output, body, auth='adminSession', many=many)
        for parameter, schema in [('channel', {'type': 'string', 'maxLength': 100}), ('version', uid())]:
            if '{' + parameter + '}' in full_path:
                paths[full_path][method].setdefault('parameters', []).append({'in': 'path', 'name': parameter, 'required': True, 'schema': schema})
    endpoint('/v1/theme/{channel}', 'get', 'ResolvedTheme')
    resolve = paths['/v1/theme/{channel}']['get']
    resolve['parameters'] = [
        {'in': 'path', 'name': 'channel', 'required': True, 'schema': {'type': 'string', 'maxLength': 100}},
        {'in': 'header', 'name': 'If-None-Match', 'required': False, 'schema': string()},
        {'in': 'header', 'name': 'Authorization', 'required': False, 'schema': string(), 'description': 'Bearer customer session; segment membership is evaluated server-side.'},
        {'in': 'header', 'name': 'X-Delivery-Latitude', 'required': False, 'schema': {'type': 'number', 'minimum': -90, 'maximum': 90}},
        {'in': 'header', 'name': 'X-Delivery-Longitude', 'required': False, 'schema': {'type': 'number', 'minimum': -180, 'maximum': 180}},
        {'in': 'query', 'name': 'city', 'required': False, 'schema': {'type': 'string', 'maxLength': 100}},
    ]
    resolve['responses']['304'] = {'description': 'Published theme has not changed', 'headers': {'ETag': {'schema': string()}, 'Cache-Control': {'schema': string()}}}
    resolve['responses']['200']['headers'] = {'ETag': {'schema': string()}, 'Cache-Control': {'schema': string()}}
