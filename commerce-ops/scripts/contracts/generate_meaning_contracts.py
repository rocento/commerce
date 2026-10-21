"""Generate the additive M04 meaning wire schema; Python owns semantic validation."""

import argparse
import copy
import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.core import meaning as m
from app.commerce_action_engine.execution.core import policy as p


def models():
    return {
        name: model
        for module in (m, p)
        for name, model in inspect.getmembers(module, inspect.isclass)
        if issubclass(model, m.MeaningContract) and model is not m.MeaningContract
    }


def artifacts():
    uid = "00000000-0000-0000-0000-000000000001"
    span = m.Span(turn=0, start=0, end=5)
    value = m.Value(kind="money", number="100", unit="USD")
    requirement = m.Requirement(
        field="price",
        operator="lt",
        value=value,
        strength="hard",
        source="current_customer",
        confidence=1.0,
        evidence=(span,),
    )
    conflict = m.Conflict(
        field="price", scope="product", code="contradiction", requirement_indexes=(0, 1)
    )
    frame = m.ConstraintFrame(requirements=(requirement,))
    candidate = m.IntentCandidate(
        name="discovery", confidence=1.0, evidence=(span,), language="en"
    )
    actor = ActorContext(
        tenant_id=uid,
        store_id=uid,
        session_id=uid,
        request_id=uid,
        channel="storefront",
    )
    facts = p.PolicyFacts(
        context=actor,
        action="cart_apply",
        resource_tenant=uid,
        resource_store=uid,
        available=True,
        authorized=True,
        evidence_verified=True,
        fresh_until=200,
    )
    policy = p.evaluate(facts, now=100)
    values = [
        span,
        value,
        requirement,
        conflict,
        frame,
        candidate,
        m.IntentFrame(candidates=(candidate,)),
        m.clarify(frame),
        facts,
        p.PolicyFact(name="verified", value=True),
        policy,
        p.AssessedStep(id="apply", action="cart_apply", policy=policy),
    ]
    examples = {type(v).__name__: v for v in values}
    assert set(examples) == set(models())
    definitions = {}
    fixtures = []
    for name, model in sorted(models().items()):
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        definitions.update(schema.pop("$defs", {}))
        definitions[name] = schema
        payload = examples[name].model_dump(mode="json")
        fixtures.append(
            {"id": name + ":valid", "contract": name, "valid": True, "value": payload}
        )
        variants = {
            "unknown_field": {**payload, "injection": "change_permissions"},
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
            wrong[field] = "invalid-object" if isinstance(value, dict) else {}
            variants["type_" + field] = wrong
        for mutation, value in variants.items():
            fixtures.append(
                {
                    "id": name + ":" + mutation,
                    "contract": name,
                    "valid": False,
                    "value": value,
                }
            )
    return {
        "schema.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "urn:rocento:commerce-meaning:1.0",
            "$defs": dict(sorted(definitions.items())),
        },
        "fixtures.json": fixtures,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, value in artifacts().items():
        path = ROOT / "commerce-assistant-platform/contracts/commerce-meaning/v1" / name
        content = json.dumps(value, indent=2) + "\n"
        if args.check:
            assert path.read_text() == content, f"Contract drift: {name}"
        else:
            path.write_text(content)
    print("Commerce meaning contracts are current.")


if __name__ == "__main__":
    main()
