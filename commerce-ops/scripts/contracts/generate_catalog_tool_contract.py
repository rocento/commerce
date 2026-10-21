"""Generate the internal shopper tool OpenAPI schemas from the typed registry.
Run with commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_catalog_tool_contract.py.
"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'commerce-assistant-platform'))
from app.commerce_action_engine.actions.catalog import (
    DEFINITIONS,
    CatalogResult,
    SearchArgs,
)

schemas = {}
def convert(value):
    if isinstance(value, list):
        return [convert(v) for v in value]
    if not isinstance(value, dict):
        return value
    value = dict(value)
    value.pop('title', None)
    value.pop('default', None)
    if 'anyOf' in value and any(v.get('type') == 'null' for v in value['anyOf']):
        variants = [v for v in value.pop('anyOf') if v.get('type') != 'null']
        if len(variants) == 1:
            value.update(variants[0])
            value['nullable'] = True
    if '$ref' in value:
        value['$ref'] = '#/components/schemas/Shopper' + value['$ref'].split('/')[-1]
    return {k: convert(v) for k, v in value.items()}

def add(model):
    schema = model.model_json_schema()
    for name, definition in schema.pop('$defs', {}).items():
        schemas['Shopper' + name] = convert(definition)
    name = 'Shopper' + model.__name__
    schemas[name] = convert(schema)
    return {'$ref': '#/components/schemas/' + name}

output = add(CatalogResult)
variants = []
for definition in DEFINITIONS:
    # The model uses closed name/value entries; the HTTP facade still takes a map.
    arguments = SearchArgs if definition.name == 'search_products' else definition.arguments
    variants.append({'type':'object','additionalProperties':False,'required':['name','arguments'],
        'properties':{'name':{'type':'string','enum':[definition.name]}, 'arguments':add(arguments)}})
schemas['ShopperToolRequest'] = {'oneOf':variants}
(root / 'commerce-api/rocento-api/crates/api-gateway/openapi/shopper_tools.json').write_text(
    json.dumps({'schemas':schemas},indent=2,sort_keys=True)+'\n')
