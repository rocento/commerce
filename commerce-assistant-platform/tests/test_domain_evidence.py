"""Frozen Phase 3 scenarios: synthetic facts, real resolver/admission/shopping flow."""

import asyncio
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import TENANT, WHO, Provider, interpreted, product

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.domain_evidence.assessment import (
    assess,
    product_identity,
)
from app.commerce_action_engine.actions.domain_evidence.contracts import (
    DomainPack,
    ProductFact,
    Requirement,
)
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)

ROOT = Path(__file__).resolve().parents[2]
PACK_PATH = ROOT / "commerce-assistant-platform/data/domain-evidence/electronics-v1.json"
PACK = DomainPack.model_validate_json(PACK_PATH.read_text())
NOW = datetime(2026, 10, 10, 12, tzinfo=UTC)
HD = next(p for p in PACK.profiles if p.id == "shotcut-windows11-hd")
ZOOM = next(p for p in PACK.profiles if p.id == "zoom-windows11-basic-video")


def sample(profile=HD, **changes):
    attributes, definitions = [], []
    for req in profile.requirements:
        value = req.value[0] if req.operator == "one_of" else req.value
        attributes.append(
            {"name": req.attribute, "value": json.dumps(value), "source": "VERIFIED"}
        )
        definition = schema_attribute(
            req.attribute,
            "number"
            if type(value) in (int, float)
            else "boolean"
            if type(value) is bool
            else "text",
            filterable=False,
        )
        definition["unit"] = req.unit
        definitions.append(definition)
    p = Product(
        **product(
            name="Fixture laptop X1",
            price="70",
            category="Laptops",
            sku="TEST-X1",
            attributes=attributes,
            **changes,
        )
    )
    schema = CatalogSchema(**catalog_schema("electronics", definitions))
    facts = tuple(
        ProductFact(
            id=uuid4(),
            tenant_id=TENANT,
            product_id=p.id,
            identity_sha256=product_identity(p),
            attribute=a.name,
            value=json.loads(a.value),
            unit=next(r.unit for r in profile.requirements if r.attribute == a.name),
            source_kind="manufacturer",
            source_url="https://manufacturer.example/specs/test-x1",
            source_document_id="synthetic-fixture-specification",
            reviewed_at="2026-10-10T00:00:00Z",
            recheck_at="2026-11-09T00:00:00Z",
            review_method="human",
            reviewer="synthetic-test-reviewer",
        )
        for a in p.attributes
    )
    return p, schema, facts


def changed_ram(p, facts, value):
    p = p.model_copy(deep=True)
    next(a for a in p.attributes if a.name == "ram").value = json.dumps(value)
    facts = tuple(
        f.model_copy(update={"value": value}) if f.attribute == "ram" else f
        for f in facts
    )
    return p, facts


