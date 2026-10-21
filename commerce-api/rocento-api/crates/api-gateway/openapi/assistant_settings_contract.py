"""Admin-only OpenAI provider configuration. API keys are write-only."""
def extend(schemas, endpoint, paths):
    schemas['AssistantProviderSettings'] = {
        'type': 'object', 'additionalProperties': False,
        'required': ['enabled', 'provider', 'model', 'key_configured', 'source', 'editable'],
        'properties': {
            'enabled': {'type':'boolean'}, 'provider': {'type':'string'},
            'model': {'type':'string'}, 'key_configured': {'type':'boolean'},
            'source': {'type':'string'}, 'editable': {'type':'boolean'},
        },
    }
    schemas['AssistantProviderInput'] = {
        'type':'object', 'additionalProperties':False, 'required':['enabled','model'],
        'properties': {
            'enabled': {'type':'boolean'},
            'model': {'type':'string','minLength':1,'maxLength':100,'pattern':'^[A-Za-z0-9][A-Za-z0-9._:-]*$'},
            'api_key': {'type':'string','maxLength':512,'writeOnly':True,'nullable':True},
            'clear_key': {'type':'boolean','default':False},
        },
    }
    schemas['AssistantProviderTest'] = {'type':'object','additionalProperties':False,'required':['ok','message'],'properties':{'ok':{'type':'boolean'},'message':{'type':'string'}}}
    endpoint('/v1/admin/assistant/settings','get','AssistantProviderSettings',auth='adminSession')
    endpoint('/v1/admin/assistant/settings','put','AssistantProviderSettings','AssistantProviderInput',auth='adminSession')
    endpoint('/v1/admin/assistant/settings/test','post','AssistantProviderTest','AssistantProviderInput',auth='adminSession')

    def obj(properties):
        return {'type': 'object', 'additionalProperties': False, 'required': list(properties), 'properties': properties}
    def ref(name):
        return {'$ref': '#/components/schemas/' + name}
    def text(limit=256):
        return {'type': 'string', 'maxLength': limit}
    def enum(*values):
        return {'type': 'string', 'enum': list(values)}
    schemas['AssistantReadinessCheck'] = obj({
        'name': enum('provider', 'assistant', 'catalog_tools', 'tool_schemas', 'knowledge', 'storage', 'commerce_schema'),
        'status': enum('pass', 'fail', 'not_configured'), 'message': text(),
    })
    schemas['AssistantAcceptance'] = obj({
        'status': enum('not_run', 'not_configured', 'pass', 'fail', 'stale'),
        'checked_at': {'type': 'string', 'format': 'date-time', 'nullable': True},
        'configuration_revision': {**text(64), 'nullable': True},
        'request_reference': {'type': 'string', 'format': 'uuid', 'nullable': True},
        'message': text(),
        'duration_ms': {'type': 'integer', 'minimum': 0, 'nullable': True},
        'input_tokens': {'type': 'integer', 'minimum': 0, 'nullable': True},
        'output_tokens': {'type': 'integer', 'minimum': 0, 'nullable': True},
    })
    schemas['AssistantReadiness'] = obj({
        'version': enum('1'), 'tenant_id': {'type': 'string', 'format': 'uuid'},
        'enabled': {'type': 'boolean'}, 'provider_configured': {'type': 'boolean'},
        'model': text(100), 'configuration_revision': text(64), 'tool_schema_revision': text(64),
        'feature_flags': {'type': 'array', 'items': text(64), 'maxItems': 16},
        'checks': {'type': 'array', 'items': ref('AssistantReadinessCheck'), 'maxItems': 10},
        'currency_modes': {'type': 'array', 'items': text(32), 'maxItems': 10},
        'quantity_modes': {'type': 'array', 'items': text(32), 'maxItems': 10},
        'payment_modes': {'type': 'array', 'items': text(32), 'maxItems': 10},
        'delivery_modes': {'type': 'array', 'items': text(64), 'maxItems': 10},
        'knowledge_configured': {'type': 'boolean'}, 'last_acceptance': ref('AssistantAcceptance'),
    })
    schemas['AssistantAcceptanceInput'] = obj({'query': {'type': 'string', 'minLength': 1, 'maxLength': 200}})
    endpoint('/v1/admin/assistant/readiness', 'get', 'AssistantReadiness', auth='adminSession')
    endpoint('/v1/admin/assistant/acceptance', 'post', 'AssistantAcceptance', 'AssistantAcceptanceInput', auth='adminSession')
