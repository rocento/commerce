"""Explicitly rebaseline contract snapshots; never invoked by pytest."""

import json
import subprocess
import sys
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
SERVICE = DIRECTORY.parents[2]
sys.path.insert(0, str(SERVICE))

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)

ENGINE_CAPTURE = """
import {compile} from './src/compiler.ts';
import {buildExpandedDictionary} from './src/generation/dictionary.ts';
import {resolve} from './src/engine.ts';
const runtime = compile(buildExpandedDictionary());
const cases = [
  ['search', 'show me black Adidas running shoes under $150 size 43', 'RESOLVED'],
  ['compound', 'add two apples and one milk then checkout', 'RESOLVED'],
  ['needs_context', 'pls add two product to cart', 'NEEDS_CONTEXT'],
  ['address_reference', 'create an order for two apples and deliver it there', 'NEEDS_CONTEXT'],
  ['ambiguous', 'find apple', 'AMBIGUOUS'],
  ['unknown', 'purple elephants', 'UNKNOWN'],
];
const fixtures = cases.map(([name, text, expected]) => {
  const response = resolve(runtime, text, {});
  if (response.status !== expected) throw new Error(`${name}: ${response.status}`);
  return {name, text, context: {}, response};
});
const context = fixtures.find(f => f.name === 'needs_context').response.context.next;
const response = resolve(runtime, 'fish', context);
if (response.status !== 'RESOLVED') throw new Error('Context follow-up did not resolve');
fixtures.push({name: 'context_followup', text: 'fish', context, response});
console.log(JSON.stringify(fixtures));
"""


def main():
    captured = subprocess.run(
        ["node", "--input-type=module", "-e", ENGINE_CAPTURE],
        cwd=SERVICE / "app/commerce_language_engine",
        check=True,
        capture_output=True,
        text=True,
    )
    snapshots = {"legacy-engine-fixtures.json": json.loads(captured.stdout)}
    for model in (TurnContext, InterpretedRequest, InterpretationFailure):
        snapshots[f"{model.__name__}.schema.json"] = model.model_json_schema(
            by_alias=True
        )
    schemas = json.loads((SERVICE.parent / "backend/openapi.json").read_text())[
        "components"
    ]["schemas"]
    snapshots["public-assistant-v1.json"] = {
        name: schema for name, schema in schemas.items() if name.startswith("Assistant")
    }
    for name, snapshot in snapshots.items():
        (DIRECTORY / name).write_text(json.dumps(snapshot, indent=2) + "\n")


if __name__ == "__main__":
    main()