@pytest.mark.parametrize(
    "case,expected",
    [
        ("P3-003", "verified"),
        ("P3-004", "unmet"),
        ("P3-005", "unknown"),
        ("P3-006", "unknown"),
        ("P3-007", "unknown"),
        ("P3-008", "unknown"),
        ("P3-009", "unknown"),
        ("P3-010", "unknown"),
        ("P3-011", "unknown"),
        ("P3-012", "unknown"),
        ("P3-013", "unknown"),
        ("P3-014", "unknown"),
        ("P3-015", "unknown"),
        ("P3-016", "unknown"),
        ("P3-023", "verified"),
    ],
)
def test_locked_assessment_cases(case, expected):
    profile = ZOOM if case == "P3-023" else HD
    p, schema, facts = sample(profile)
    pack = PACK
    if case == "P3-004":
        p, facts = changed_ram(p, facts, 4)
    if case == "P3-005":
        p.attributes = [a for a in p.attributes if a.name != "ram"]
    if case == "P3-006":
        p.attributes.append(
            next(a for a in p.attributes if a.name == "ram").model_copy(
                update={"value": "4"}
            )
        )
    if case == "P3-007":
        facts = tuple(
            f.model_copy(update={"recheck_at": NOW}) if f.attribute == "ram" else f
            for f in facts
        )
    if case == "P3-008":
        pack = PACK.model_copy(
            update={
                "sources": tuple(
                    s.model_copy(update={"recheck_at": NOW}) for s in PACK.sources
                )
            }
        )
    if case == "P3-009":
        pack = PACK.model_copy(
            update={
                "sources": tuple(
                    s.model_copy(update={"state": "conflicted"}) for s in PACK.sources
                )
            }
        )
    if case == "P3-010":
        facts = tuple(f.model_copy(update={"tenant_id": UUID(int=88)}) for f in facts)
    if case == "P3-011":
        facts = tuple(f.model_copy(update={"product_id": UUID(int=88)}) for f in facts)
    if case == "P3-012":
        p.sku = "DIFFERENT-VARIANT"
    if case == "P3-013":
        next(a for a in p.attributes if a.name == "ram").source = "AI_INFERRED"
    if case == "P3-014":
        next(d for d in schema.attributes if d.code == "ram").unit = "MB"
    if case == "P3-015":
        next(a for a in p.attributes if a.name == "ram").value = "1e9999"
    if case == "P3-016":
        next(a for a in p.attributes if a.name == "ram").value = "16"
    result = assess(pack, profile, p, schema, facts, TENANT, NOW)
    assert result.status == expected
    assert result == assess(
        pack, profile, p, schema, tuple(reversed(facts)), TENANT, NOW
    )
    if expected == "verified":
        assert all(c.source_ids and c.evidence_ids for c in result.checks)
    if case == "P3-023":
        assert "internet connection" in profile.limitations


def test_contract_validation_source_integrity_and_lock():
    locked = (
        ROOT
        / "output/enterprise-knowledge-phase3-20261010/validation-expectations.json"
    )
    assert (
        hashlib.sha256(locked.read_bytes()).hexdigest()
        == "ab99f9a475ceff2fd9de0cf8666aae20d365dfb766378f104dd7a5f42d8c4e97"
    )
    for source in PACK.sources:
        assert (
            hashlib.sha256(
                (locked.parent / source.document_ref).read_bytes()
            ).hexdigest()
            == source.document_sha256
        )
    for changes in [
        {"operator": "eval"},
        {"operator": "gte", "value": True},
        {"value": float("inf")},
        {"unit": None},
    ]:
        with pytest.raises(ValueError):
            Requirement.model_validate({**HD.requirements[3].model_dump(), **changes})
    data = PACK.model_dump(mode="json")
    data["profiles"][0]["requirements"][0]["source_ids"] = ["invented"]
    with pytest.raises(ValueError):
        DomainPack.model_validate(data)


@pytest.fixture(scope="module")
def node_results():
    texts = [
        "I need a laptop for video editing and my limit is $75.",
        "I need a laptop for online classes and my limit is $40.",
        "I need a laptop for video editing and online classes under $75.",
    ]
    engine = ROOT / "commerce-assistant-platform/app/commerce_language_engine"
    script = """import {readFileSync} from 'node:fs'; import {compile} from './src/compiler.ts'; import {resolve} from './src/engine.ts';
const pack=JSON.parse(readFileSync('data/knowledge/shopping-en-phase2-v2.json'));
const e=compile({...JSON.parse(readFileSync('data/compiled.json')),languageKnowledge:pack});
console.log(JSON.stringify({pack,cases:JSON.parse(process.argv[1]).map(text=>({text,result:resolve(e,text)}))}));"""
    return json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script, json.dumps(texts)], cwd=engine
        )
    )


@pytest.fixture
def admitted(node_results, tmp_path, monkeypatch):
    path = tmp_path / "compiled.json"
    path.write_text(json.dumps({"languageKnowledge": node_results["pack"]}))
    monkeypatch.setattr(context_module, "_COMPILED_KNOWLEDGE", path)
    return [
        (c["text"], interpreted(gate.Resolution.model_validate(c["result"])))
        for c in node_results["cases"]
    ]


