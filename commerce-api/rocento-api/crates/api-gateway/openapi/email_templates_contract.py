"""Revisioned transactional email content and publication for administrators."""


def extend(schemas, endpoint, paths):
    def ref(name):
        return {'$ref': f'#/components/schemas/{name}'}

    def obj(properties, optional=()):
        return {'type': 'object', 'properties': properties,
                'required': [key for key in properties if key not in optional],
                'additionalProperties': False}

    def nullable(value):
        return {**value, 'nullable': True}

    string = {'type': 'string'}
    integer = {'type': 'integer', 'format': 'int64', 'minimum': 0}
    positive = {**integer, 'minimum': 1}
    timestamp = {'type': 'string', 'format': 'date-time'}
    actor = {'type': 'string', 'format': 'uuid'}
    key = {'type': 'string', 'enum': ['verify', 'reset', 'order', 'shipment']}
    schemas['EmailTemplateContent'] = obj({
        'subject': {**string, 'minLength': 1, 'maxLength': 200},
        'heading': {**string, 'minLength': 1, 'maxLength': 160},
        'body': {**string, 'minLength': 1, 'maxLength': 12000},
        'cta_label': nullable({**string, 'minLength': 1, 'maxLength': 80}),
    })
    schemas['EmailTemplateContent']['description'] = (
        'Plain text with allowlisted {{variable}} substitutions; arbitrary HTML is escaped. '
        'Limits are UTF-8 bytes. Subject and heading are single-line. Account messages '
        'require {{expires_minutes}} in the body and a call-to-action label; the server supplies the trusted one-time URL. '
        'commerce messages require {{message}} in the body and no call-to-action label.'
        ' Placeholders must match exactly with no internal spaces. message and action_url '
        'may appear at most once across all fields; other variables at most four times. '
        'The server always adds the account link expiry and single-use security notice. '
        'brand_name uses the configured installation site name.'
    )
    schemas['EmailTemplateVariable'] = obj({
        'name': string, 'description': string, 'sample': string,
        'required': {'type': 'boolean'},
    })
    schemas['EmailTemplate'] = obj({
        'key': key, 'name': string, 'description': string,
        'category': {'type': 'string', 'enum': ['account', 'orders']},
        'variables': {'type': 'array', 'items': ref('EmailTemplateVariable')},
        'revision': integer,
        'draft': ref('EmailTemplateContent'),
        'published': nullable(ref('EmailTemplateContent')),
        'published_version': nullable(positive),
        'has_unpublished_changes': {'type': 'boolean'},
        'updated_at': nullable(timestamp), 'updated_by': nullable(actor),
    })
    schemas['EmailTemplateList'] = obj({'items': {'type': 'array', 'items': ref('EmailTemplate')}})
    mutation = {'expected_revision': integer,
                'change_note': {**string, 'minLength': 3, 'maxLength': 500}}
    schemas['EmailTemplateSave'] = obj({**mutation, 'content': ref('EmailTemplateContent')})
    schemas['EmailTemplatePublish'] = obj(mutation)
    schemas['EmailTemplateRestore'] = obj({**mutation, 'version': positive})
    schemas['EmailTemplatePreviewInput'] = obj({'content': ref('EmailTemplateContent')})
    schemas['EmailTemplatePreview'] = obj({'subject': string, 'text': string, 'html': string})
    schemas['EmailTemplateVersion'] = obj({
        'version': positive, 'content': ref('EmailTemplateContent'),
        'change_note': string, 'published_at': timestamp, 'published_by': actor,
    })
    schemas['EmailTemplateHistory'] = obj({
        'items': {'type': 'array', 'items': ref('EmailTemplateVersion'), 'maxItems': 50},
        'next_before_version': nullable(positive),
    })
    schemas['EmailTemplateConflict'] = obj({
        'error': string, 'code': {'type': 'string', 'enum': ['stale_revision']},
    })
    base = '/v1/admin/email-templates'
    operations = [
        (base, 'get', 'EmailTemplateList', None, 'read', 'List the four built-in transactional templates and their draft/publication state.'),
        (base + '/{key}', 'get', 'EmailTemplate', None, 'read', 'Read the current draft, active publication, revision and available variables.'),
        (base + '/{key}', 'put', 'EmailTemplate', 'EmailTemplateSave', 'write', 'Save a validated draft with an expected revision and audit reason. Live messages are unchanged.'),
        (base + '/{key}/preview', 'post', 'EmailTemplatePreview', 'EmailTemplatePreviewInput', 'read', 'Render a candidate using synthetic sample values. No email is sent and no customer data is read.'),
        (base + '/{key}/publish', 'post', 'EmailTemplate', 'EmailTemplatePublish', 'publish', 'Publish the reviewed saved draft as an immutable version. The expected revision must still match.'),
        (base + '/{key}/history', 'get', 'EmailTemplateHistory', None, 'read', 'Read immutable publications, newest first, at most 50 per page.'),
        (base + '/{key}/restore', 'post', 'EmailTemplate', 'EmailTemplateRestore', 'write', 'Restore a historical publication into the draft. Publishing remains a separate action.'),
    ]
    for path, method, output, body, permission, description in operations:
        endpoint(path, method, output, body, auth='adminSession')
        operation = paths[path][method]
        operation['tags'] = ['Email templates']
        grants = 'email_templates.read'
        if permission != 'read':
            grants += f' and email_templates.{permission}'
        operation['description'] = f'{description} Requires {grants}. Scope: this merchant installation. Request bodies are limited to 32 KiB.'
        if '{key}' in path:
            operation.setdefault('parameters', []).append({'in': 'path', 'name': 'key', 'required': True, 'schema': key})
        for status, message in [('401', 'Administrator session required.'), ('403', 'Required permission missing.'), ('400', 'Template content, placeholder, or change note is invalid.'), ('404', 'Template or publication not found.'), ('429', 'Preview or mutation rate limit exceeded.')]:
            operation['responses'][status] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}
        if permission in ('write', 'publish'):
            operation['responses']['409'] = {
                'description': 'The reviewed revision is stale. Reload before retrying; another administrator changed this template.',
                'content': {'application/json': {'schema': ref('EmailTemplateConflict')}},
            }
    paths[base + '/{key}/history']['get']['parameters'].append({
        'in': 'query', 'name': 'before_version', 'required': False, 'schema': positive,
        'description': 'Use next_before_version from the preceding page; omitted for the newest publications.',
    })
