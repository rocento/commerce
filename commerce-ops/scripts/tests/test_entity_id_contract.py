"""The numeric identifier is output metadata, never a UUID replacement."""
import json
from pathlib import Path
import unittest


class EntityIdContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads((Path(__file__).resolve().parents[3] / 'commerce-api/rocento-api/openapi.json').read_text())
        cls.schemas = cls.contract['components']['schemas']

    def test_numeric_identifier_is_bounded_read_only_metadata(self):
        for name in ['Product', 'Customer', 'Admin', 'Role', 'Theme', 'InventorySource', 'StockPool', 'DeliveryArea', 'ContentDocument', 'AttributeDefinition', 'MarketDraft']:
            with self.subTest(schema=name):
                number = self.schemas[name]['properties']['entity_id']
                self.assertEqual(number['type'], 'integer')
                self.assertTrue(number['readOnly'])
                self.assertEqual((number['minimum'], number['maximum']), (1, 9007199254740991))
                self.assertEqual(self.schemas[name]['properties']['id']['format'], 'uuid')

    def test_all_mutation_contracts_exclude_numeric_identifier(self):
        def contains_numeric_id(node, seen):
            if isinstance(node, list):
                return any(contains_numeric_id(value, seen) for value in node)
            if not isinstance(node, dict):
                return False
            if '$ref' in node:
                name = node['$ref'].split('/')[-1]
                if name in seen:
                    return False
                return contains_numeric_id(self.schemas[name], seen | {name})
            return node.get('properties', {}).get('entity_id', {}).get('type') == 'integer' or any(contains_numeric_id(value, seen) for value in node.values())
        for path, methods in self.contract['paths'].items():
            for method, operation in methods.items():
                with self.subTest(path=path, method=method):
                    self.assertFalse(contains_numeric_id(operation.get('requestBody', {}), set()))

    def test_target_references_and_old_snapshots_remain_valid(self):
        self.assertEqual(self.schemas['Audit']['properties']['entity_id']['format'], 'uuid')
        for name in ['Cart', 'Order', 'Location', 'Shipment', 'ManualRefund', 'FulfillmentPlan', 'SnapshotProduct', 'IndustryTemplateDefinition', 'AssistantTicket', 'AssistantTicketMessage', 'AssistantSavedLocation']:
            with self.subTest(schema=name):
                self.assertNotIn('entity_id', self.schemas[name]['required'])
                self.assertTrue(self.schemas[name]['properties']['entity_id']['readOnly'])
        for field in ['product', 'previous']:
            self.assertEqual(self.schemas['BasketProposalLine']['properties'][field], {
                'anyOf': [
                    {'$ref': '#/components/schemas/SnapshotProduct'},
                    {'type': 'object', 'nullable': True, 'enum': [None]},
                ]
            })


if __name__ == '__main__':
    unittest.main()