class Reader:
    def __init__(self, facts=(), pack=PACK):
        self.facts, self.pack, self.calls = facts, pack, []

    async def active_pack(self, tenant):
        assert tenant == TENANT
        self.calls.append(("pack", tenant))
        return self.pack

    async def product_facts(self, tenant, products):
        assert tenant == TENANT
        self.calls.append(("facts", tenant, products))
        return self.facts


async def run_shopping(
    message,
    interpretation=None,
    *,
    resume=None,
    question=None,
    reader=None,
    products=None,
    schema=None,
    raw_plan=None,
):
    p, default_schema, facts = sample()
    reader = reader or Reader(facts)
    calls = []
    provider = Provider(raw_plan or {})
    agent = default_agents(TENANT).load(TENANT, "shopper")

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": (schema or default_schema).model_dump(
                        mode="json"
                    ),
                    "default_currency": "USD",
                },
            )
        return httpx.Response(
            200,
            json={
                "products": [
                    v.model_dump(mode="json")
                    for v in (products if products is not None else [p])
                ],
                "category": None,
            },
        )

    async with httpx.AsyncClient(
        base_url="http://assistant-tools:8081", transport=httpx.MockTransport(handler)
    ) as client:
        tools = {
            t.definition.name: t for t in registry(client, "catalog-token", WHO, {})
        }
        result = await shopping_answer(
            message,
            provider,
            agent,
            WHO,
            tools,
            interpretation=interpretation,
            shopping_resume=resume,
            shopping_resume_revision=(
                question.descriptor_revision if question else None
            ),
            shopping_resume_question=question,
            domain_evidence=reader,
        )
    return result, calls, provider.requests


@pytest.mark.parametrize("index,limit", [(0, "75"), (1, "40")])
def test_p3_001_002_real_interpretation_clarifies_before_search(admitted, index, limit):
    message, request = admitted[index]
    result, calls, models = asyncio.run(run_shopping(message, request))
    assert result.pending_shopping.field == "domain_profile"
    assert result.pending_shopping.frame.max_price == limit
    assert result.pending_shopping.frame.currency == "USD"
    assert len(calls) == 1 and calls[0]["name"] == "get_catalog_schema"
    assert not models


def confirmed(admitted, index=0, profile=HD):
    result, _, _ = asyncio.run(run_shopping(*admitted[index]))
    question = result.pending_shopping
    reply = resolve_shopping_reply(question, profile.label)
    assert (
        reply.frame and reply.frame.domain_profile == f"{PACK.fingerprint}:{profile.id}"
    )
    return reply.frame, question


@pytest.mark.parametrize(
    "case", ["verified", "P3-017", "P3-018", "P3-019", "missing", "P3-020"]
)
def test_confirmed_flow_citations_and_hard_constraints(admitted, case, monkeypatch):
    from app.commerce_action_engine.application.shopping_flow import domain

    traces = []
    monkeypatch.setattr(
        domain, "debug_record", lambda stage, data: traces.append((stage, data))
    )
    frame, question = confirmed(admitted)
    p, _schema, facts = sample()
    products = [p]
    if case == "P3-017":
        p.price = "76"
        frame.alternatives = True
    if case == "P3-018":
        p.currency = "EUR"
        frame.alternatives = True
    if case == "P3-019":
        products = []
    if case == "missing":
        facts = ()
    if case == "P3-020":
        frame.domain_profile = "a" * 64 + ":shotcut-windows11-hd"
    result, calls, models = asyncio.run(
        run_shopping(
            HD.label,
            resume=frame,
            question=question,
            reader=Reader(facts),
            products=products,
        )
    )
    assert not models
    cards = [p for b in result.blocks for p in b.products or []]
    if case == "verified":
        assert "Verified against this hardware profile" in result.text
        assert HD.label in " ".join(cards[0].reasons)
        assessment = traces[-1][1]["assessments"][0]
        assert (
            assessment["profile_id"] == HD.id
            and assessment["release"] == PACK.fingerprint
        )
        assert str(facts[0].id) in {
            e for c in assessment["checks"] for e in c["evidence_ids"]
        }
        assert all(c["source_ids"] for c in assessment["checks"])
        assert "shotcut.org/FAQ" in result.text
    elif case == "missing":
        assert "Unknown: evidence" in result.text and "unsuitable" not in result.text
    elif case == "P3-020":
        assert result.pending_shopping and len(calls) == 1
    else:
        assert not cards and "kept your budget unchanged" in result.text
    searches = [c["arguments"] for c in calls if c["name"] == "search_products"]
    assert all(s["max_price"] == "75" and s["currency"] == "USD" for s in searches)


