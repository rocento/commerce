"""Generate additive executable-planning wire contracts and shared fixtures."""

import argparse
import copy
import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Contract,
    DefinitionRef,
)
from app.commerce_action_engine.execution.core import planning as p
from app.commerce_action_engine.execution.planning.library import document, library


def models():
    return {
        name: model
        for name, model in inspect.getmembers(p, inspect.isclass)
        if model.__module__ == p.__name__ and issubclass(model, Contract)
    }


def artifacts():
    uid = "00000000-0000-0000-0000-000000000001"
    context = ActorContext(
        tenant_id=uid,
        store_id=uid,
        session_id=uid,
        request_id=uid,
        channel="evaluation",
    )
    data = document()
    plan = library().compile(
        DefinitionRef(id=data.procedures[0].id, version="1.0.0"),
        context,
        capabilities=frozenset(port for s in data.skills for port in s.ports),
        available_context=frozenset(),
    )
    values = [
        data.skills[0],
        data.procedures[0].nodes[0],
        data.procedures[0],
        p.PlanningBudget(),
        p.PlanResources(),
        plan,
        data.industries[0],
    ]
    examples = {type(v).__name__: v for v in values}
    assert set(examples) == set(models())
    definitions, fixtures = {}, []
    for name, model in sorted(models().items()):
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        definitions.update(schema.pop("$defs", {}))
        definitions[name] = schema
        payload = examples[name].model_dump(mode="json")
        fixtures.append(
            {"id": name + ":valid", "contract": name, "valid": True, "value": payload}
        )
        variants = {
            "unknown_field": {**payload, "tool": "arbitrary_unregistered"},
            "future_version": {**payload, "schema_version": "99.0"},
        }
        for field in schema.get("required", []):
            missing = copy.deepcopy(payload)
            del missing[field]
            variants["missing_" + field] = missing
        for field, value in payload.items():
            if value is None or field == "schema_version":
                continue
            wrong = copy.deepcopy(payload)
            wrong[field] = "wrong-object" if isinstance(value, dict) else {}
            variants["type_" + field] = wrong
        fixtures.extend(
            {
                "id": name + ":" + mutation,
                "contract": name,
                "valid": False,
                "value": value,
            }
            for mutation, value in variants.items()
        )
    return {
        "schema.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "urn:rocento:commerce-planning:1.0",
            "$defs": dict(sorted(definitions.items())),
        },
        "fixtures.json": fixtures,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, value in artifacts().items():
        path = ROOT / "commerce-assistant-platform/contracts/commerce-planning/v1" / name
        content = json.dumps(value, indent=2) + "\n"
        if args.check:
            assert path.read_text() == content, f"Contract drift: {name}"
        else:
            path.write_text(content)
    print("Commerce planning contracts are current.")


if __name__ == "__main__":
    main()
