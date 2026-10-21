"""Journey-based marketing notification content; generation has no delivery side effects."""


def extend(schemas, endpoint, paths):
    def ref(name):
        return {'$ref': f'#/components/schemas/{name}'}

    def obj(properties, optional=()):
        return {'type': 'object', 'properties': properties,
                'required': [key for key in properties if key not in optional],
                'additionalProperties': False}

    def array(name):
        return {'type': 'array', 'items': ref(name)}

    string = {'type': 'string'}
    boolean = {'type': 'boolean'}
    integer = {'type': 'integer', 'format': 'int64', 'minimum': 0}
    positive = {**integer, 'minimum': 1}
    uuid = {**string, 'format': 'uuid'}
    timestamp = {**string, 'format': 'date-time'}
    nullable_string = {**string, 'nullable': True}
    channel = {**string, 'enum': ['in_app', 'email', 'sms', 'whatsapp', 'push']}
    state = {**string, 'enum': ['draft', 'active', 'paused', 'archived']}
    trigger = {**string, 'enum': [
        'visit', 'product_view', 'category_view', 'page_view', 'search',
        'cart.item_added', 'cart.item_removed', 'shopping.proposal_created',
        'shopping.cart_applied', 'checkout', 'purchase', 'order_status',
    ]}

    def text_field(limit, required=False):
        return {**string, 'maxLength': limit,
                **({'minLength': 1, 'pattern': r'\S'} if required else {}),
                'description': f'At most {limit} Unicode characters. The server rejects invalid control characters and applies the character limit before trimming.'}

    condition_operator = {**string, 'enum': ['eq', 'neq', 'gte', 'lte', 'contains']}
    condition_field = {**string, 'enum': ['customer.verified', 'customer.order_count',
        'customer.account_age_days', 'product.name', 'order.status', 'order.total', 'order.currency']}
    schemas['NotificationCondition'] = obj({
        'field': condition_field, 'operator': condition_operator,
        'value': {**string, 'minLength': 1, 'maxLength': 200,
                  'description': 'Typed value encoded as text. verified: true/false with eq; order_count/account_age_days: whole number 0–1000000000 with eq/gte/lte; product.name: case-insensitive eq/contains; order.status: supported recorded workflow state with eq/neq; order.total: exact nonnegative decimal, at most two decimal places and 999999999999.99, with eq/gte/lte; order.currency: uppercase three-letter code with eq. Unknown operators, malformed values, and fields unavailable for the selected trigger are rejected.'},
        'currency': {**string, 'pattern': '^[A-Z]{3}$', 'description': 'Required only for order.total and forbidden for other fields. A different event currency never matches.'},
    }, ['currency'])
    def condition_variant(field, operators, value, money=False):
        variant = {'type': 'object', 'properties': {
            'field': {**string, 'enum': [field]},
            'operator': {**string, 'enum': operators}, 'value': value,
        }}
        if money:
            variant['required'] = ['currency']
        else:
            variant['not'] = {'required': ['currency']}
        return variant

    whole_number = {**string, 'pattern': r'^(0|[1-9][0-9]{0,8}|1000000000)$'}
    currency_code = {**string, 'pattern': '^[A-Z]{3}$'}
    schemas['NotificationCondition']['oneOf'] = [
        condition_variant('customer.verified', ['eq'], {**string, 'enum': ['true', 'false']}),
        condition_variant('customer.order_count', ['eq', 'gte', 'lte'], whole_number),
        condition_variant('customer.account_age_days', ['eq', 'gte', 'lte'], whole_number),
        condition_variant('product.name', ['eq', 'contains'], {**string, 'minLength': 1, 'maxLength': 200, 'pattern': r'\S'}),
        condition_variant('order.status', ['eq', 'neq'], {**string, 'enum': [value for value in schemas['Order']['properties']['status']['enum'] if value != 'placed']}),
        condition_variant('order.total', ['eq', 'gte', 'lte'], {**string, 'pattern': r'^[0-9]+(\.[0-9]{1,2})?$'}, money=True),
        condition_variant('order.currency', ['eq'], currency_code),
    ]
    schemas['NotificationConditions'] = obj({
        'match': {**string, 'enum': ['all', 'any']},
        'rules': {'type': 'array', 'items': ref('NotificationCondition'), 'maxItems': 10},
    })
    schemas['NotificationConditions']['oneOf'] = [
        {'properties': {'match': {**string, 'enum': ['all']}}},
        {'properties': {'match': {**string, 'enum': ['any']}, 'rules': {'type': 'array', 'items': ref('NotificationCondition'), 'minItems': 1}}},
    ]
    schemas['NotificationConditions']['description'] = ('A bounded, non-nested eligibility group. All applies AND; any applies OR. '
        'An empty all group adds no restrictions; an empty any group is invalid. Conditions evaluate the same latest '
        'trigger event as personalization, never an older event selected to make the conditions pass. Missing values '
        'never match, including neq. Current customer facts come from the server. No expressions or SQL are accepted.')
    schemas['NotificationConditionOperator'] = obj({'id': condition_operator, 'label': string})
    schemas['NotificationConditionOption'] = obj({'value': string, 'label': string})
    schemas['NotificationConditionField'] = obj({
        'key': condition_field, 'label': string,
        'type': {**string, 'enum': ['boolean', 'integer', 'text', 'select', 'money']},
        'operators': array('NotificationConditionOperator'), 'options': array('NotificationConditionOption'),
        'triggers': {'type': 'array', 'items': trigger, 'description': 'Empty means every supported trigger.'},
        'description': string,
    })
    schemas['NotificationConditionResult'] = obj({
        'index': integer, 'field': condition_field, 'operator': condition_operator,
        'expected': string, 'actual': nullable_string, 'matched': boolean, 'reason': string,
    })

    program = {
        'name': text_field(120, True), 'description': text_field(1000), 'channel': channel,
        'trigger_kind': trigger, 'title_template': text_field(200, True), 'body_template': text_field(8000, True),
        'status': state, 'delay_minutes': {**integer, 'maximum': 129600, 'description': 'Must be strictly shorter than lookback_days × 1440.'},
        'lookback_days': {**positive, 'maximum': 90},
        'cooldown_hours': {**integer, 'maximum': 2160}, 'suppress_after_purchase': boolean,
        'conditions': ref('NotificationConditions'),
    }
    schemas['NotificationProgramInput'] = obj(program, ['conditions'])
    schemas['NotificationProgramInput']['description'] = (
        'A plain-text notification definition using only allowlisted {{token}} placeholders '
        'returned by metadata. Activation permits manual generation; it does not schedule '
        'background processing or deliver to any channel. Channel is recorded as future delivery intent. '
        'Title and body each allow at most 40 exact placeholders; internal whitespace, unknown tokens, '
        'unbalanced braces and recursive expressions are rejected. Names and titles are single-line; '
        'description and body permit newlines and tabs. Archived programs cannot return to another status. '
        'Omitted conditions on legacy programs default to an empty all group; no migration is required.'
    )
    schemas['NotificationProgramUpdate'] = obj({**program, 'version': positive}, ['conditions'])
    schemas['NotificationProgram'] = obj({
        **program, 'id': uuid, 'version': positive,
        'created_at': timestamp, 'updated_at': timestamp,
    })
    schemas['NotificationProgramList'] = obj({'programs': array('NotificationProgram'), 'total': integer})
    schemas['NotificationChannelMetadata'] = obj({
        'id': channel, 'label': string, 'delivery_enabled': {**boolean, 'enum': [False]},
    })
    schemas['NotificationTriggerMetadata'] = obj({'id': trigger, 'label': string, 'requires_orders': boolean})
    schemas['NotificationTokenMetadata'] = obj({'key': string, 'label': string})
    schemas['NotificationMetadata'] = obj({
        'delivery_mode': {**string, 'enum': ['generation_only']},
        'channels': array('NotificationChannelMetadata'),
        'triggers': array('NotificationTriggerMetadata'),
        'tokens': array('NotificationTokenMetadata'),
        'condition_fields': array('NotificationConditionField'),
    })
    schemas['NotificationPreviewInput'] = obj({
        'program': ref('NotificationProgramInput'), 'customer_id': uuid,
        'program_id': {**uuid, 'nullable': True},
    }, ['program_id'])
    schemas['NotificationPreview'] = obj({
        'title': string, 'body': string, 'event_id': nullable_string,
        'event_kind': nullable_string, 'eligible': boolean,
        'reasons': {'type': 'array', 'items': string},
        'missing_tokens': {'type': 'array', 'items': string},
        'context': {'type': 'object', 'additionalProperties': string},
        'condition_match': {**string, 'enum': ['all', 'any']},
        'conditions_matched': boolean,
        'condition_results': array('NotificationConditionResult'),
    })
    schemas['NotificationGenerateInput'] = obj({
        'customer_id': uuid, 'version': positive,
        'idempotency_key': {**uuid, 'description': 'A non-nil UUID. Scoped to this program and permanently bound to this customer and program version. Reuse for an exact retry; use a new key for a new request.'},
    })
    schemas['GeneratedNotification'] = obj({
        'id': uuid, 'program_id': uuid, 'program_name': string, 'program_version': positive,
        'customer_id': uuid, 'event_id': string, 'channel': channel,
        'title': text_field(2000), 'body': text_field(32000), 'status': {**string, 'enum': ['generated']},
        'created_at': timestamp,
    })
    schemas['NotificationGenerationResult'] = obj({
        'outcome': {**string, 'enum': ['generated', 'suppressed', 'duplicate']},
        'reason': nullable_string, 'record': {**ref('GeneratedNotification'), 'nullable': True},
    })
    schemas['NotificationRecordList'] = obj({'records': array('GeneratedNotification'), 'total': integer})
    schemas['NotificationAuditEvent'] = obj({
        'id': uuid, 'action': string, 'actor_id': {**uuid, 'nullable': True}, 'created_at': timestamp, 'version': positive,
    })
    schemas['NotificationAuditList'] = obj({'events': array('NotificationAuditEvent')})
    schemas['NotificationConflict'] = obj({'error': string, 'code': {**string, 'enum': ['notification_conflict']}})

    base = '/v1/admin/marketing/notifications'
    operations = [
        (base, 'get', 'NotificationProgramList', None, [],
         'List notification programs with server-side search, status filtering and pagination.'),
        (base, 'post', 'NotificationProgram', 'NotificationProgramInput', ['notifications.write'],
         'Create a notification program with a versioned, audited definition.'),
        (base + '/metadata', 'get', 'NotificationMetadata', None, [],
         'Read supported journey triggers, allowlisted template tokens, typed condition fields and disabled delivery channels.'),
        (base + '/preview', 'post', 'NotificationPreview', 'NotificationPreviewInput', ['customers.read', 'orders.read'],
         'Evaluate a candidate against a real customer journey and render plain text. '
         'This performs no persistence or delivery. Include program_id for saved-program cooldown and duplicate checks. '
         'Unsaved programs and non-active programs can be previewed but are never eligible for generation.'),
        (base + '/records', 'get', 'NotificationRecordList', None, ['customers.read', 'orders.read'],
         'Read generated content snapshots, newest first. Generated does not mean queued, sent or delivered.'),
        (base + '/{id}', 'get', 'NotificationProgram', None, [],
         'Read the saved notification program and its current version.'),
        (base + '/{id}', 'put', 'NotificationProgram', 'NotificationProgramUpdate', ['notifications.write'],
         'Update a saved definition only when its version still matches. Increments version and records an audit event.'),
        (base + '/{id}/generate', 'post', 'NotificationGenerationResult', 'NotificationGenerateInput',
         ['customers.read', 'orders.read', 'notifications.generate'],
         'Re-evaluate the saved active program and persist a generated notification only when eligible. '
         'Dynamic all/any conditions against current server facts, delay, lookback, cooldown, post-event purchase suppression, unresolved tokens and duplicate journey events '
         'are checked on the server. Retry an uncertain request with the same idempotency key and exact input. '
         'No provider, queue, webhook or third-party delivery service is called.'),
        (base + '/{id}/audit', 'get', 'NotificationAuditList', None, [],
         'Read paginated program audit events, newest first.'),
    ]
    for path, method, output, body, extra_grants, description in operations:
        endpoint(path, method, output, body, status=201 if path == base and method == 'post' else 200, auth='adminSession')
        operation = paths[path][method]
        operation['tags'] = ['Marketing notifications']
        grants = ['notifications.read', *extra_grants]
        operation['description'] = f'{description} Requires {" and ".join(grants)}. Scope: this merchant installation. All channels are generation only. Request bodies are limited to 64 KiB.'
        for status, message in [
            ('400', 'Program, customer, query, placeholder or generation input is invalid.'),
            ('401', 'Administrator session required.'),
            ('403', 'Required role permission missing.'),
            ('404', 'Program or customer not found.'),
            ('429', 'Notification preview or mutation rate limit exceeded.'),
        ]:
            operation['responses'][status] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}
        if method == 'put' or path.endswith('/generate'):
            operation['responses']['409'] = {
                'description': 'The saved version changed, or the idempotency key was already used with different input. Reload the program before retrying.',
                'content': {'application/json': {'schema': ref('NotificationConflict')}},
            }
    pagination = [
        {'in': 'query', 'name': 'offset', 'schema': {**integer, 'maximum': 100000, 'default': 0}},
        {'in': 'query', 'name': 'limit', 'schema': {**positive, 'maximum': 100, 'default': 25}},
    ]
    paths[base]['get']['parameters'] = [
        {'in': 'query', 'name': 'search', 'schema': text_field(120)},
        {'in': 'query', 'name': 'status', 'schema': state},
        *pagination,
    ]
    paths[base + '/records']['get']['parameters'] = [
        {'in': 'query', 'name': 'program_id', 'schema': uuid}, *pagination,
    ]
    paths[base + '/{id}/audit']['get']['parameters'].extend(pagination)