def test_p3_021_fresh_model_profile_is_never_admitted():
    result, calls, _ = asyncio.run(
        run_shopping(
            "laptop for video editing under $75",
            raw_plan={
                "query": "laptop",
                "intended_use": "video_editing",
                "max_price": "75",
                "currency": "USD",
                "domain_profile": f"{PACK.fingerprint}:{HD.id}",
            },
        )
    )
    assert result.pending_shopping and len(calls) == 1


def test_p3_022_multiple_uses_cannot_receive_partially_verified_label(admitted):
    result, calls, models = asyncio.run(run_shopping(*admitted[2]))
    assert "all your intended uses" in result.text
    assert not result.blocks and len(calls) == 1 and not models


def test_p3_024_reader_failure_cannot_fall_back_to_catalog_tags(admitted):
    class Broken(Reader):
        async def active_pack(self, tenant):
            raise TimeoutError()

    result, calls, models = asyncio.run(run_shopping(*admitted[0], reader=Broken()))
    assert "suitability is unknown" in result.text and not result.blocks
    assert len(calls) == 1 and not models


def test_p3_025_budget_reply_preserves_request(admitted):
    result, _, _ = asyncio.run(run_shopping(*admitted[0]))
    reply = resolve_shopping_reply(result.pending_shopping, "$60")
    assert reply.frame.max_price == "60" and reply.frame.currency == "USD"
    assert (
        reply.frame.shopping_context == result.pending_shopping.frame.shopping_context
    )
    assert not reply.frame.domain_profile
    second, calls, _ = asyncio.run(
        run_shopping("$60", resume=reply.frame, question=result.pending_shopping)
    )
    assert second.pending_shopping and second.pending_shopping.frame.max_price == "60"
    assert len(calls) == 1


@pytest.mark.parametrize("industry", ["grocery", "pharmacy"])
def test_p3_026_other_domains_keep_existing_boundary(industry):
    reader = Reader()
    schema = CatalogSchema(**catalog_schema(industry, []))
    _result, _, _ = asyncio.run(
        run_shopping(
            "find a laptop", raw_plan={"query": "laptop"}, reader=reader, schema=schema
        )
    )
    assert not reader.calls


def test_fact_conflict_withdrawal_and_product_scope():
    p, schema, facts = sample()
    ram = next(f for f in facts if f.attribute == "ram")
    conflict = ram.model_copy(update={"id": uuid4(), "value": 4})
    assert (
        assess(PACK, HD, p, schema, facts + (conflict,), TENANT, NOW).status
        == "unknown"
    )
    withdrawn = tuple(
        f.model_copy(update={"state": "withdrawn"}) if f.attribute == "ram" else f
        for f in facts
    )
    assert assess(PACK, HD, p, schema, withdrawn, TENANT, NOW).status == "unknown"
    p.category_name = "Accessories"
    assert assess(PACK, HD, p, schema, facts, TENANT, NOW).status == "unknown"


def test_malformed_boolean_is_unknown_not_a_proven_negative():
    p, schema, facts = sample()
    next(a for a in p.attributes if a.name == "direct3d_11").value = '"true"'
    facts = tuple(
        f.model_copy(update={"value": "true"}) if f.attribute == "direct3d_11" else f
        for f in facts
    )
    assessment = assess(PACK, HD, p, schema, facts, TENANT, NOW)
    assert assessment.status == "unknown"
    assert (
        next(c for c in assessment.checks if c.requirement_id == "direct3d_11").reason
        == "wrong_catalog_fact_type"
    )
