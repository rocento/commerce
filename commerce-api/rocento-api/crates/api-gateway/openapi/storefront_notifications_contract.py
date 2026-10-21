"""Persistent native inbox and explicitly published marketing snapshots."""


def extend(schemas, endpoint, paths):
    def ref(name):
        return {'$ref': f'#/components/schemas/{name}'}

    def obj(properties, optional=()):
        return {'type': 'object', 'properties': properties,
                'required': [key for key in properties if key not in optional],
                'additionalProperties': False}

    def text(maximum):
        return {'type': 'string', 'minLength': 1, 'maxLength': maximum}

    uuid = {'type': 'string', 'format': 'uuid'}
    timestamp = {'type': 'string', 'format': 'date-time'}
    count = {'type': 'integer', 'format': 'int64', 'minimum': 0}
    nullable_time = {**timestamp, 'nullable': True}
    cta = {
        'cta_label': {**text(80), 'nullable': True},
        'cta_path': {**text(300), 'nullable': True, 'description': 'Supported relative storefront path only: /, /search, /cart, /support, /account, /account/orders, /products/{slug}, /categories/{slug}, /pages/{slug}, or /account/orders/{uuid}. No query, fragment, encoded characters, traversal or external destination. Supply together with cta_label or set both to null.'},
    }
    content = {'id': uuid, 'title': text(2000), 'body': text(32000), **cta,
               'published_at': timestamp, 'expires_at': timestamp}
    schemas['StorefrontNotification'] = obj({**content,
        'kind': {'type': 'string', 'enum': ['announcement', 'journey']}, 'read_at': nullable_time})
    schemas['StorefrontNotificationCursor'] = obj({'before': timestamp, 'before_id': uuid})
    schemas['StorefrontNotificationPage'] = obj({
        'items': {'type': 'array', 'items': ref('StorefrontNotification')},
        'unread_count': count, 'snapshot_at': timestamp,
        'next_cursor': {'allOf': [ref('StorefrontNotificationCursor')], 'nullable': True},
        'audience': {'type': 'string', 'enum': ['guest', 'customer']},
    })
    schemas['StorefrontNotificationReadInput'] = obj({'read': {'type': 'boolean'}})
    schemas['StorefrontNotificationReadResult'] = obj({'id': uuid, 'read_at': nullable_time, 'unread_count': count})
    schemas['StorefrontNotificationReadAllInput'] = obj({'through': {**timestamp, 'description': 'The list response snapshot_at. Must not be in the future; later arrivals remain unread.'}})
    schemas['StorefrontNotificationReadAllResult'] = obj({'updated': count, 'unread_count': count})
    areas = {'type': 'array', 'items': uuid, 'maxItems': 100, 'uniqueItems': True, 'description': 'Active delivery area IDs. Empty or omitted means all locations. Targeted announcements require a matching selected delivery pin; unknown locations never match.'}
    product_trigger = {**uuid, 'nullable': True, 'description': 'An active product UUID. When set, deliver once per recipient after a product-view event during the campaign window. Null or omitted keeps broadcast behavior.'}
    audience = {'type': 'string', 'enum': ['all', 'guests', 'customers']}
    journey_triggers = schemas['NotificationProgramInput']['properties']['trigger_kind']['enum']
    schemas['NotificationAudienceRules'] = obj({
        'segment_ids': {'type': 'array', 'items': uuid, 'maxItems': 20, 'uniqueItems': True},
        'segment_match': {'type': 'string', 'enum': ['any', 'all']},
        'trigger_kind': {'type': 'string', 'enum': [None, *journey_triggers], 'nullable': True},
        'conditions': ref('NotificationConditions'),
        'delay_minutes': {**count, 'maximum': 43200, 'description': 'Minimum elapsed minutes after the matching event before delivery is eligible. Must be zero without a trigger.'},
        'lookback_days': {**count, 'minimum': 1, 'maximum': 90, 'description': 'Use the latest matching event within this many days, no earlier than the campaign publication start.'},
        'cooldown_hours': {**count, 'maximum': 2160, 'description': 'Minimum elapsed hours between deliveries to the same recipient. Repeated delivery requires at least one hour.'},
        'max_deliveries': {**count, 'minimum': 1, 'maximum': 100, 'description': 'Maximum deliveries per recipient. Each repeat also requires a distinct matching event; repeated polling never counts as an event.'},
        'suppress_after_purchase': {'type': 'boolean'},
    })
    schemas['NotificationAudienceRules']['description'] = (
        'Structured automatic campaign eligibility evaluated by the isolated engagement worker. '
        'Segments and customer/order conditions require the customers audience; guests and everyone '
        'can use visit and product_view events only. Rules use the existing bounded condition language. '
        'A null trigger selects the audience without an event and requires max_deliveries=1. '
        'Repeated event delivery requires cooldown_hours>=1. Segment membership and customer facts '
        'are resolved by the server, never supplied by the storefront. Missing facts fail closed. '
        'trigger_product_id requires a product_view rule. Everyone/guest visit rules allow one delivery only. '
        'Purchase suppression requires a customers audience and an event. These cross-field rules are '
        'validated by the server before saving or publishing.'
    )
    audience_rules = {'allOf': [ref('NotificationAudienceRules')], 'nullable': True}
    schemas['NotificationPublication'] = obj({**content,
        'trigger_product_id': product_trigger, 'area_ids': areas, 'audience_rules': audience_rules,
        'source_record_id': {**uuid, 'nullable': True}, 'customer_id': {**uuid, 'nullable': True},
        'audience': {'type': 'string', 'enum': ['all', 'guests', 'customers', 'customer']},
        'withdrawn_at': nullable_time, 'version': {**count, 'minimum': 1}, 'created_at': timestamp,
    })
    schemas['NotificationPublicationList'] = obj({'publications': {'type': 'array', 'items': ref('NotificationPublication')}, 'total': count})
    options = {**cta,
        'starts_at': {**timestamp, 'nullable': True, 'description': 'Null publishes now. Otherwise between five minutes ago and 90 days ahead.'},
        'expires_at': {**timestamp, 'description': 'After now and starts_at, at most 90 days after the effective start.'},
        'idempotency_key': uuid,
    }
    schemas['NotificationPublicationOptions'] = obj(options, ('cta_label', 'cta_path', 'starts_at'))
    schemas['NotificationAnnouncementInput'] = obj({
        'title': text(200), 'body': text(8000), 'audience': audience, 'area_ids': areas,
        'trigger_product_id': product_trigger, 'audience_rules': audience_rules, **options,
    }, ('cta_label', 'cta_path', 'starts_at', 'area_ids', 'trigger_product_id', 'audience_rules'))
    schemas['NotificationCampaignAnnouncement'] = obj({
        key: value for key, value in schemas['NotificationAnnouncementInput']['properties'].items()
        if key != 'idempotency_key'
    }, ('cta_label', 'cta_path', 'starts_at', 'area_ids', 'trigger_product_id', 'audience_rules'))
    campaign = {
        'name': text(200), 'description': {'type': 'string', 'maxLength': 2000},
        'announcement': ref('NotificationCampaignAnnouncement'),
        'version': count,
    }
    schemas['NotificationCampaignInput'] = obj(campaign)
    schemas['NotificationCampaignInput']['description'] = (
        'A persistent draft of a native inbox campaign. Creation requires version=0; updates require '
        'the current saved version. Saving does not publish or deliver. Expiry is required and '
        'validated against the effective start (now when starts_at is null); activation revalidates '
        'the window. A published campaign cannot be edited.'
    )
    schemas['NotificationCampaign'] = obj({**campaign,
        'id': uuid, 'version': {**count, 'minimum': 1},
        'status': {'type': 'string', 'enum': ['draft', 'published']},
        'publication_id': {**uuid, 'nullable': True}, 'created_at': timestamp, 'updated_at': timestamp,
    })
    schemas['NotificationCampaignList'] = obj({
        'items': {'type': 'array', 'items': ref('NotificationCampaign')}, 'total': count,
        'offset': {**count, 'maximum': 1000000}, 'limit': {**count, 'minimum': 1, 'maximum': 100},
    })
    schemas['NotificationCampaignActivateInput'] = obj({
        'version': {**count, 'minimum': 1}, 'idempotency_key': uuid,
    })
    schemas['NotificationDeleteResult'] = obj({'id': uuid, 'deleted': {'type': 'boolean'}})
    schemas['NotificationWithdrawInput'] = obj({'version': {**count, 'minimum': 1}})

    schemas['NotificationProductViewInput'] = obj({'product': text(300)})
    schemas['NotificationProductViewResult'] = obj({'delivered': count, 'notification_ids': {'type': 'array', 'items': uuid}, 'queued': {'type': 'boolean'}, 'event_id': uuid}, ('queued', 'event_id'))

    customer_or_guest = [{'customerBearer': []}, {'inboxGuest': []}]
    for path, method, output, body, description in [
        ('/v1/notifications', 'get', 'StorefrontNotificationPage', None,
         'Read active, unexpired, non-withdrawn messages for the server-resolved recipient. Initializes a server-minted HttpOnly inbox_guest cookie for anonymous visitors. Guest announcements contain no customer journey content. Read state is per recipient; signing in never merges guest history. No-store response.'),
        ('/v1/notifications/product-view', 'post', 'NotificationProductViewResult', 'NotificationProductViewInput',
         'Report an active product ID or slug after rendering its page. Requires an established guest inbox cookie (GET the inbox first) or valid customer session. In isolated deployments returns 202 after durable enqueue; the separate worker grants matching campaigns once per recipient; duplicate and concurrent visits are idempotent. Enforces audience, delivery area, start, expiry and withdrawal. Returns only newly delivered publication IDs. No coupon or customer identifiers can be provided by the caller.'),
        ('/v1/notifications/{id}/read', 'put', 'StorefrontNotificationReadResult', 'StorefrontNotificationReadInput',
         'Mark one currently visible notification read or unread for this recipient. Inaccessible, expired and withdrawn identifiers return 404. Requires an existing guest inbox cookie or valid customer bearer.'),
        ('/v1/notifications/read-all', 'post', 'StorefrontNotificationReadAllResult', 'StorefrontNotificationReadAllInput',
         'Mark currently visible notifications read through a prior server snapshot. Messages published after through remain unread. Requires an existing guest inbox cookie or valid customer bearer.'),
    ]:
        endpoint(path, method, output, body)
        operation = paths[path][method]
        operation['tags'] = ['Storefront notifications']
        operation['security'] = customer_or_guest + ([{}] if method == 'get' else [])
        operation['description'] = description + ' A supplied invalid bearer fails authentication; it never falls back to a guest. Customer ownership is derived from the session, never request data.'
        for status, message in [('400', 'Invalid filter, cursor, body or future read cutoff.'), ('401', 'Invalid customer credential or missing guest inbox session.'), ('403', 'Request marker or browser origin rejected.'), ('404', 'Notification is not currently visible to this recipient.'), ('429', 'Inbox rate limit exceeded.')]:
            operation['responses'][status] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}
    paths['/v1/notifications/product-view']['post']['responses']['202'] = {'description': 'Durably queued in the isolated engagement database. Worker matching is asynchronous; refresh the inbox for delivered offers.', 'content': {'application/json': {'schema': ref('NotificationProductViewResult')}}}
    paths['/v1/notifications']['get']['parameters'] = [
        {'in': 'query', 'name': 'filter', 'schema': {'type': 'string', 'enum': ['all', 'unread'], 'default': 'all'}},
        {'in': 'query', 'name': 'limit', 'schema': {**count, 'minimum': 1, 'maximum': 50, 'default': 20}},
        {'in': 'query', 'name': 'before', 'schema': timestamp, 'description': 'Use together with before_id from next_cursor.'},
        {'in': 'query', 'name': 'before_id', 'schema': uuid, 'description': 'Use together with before from next_cursor.'},
    ]

    base = '/v1/admin/marketing/notifications'
    for path, method, output, body, grants, description in [
        (base + '/publications', 'get', 'NotificationPublicationList', None, [],
         'Read immutable storefront publication snapshots, newest first. Targeted customer records and their counts are omitted unless the administrator also has customers.read and orders.read.'),
        (base + '/publications', 'post', 'NotificationPublication', 'NotificationAnnouncementInput', ['notifications.publish'],
         'Publish a plain-text announcement for everyone, guests or signed-in customers, optionally with automatic audience rules. Customer-specific rules additionally require customers.read and orders.read. Unresolved template tokens are rejected. Scheduling and expiry are enforced on every inbox read.'),
        (base + '/records/{id}/publish', 'post', 'NotificationPublication', 'NotificationPublicationOptions', ['notifications.publish', 'customers.read', 'orders.read'],
         'Publish an existing generated in_app record only to the customer captured in that record. Copies its immutable rendered content. The caller cannot override the recipient or body. Other channels cannot be published to the native inbox.'),
        (base + '/publications/{id}', 'delete', 'NotificationDeleteResult', 'NotificationWithdrawInput', ['notifications.publish'],
         'Delete from admin history and withdraw from all inboxes, retaining internal audit and idempotency records. Requires the current version; repeated deletion succeeds. Targeted messages also require customers.read and orders.read.'),
        (base + '/publications/{id}/withdraw', 'post', 'NotificationPublication', 'NotificationWithdrawInput', ['notifications.publish'],
         'Withdraw a publication using its current version. Targeted publications additionally require customers.read and orders.read. Subsequent inbox reads and receipt mutations exclude the withdrawn message.'),
    ]:
        creates = method == 'post' and not path.endswith('/withdraw')
        endpoint(path, method, output, body, status=201 if creates else 200, auth='adminSession')
        operation = paths[path][method]
        operation['tags'] = ['Marketing notifications']
        operation['description'] = description + f' Requires {" and ".join(["notifications.read", *grants])}. Scope: this merchant installation. Publishing and withdrawal are audited transactionally. No external delivery provider is called.'
        if creates:
            operation['responses']['200'] = {'description': 'Idempotent replay of the existing publication.', 'content': {'application/json': {'schema': ref('NotificationPublication')}}}
            operation['description'] += ' Reuse the same idempotency key and input after an uncertain response. A key reused with changed input returns 409.'
        for status, message in [('400', 'Invalid content, channel, CTA or publication window.'), ('401', 'Administrator session required.'), ('403', 'Required permission, request marker or allowed origin missing.'), ('404', 'Record or publication not found.'), ('409', 'Version changed, record already published, or idempotency key reused with changed input.'), ('429', 'Publication mutation rate limit exceeded.')]:
            operation['responses'][status] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}
    paths[base + '/publications']['get']['parameters'] = [
        {'in': 'query', 'name': 'search', 'schema': text(200), 'description': 'Case-insensitive literal title or body search before pagination.'},
        {'in': 'query', 'name': 'status', 'schema': {'type': 'string', 'enum': ['all', 'live', 'scheduled', 'expired', 'withdrawn'], 'default': 'all'}},
        {'in': 'query', 'name': 'offset', 'schema': {**count, 'maximum': 100000, 'default': 0}},
        {'in': 'query', 'name': 'limit', 'schema': {**count, 'minimum': 1, 'maximum': 100, 'default': 25}},
    ]

    for path, method, output, body, status, description in [
        (base + '/campaigns', 'get', 'NotificationCampaignList', None, 200,
         'List saved campaign drafts and published campaigns. Customer-specific campaigns and their counts are hidden without customers.read and orders.read.'),
        (base + '/campaigns', 'post', 'NotificationCampaign', 'NotificationCampaignInput', 201,
         'Save a new campaign draft with version=0. Requires notifications.write. Saving does not deliver any messages.'),
        (base + '/campaigns/{id}', 'get', 'NotificationCampaign', None, 200,
         'Read a saved campaign with its audience rules and current optimistic version.'),
        (base + '/campaigns/{id}', 'put', 'NotificationCampaign', 'NotificationCampaignInput', 200,
         'Update an unpublished campaign using its current version. Requires notifications.write. Published campaigns cannot be edited.'),
        (base + '/campaigns/{id}/activate', 'post', 'NotificationPublication', 'NotificationCampaignActivateInput', 201,
         'Publish the saved campaign snapshot after revalidating its audience and publication window. Requires notifications.publish. Reuse the same idempotency key and version after an uncertain response. A replay returns the existing publication; changed input or version returns 409.'),
    ]:
        endpoint(path, method, output, body, status=status, auth='adminSession')
        operation = paths[path][method]
        operation['tags'] = ['Marketing notifications']
        operation['description'] = description + (
            ' Requires notifications.read. Customer-specific rules additionally require customers.read and orders.read. '
            'Scope: this merchant installation. Campaigns, jobs and delivery grants use isolated engagement storage. '
            'No external delivery provider is called.'
        )
        if path.endswith('/activate'):
            operation['responses']['200'] = {'description': 'Idempotent replay of the existing campaign publication.', 'content': {'application/json': {'schema': ref('NotificationPublication')}}}
        for error_status, message in [('400', 'Invalid content, audience rules, version or publication window.'), ('401', 'Administrator session required.'), ('403', 'Required permission, request marker or allowed origin missing.'), ('404', 'Campaign not found or inaccessible.'), ('409', 'Campaign version changed, campaign already published or idempotency input changed.'), ('429', 'Campaign request rate limit exceeded.')]:
            operation['responses'][error_status] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}
    paths[base + '/campaigns']['get']['parameters'] = [
        {'in': 'query', 'name': 'search', 'schema': text(200)},
        {'in': 'query', 'name': 'status', 'schema': {'type': 'string', 'enum': ['all', 'draft', 'published'], 'default': 'all'}},
        {'in': 'query', 'name': 'offset', 'schema': {**count, 'maximum': 1000000, 'default': 0}},
        {'in': 'query', 'name': 'limit', 'schema': {**count, 'minimum': 1, 'maximum': 100, 'default': 20}},
    ]

    for path, method in [('/v1/notifications/product-view', 'post'), ('/v1/notifications', 'get'), ('/v1/notifications/{id}/read', 'put'), ('/v1/notifications/read-all', 'post')]:
        paths[path][method].setdefault('parameters', []).extend([
            {'name': 'x-delivery-latitude', 'in': 'header', 'required': False, 'schema': {'type': 'number', 'minimum': -90, 'maximum': 90}, 'description': 'Selected delivery latitude; supply both coordinates for area-targeted announcements.'},
            {'name': 'x-delivery-longitude', 'in': 'header', 'required': False, 'schema': {'type': 'number', 'minimum': -180, 'maximum': 180}, 'description': 'Selected delivery longitude; supply both coordinates.'},
        ])
