"""Additive, server-assigned business entity numbers alongside UUID identities."""
from copy import deepcopy


def extend(schemas, paths):
    # Some older endpoints reuse the output schema for their request body. Keep
    # separate input contracts so server-owned numbers never become writable.
    shared = [
        'AttributeDefinition', 'AttributeSet', 'IndustryTemplateAttribute',
        'IndustryProfile', 'AttributeRelationship', 'FulfillmentSchedule',
        'CapacityRule',
    ]
    for name in shared:
        schemas[name + 'Input'] = deepcopy(schemas[name])
    schemas['IndustryTemplateDefinition'] = deepcopy(schemas['AttributeDefinition'])
    schemas['IndustryTemplateAttribute']['properties']['definition'] = {
        '$ref': '#/components/schemas/IndustryTemplateDefinition'
    }
    schemas['IndustryTemplateAttributeInput']['properties']['definition'] = {
        '$ref': '#/components/schemas/AttributeDefinitionInput'
    }
    schemas['IndustryProfileInput']['properties']['template']['items'] = {
        '$ref': '#/components/schemas/IndustryTemplateAttributeInput'
    }
    for methods in paths.values():
        for operation in methods.values():
            for media in operation.get('requestBody', {}).get('content', {}).values():
                schema = media['schema']
                name = schema.get('$ref', '').removeprefix('#/components/schemas/')
                if name in shared:
                    schema['$ref'] += 'Input'
    schemas['SaveFulfillmentSchedule']['properties']['schedule'] = {
        '$ref': '#/components/schemas/FulfillmentScheduleInput'
    }
    schemas['SaveCapacityRule']['properties']['rule'] = {
        '$ref': '#/components/schemas/CapacityRuleInput'
    }

    number = {
        'type': 'integer', 'format': 'int64', 'minimum': 1,
        'maximum': 9007199254740991, 'readOnly': True,
        'description': 'Server-assigned, immutable entity number unique within this entity type. UUID id remains the API and relationship identity.',
    }

    def add(schema, required=True):
        schema['properties']['entity_id'] = deepcopy(number)
        if required:
            schema.setdefault('required', []).append('entity_id')

    live = [
        'Customer', 'Admin', 'Role', 'Category', 'Attribute', 'Product',
        'Media', 'LibraryMedia', 'MediaFolder', 'CheckoutQuote',
        'TaxRule', 'Promotion', 'ContentDocument', 'ContentRevision',
        'ContentRelease', 'Review', 'OwnReview', 'PublicReview', 'InventorySource',
        'StockPool', 'AttributeDefinition', 'AttributeSet', 'DeliveryArea',
        'Theme', 'ThemeVersion', 'CustomerSegment',
        'EnrichmentSuggestion', 'AttributeRelationship', 'FulfillmentSchedule',
        'CapacityRule', 'CapacityHold', 'ScheduledOrderDelivery', 'TrustAgent',
        'MarketDraft', 'MarketRelease',
    ]
    for name in live:
        add(schemas[name])
    # Locations and plans also occur inside immutable historical checkout data.
    # Older snapshots have no entity number and remain valid to deserialize.
    for name in ['Cart', 'Location', 'FulfillmentLocation', 'ScheduledDelivery', 'FulfillmentPlan', 'Order', 'ManualRefund', 'Shipment', 'IndustryProfile', 'IndustryTemplateDefinition', 'AssistantTicket', 'AssistantTicketMessage', 'AssistantSavedLocation']:
        add(schemas[name], required=False)
    add(schemas['FulfillmentPlan']['properties']['groups']['items'], required=False)
    add(schemas['FulfillmentSettingsView']['properties']['stores']['items'])
    add(schemas['FulfillmentStores']['items'])
    # Admin grid projections retain the number of their underlying product/source.
    for name in ['InventorySummary', 'SourceItem']:
        add(schemas[name], required=False)
    schemas['SnapshotProduct'] = deepcopy(schemas['Product'])
    schemas['SnapshotProduct']['required'].remove('entity_id')
    for field in ['product', 'previous']:
        # Replace the nullable live-product wrapper in full. Adding a $ref as
        # its sibling leaves an ignored, contradictory Product constraint.
        schemas['BasketProposalLine']['properties'][field] = {
            '$ref': '#/components/schemas/SnapshotProduct', 'nullable': True,
        }
