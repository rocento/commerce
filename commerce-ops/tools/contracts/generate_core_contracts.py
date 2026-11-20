"""Export strict internal JSON Schema and common wire fixtures, or check for drift."""

import argparse
import copy
import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.contracts import action as c
from app.commerce_action_engine.contracts import ports


def models():
    return {
        name: model
        for module in (c, ports)
        for name, model in inspect.getmembers(module, inspect.isclass)
        if issubclass(model, c.Contract) and model is not c.Contract
    }


def examples():
    uid = "00000000-0000-0000-0000-000000000001"
    actor = c.ActorContext(
        tenant_id=uid,
        store_id=uid,
        session_id=uid,
        request_id=uid,
        channel="storefront",
    )
    fresh = c.Freshness(observed_at=100, expires_at=200)
    evidence = c.EvidenceRef(
        source_kind="catalog",
        source_id="product/one",
        source_version="v1",
        freshness=fresh,
        display="cite",
    )
    candidate = c.IntentCandidate(
        name="discovery", confidence=0.95, provenance="explicit", evidence=(evidence,)
    )
    intent = c.Intent(goal="Find coffee", selected=candidate)
    constraint = c.Constraint(
        field="price",
        operator="lte",
        values=(10,),
        strength="hard",
        source="customer",
        scope="product",
        evidence=evidence,
    )
    constraints = c.ConstraintSet(constraints=(constraint,))
    action = c.ActionEnvelope(
        context=actor, risk=c.Risk.R0, confirmation=c.Confirmation.NONE, expires_at=200
    )
    ref = c.DefinitionRef(id="skill://catalog/search", version="1.0.0")
    skill = c.SkillDefinition(
        id=ref.id,
        version=ref.version,
        input_contract="core://search/query",
        output_contract="core://search/result",
    )
    failure = c.TypedFailure(
        category=c.FailureCategory.RETRYABLE,
        code="provider_timeout",
        request_id=uid,
        recovery="retry",
    )
    result = c.SkillResult(skill=ref, status="succeeded", evidence=(evidence,))
    playbook = c.PlaybookDefinition(
        id="playbook://shopping/discovery",
        version="1.0.0",
        journey="discovery",
        steps=(ref,),
    )
    playbook_ref = c.DefinitionRef(id=playbook.id, version=playbook.version)
    step = c.PlanStep(id="search", skill=ref)
    product = ports.ProductFact(
        product_id=uid,
        name="Coffee",
        price="6.00",
        currency="USD",
        in_stock=True,
        evidence=evidence,
    )
    values = [
        actor,
        fresh,
        evidence,
        candidate,
        intent,
        constraint,
        constraints,
        action,
        ref,
        c.Visibility(),
        c.Metadata(id="skill://catalog/search", version="1.0.0"),
        skill,
        c.SkillInput(skill=ref, action=action, intent=intent, constraints=constraints),
        failure,
        result,
        playbook,
        c.PolicyDefinition(
            id="policy://commerce/authority",
            version="1.0.0",
            reason_codes=("rust_authoritative",),
        ),
        c.IndustryPack(id="industry://commerce/common", version="1.0.0"),
        c.ProviderCapabilities(
            id="provider://reasoning/default",
            version="1.0.0",
            profile="default",
            structured_output=True,
            tool_calling=True,
            streaming=True,
            vision=False,
            max_context_tokens=32000,
            usage_reporting=True,
        ),
        c.ModelRequirements(),
        c.PolicyInput(action=action, constraints=constraints),
        c.PolicyDecision(
            policy=c.DefinitionRef(id="policy://commerce/authority", version="1.0.0"),
            outcome="allow",
            reasons=("rust_authoritative",),
        ),
        c.Budget(),
        step,
        c.ExecutionPlan(goal_id=uid, playbook=playbook_ref, steps=(step,)),
        c.Observation(step_id="search", result=result, observed_at=100),
        c.VerificationReport(
            goal_id=uid,
            status="verified",
            constraints_satisfied=True,
            policies_satisfied=True,
            evidence_fresh=True,
            action_ready=True,
        ),
        c.ExecutionState(step_id="search"),
        c.GoalState(id=uid, context=actor),
        c.DecisionTrace(
            request_id=uid,
            tenant_id=uid,
            store_id=uid,
            journey="discovery",
            path="core",
            reason="core_selected",
            versions=(ref,),
        ),
        ports.SearchQuery(text="coffee"),
        product,
        ports.SearchResult(products=(product,)),
        ports.CommerceSnapshot(id=uid, revision=1, evidence=(evidence,)),
    ]
    return {type(value).__name__: value for value in values}


def artifacts():
    definitions = {}
    for name, model in models().items():
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        definitions.update(schema.pop("$defs", {}))
        definitions[name] = schema
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:rocento:commerce-core:1.0",
        "$defs": dict(sorted(definitions.items())),
    }
    fixtures = []
    valid = examples()
    assert set(valid) == set(models()), "Every contract needs a compatibility example"
    for name, value in sorted(valid.items()):
        payload = value.model_dump(mode="json")
        fixtures.append(
            {"id": name + ":valid", "contract": name, "valid": True, "value": payload}
        )
        variants = {
            "unknown_field": {**payload, "untrusted": "must-reject"},
            "future_version": {**payload, "schema_version": "999.0"},
        }
        for field in definitions[name].get("required", []):
            missing = copy.deepcopy(payload)
            del missing[field]
            variants["missing_" + field] = missing
        for field, field_value in payload.items():
            if field == "schema_version" or field_value is None:
                continue
            invalid = copy.deepcopy(payload)
            invalid[field] = {} if not isinstance(field_value, dict) else "wrong-object"
            variants["wrong_type_" + field] = invalid
        for mutation, data in variants.items():
            fixtures.append(
                {
                    "id": name + ":" + mutation,
                    "contract": name,
                    "valid": False,
                    "value": data,
                }
            )
    # Edge cases catch inclusive bounds, UUID syntax, scalar coercion, enums,
    # nested unknown properties and negative numbers in every language.
    for name, field, value in [
        ("Budget", "max_steps", 17),
        ("Budget", "max_steps", 0),
        ("Budget", "max_steps", True),
        ("Budget", "max_steps", "2"),
        ("Budget", "max_steps", 1.5),
        ("Budget", "timeout_ms", -1),
        ("ActorContext", "request_id", "not-a-uuid"),
        ("GoalState", "status", "done"),
        ("DefinitionRef", "version", "latest"),
        ("IntentCandidate", "confidence", 1.01),
        ("IntentCandidate", "confidence", -0.01),
        ("SearchQuery", "text", ""),
        ("SearchQuery", "text", "x" * 201),
        (
            "SearchResult",
            "products",
            [valid["ProductFact"].model_dump(mode="json")] * 6,
        ),
        ("ProductFact", "currency", "usd"),
    ]:
        payload = valid[name].model_dump(mode="json")
        payload[field] = value
        fixtures.append(
            {
                "id": f"edge:{len(fixtures)}:{name}.{field}",
                "contract": name,
                "valid": False,
                "value": payload,
            }
        )
    return {"schema.json": schema, "fixtures.json": fixtures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output = ROOT / "commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1"
    output.mkdir(parents=True, exist_ok=True)
    for filename, value in artifacts().items():
        content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        path = output / filename
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"Contract generation drift: {path.relative_to(ROOT)}")
        else:
            path.write_text(content)
    print("Commerce core schema and wire fixtures are current.")


if __name__ == "__main__":
    main()
