"""Authenticated merchant documentation; full service inventory stays private."""


def extend(schemas, endpoint, paths):
    schemas['MerchantOpenApiDocument'] = {
        'type': 'object',
        'description': 'The reviewed merchant OpenAPI 3.0.3 document. This is a schema reference, not tenant records or authorization to execute its operations.',
        'required': ['openapi', 'info', 'paths', 'components'],
        'properties': {
            'openapi': {'type': 'string', 'enum': ['3.0.3']},
            'info': {'type': 'object', 'additionalProperties': True},
            'paths': {'type': 'object', 'additionalProperties': True},
            'components': {'type': 'object', 'additionalProperties': True},
        },
        'additionalProperties': True,
    }
    path = '/v1/admin/api-reference/openapi.json'
    endpoint(path, 'get', 'MerchantOpenApiDocument', auth='adminSession')
    operation = paths[path]['get']
    operation['description'] = 'Requires a current administrator session in this installation and the api.docs.read permission. The response contains only the reviewed merchant reference. Operation-specific permissions remain required to call its APIs. Responses are private and must not be cached.'
    operation['responses']['200']['headers'] = {
        'Cache-Control': {'description': 'private, no-store', 'schema': {'type': 'string'}},
    }
    for status, description in [('401', 'No valid administrator session.'), ('403', 'Administrator lacks api.docs.read.')]:
        operation['responses'][status] = {
            'description': description,
            'content': {'application/json': {'schema': {'$ref': '#/components/schemas/Error'}}},
        }
