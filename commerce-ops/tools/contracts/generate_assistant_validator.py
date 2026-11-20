"""Export runtime schemas from OpenAPI for validating untrusted SSE data."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[3]
schemas=json.loads((root/'commerce-api/rocento-api/openapi.json').read_text())['components']['schemas']
(root/'commerce-web/packages/api-client/src/assistant-schemas.ts').write_text('// Generated from commerce-api/rocento-api/openapi.json; do not edit.\nexport const assistantSchemas: Record<string, unknown> = '+json.dumps({k:v for k,v in schemas.items() if k.startswith('Assistant')},indent=2)+';\n')
