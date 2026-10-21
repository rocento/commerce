"""Real Node grammar output must survive Python validation and catalog execution."""

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path
from uuid import UUID

import pytest
from test_product_facts import Reader, collect, ring, text
from test_shopping import interpreted, product, scenario
from test_shopping_context import laptop_schema

from app.commerce_action_engine.actions.shopping import context as shopping_context
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate

ENGINE = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
SEARCH_CASES = [
    (
        "I am buying a laptop for my mother, who mainly uses it for remote lessons under $800.",
        [("recipient", "mother"), ("intended_use", "online classes")],
    ),
    (
        "Find laptop for my mother and gaming under $800.",
        [("recipient", "mother"), ("intended_use", "gaming")],
    ),
    (
        "Find laptop for my mother's birthday under $800.",
        [("occasion", "birthday")],
    ),
    (
        "Find laptop to use for telecommuting under $800.",
        [("intended_use", "remote work")],
    ),
]
CSV_BUDGET_CASES = [
    (
        "I am buying a phone for my mother, who mainly uses it for online classes. Budget $40.",
        "phone",
        "Phone",
        "40",
        "Class Phone",
        "35",
        [("recipient", "mother"), ("intended_use", "online classes")],
    ),
    (
        "I need an anniversary gift for my mother with a budget of $15. What would you choose?",
        "*",
        "Gifts",
        "15",
        "Anniversary Keepsake",
        "12",
        [("recipient", "mother")],
    ),
]
SEARCH_CONVERSATIONS = [
    (["Do you sell laptop?", "What should I look at?"], None, []),
    (
        [
            "I need a laptop for online classes and my limit is $10000.",
            "What should I look at?",
        ],
        "10000",
        [("intended_use", "online classes")],
    ),
]
QUANTITY_QUESTION = (
    "Quick question: What would 3 of Classic Gold Ring cost before delivery? "
    "Keep it brief."
)


@pytest.fixture(scope="module")
def grammar_release(tmp_path_factory):
    # Both runtimes consume one candidate release, even before build artifacts
    # are refreshed. The emitted interpretation is not a hand-written fixture.
    artifact = tmp_path_factory.mktemp("grammar-pipeline") / "compiled.json"
    dictionary = json.loads((ENGINE / "data/compiled.json").read_text())
    dictionary["languageKnowledge"] = json.loads(
        (ENGINE / "data/knowledge/shopping-en-v1.json").read_text()
    )
    artifact.write_text(json.dumps(dictionary))
    messages = (
        [message for message, _ in SEARCH_CASES]
        + [row[0] for row in CSV_BUDGET_CASES]
        + [QUANTITY_QUESTION]
    )
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {readFileSync} from 'node:fs';"
                "import {compile} from './src/compiler.ts';"
                "import {resolve} from './src/engine.ts';"
                "const engine=compile(JSON.parse(readFileSync(process.argv[1],'utf8')));"
                "const singles=JSON.parse(process.argv[2]).map(message=>resolve(engine,message));"
                "const sequences=JSON.parse(process.argv[3]).map(messages=>{let context={};"
                "return messages.map(text=>{const result=resolve(engine,text,context);"
                "context=result.context.next;return result;});});"
                "console.log(JSON.stringify({singles,sequences}));"
            ),
            str(artifact),
            json.dumps(messages),
            json.dumps([row[0] for row in SEARCH_CONVERSATIONS]),
        ],
        cwd=ENGINE,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    data = json.loads(output.stdout)
    results = dict(zip(messages, data["singles"], strict=True))
    results.update(
        (tuple(case[0]), run)
        for case, run in zip(SEARCH_CONVERSATIONS, data["sequences"], strict=True)
    )
    return artifact, results


@pytest.fixture
def resolved_grammar(grammar_release, monkeypatch):
    artifact, results = grammar_release
    monkeypatch.setattr(shopping_context, "_COMPILED_KNOWLEDGE", artifact)
    shopping_context._read_relationship_rules.cache_clear()
    shopping_context._read_sentence_rules.cache_clear()
    yield results
    shopping_context._read_relationship_rules.cache_clear()
    shopping_context._read_sentence_rules.cache_clear()


@pytest.mark.parametrize("message,expected_relations", SEARCH_CASES)
@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_node_relationships_reach_python_catalog_with_clean_query_and_budget(
    resolved_grammar, message, expected_relations, commerce_meaning
):
    source = gate.Resolution.model_validate(resolved_grammar[message])
    assert source.status == "RESOLVED" and source.intent == "PRODUCT_SEARCH"
    request = interpreted(source)
    assert isinstance(request, InterpretedRequest)
    source_message = source.interpretationText or message
    emitted = source.entities["shoppingContext"]
    assert [
        (row["relation"], row["value"]) for row in emitted["relations"]
    ] == expected_relations
    for row in emitted["relations"]:
        assert source_message[row["start"] : row["end"]] == row["text"]
    # The mapper calls the actual published-data verifier, not a test bypass.
    plan = shopping_plan(request, source_message)
    assert plan is not None and plan.clarification is None
    assert plan.query == "laptop" and plan.max_price == "800"
    assert plan.exclusive_max and plan.currency == "USD"
    assert plan.intended_use is None and not plan.attributes
    answer, calls = asyncio.run(
        scenario(
            source_message,
            {},
            [
                product(
                    name="Class Laptop", category="Laptop", price="650", attributes=[]
                )
            ],
            interpretation=request,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert "Class Laptop" in answer.text
    searches = [
        call["arguments"] for call in calls if call["name"] == "search_products"
    ]
    assert searches
    assert all(arguments.get("query") in {"laptop", "*"} for arguments in searches)
    assert any(str(arguments.get("max_price")) == "800" for arguments in searches)
    assert all(not arguments.get("attributes") for arguments in searches)
    assert all(call["name"] in {"search_products", "get_product"} for call in calls)


@pytest.mark.parametrize(
    "message,query,category,budget,product_name,price,expected_relations",
    CSV_BUDGET_CASES,
)
@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_csv_separate_and_embedded_budgets_survive_catalog_execution(
    resolved_grammar,
    message,
    query,
    category,
    budget,
    product_name,
    price,
    expected_relations,
    commerce_meaning,
):
    source = gate.Resolution.model_validate(resolved_grammar[message])
    assert source.status == "RESOLVED" and source.intent == "PRODUCT_SEARCH"
    assert source.entities["price"] == {
        "operator": "<=",
        "value": int(budget),
        "currency": "USD",
    }
    request = interpreted(source)
    assert isinstance(request, InterpretedRequest)
    source_message = source.interpretationText or message
    emitted = source.entities["shoppingContext"]
    assert [
        (row["relation"], row["value"]) for row in emitted["relations"]
    ] == expected_relations
    for row in emitted["relations"]:
        assert source_message[row["start"] : row["end"]] == row["text"]
    plan = shopping_plan(request, source_message)
    assert plan is not None and plan.clarification is None
    assert plan.query == query and plan.max_price == budget
    assert not plan.exclusive_max and plan.currency == "USD"
    assert plan.intended_use is None and not plan.attributes
    if category == "Gifts":
        assert plan.gift_context is not None
        assert plan.gift_context.occasion == "anniversary"
    schema = {
        **laptop_schema(),
        "categories": [{"id": str(UUID(int=2)), "name": category}],
    }
    answer, calls = asyncio.run(
        scenario(
            source_message,
            {},
            [product(name=product_name, category=category, price=price, attributes=[])],
            interpretation=request,
            catalog_schema_override=schema,
            commerce_meaning=commerce_meaning,
        )
    )
    assert product_name in answer.text
    searches = [
        call["arguments"] for call in calls if call["name"] == "search_products"
    ]
    assert searches
    assert all(arguments.get("query") in {query, "*"} for arguments in searches)
    assert any(str(arguments.get("max_price")) == budget for arguments in searches)
    assert all(not arguments.get("attributes") for arguments in searches)
    assert all(call["name"] in {"search_products", "get_product"} for call in calls)


@pytest.mark.parametrize(
    "budget_clause,price_change",
    [
        ("with a budget of $15", {"value": 150}),
        ("with a budget of $15", {"currency": "EUR"}),
        ("with a budget of $15", {"operator": ">="}),
        ("with a budget of $15 if delivery is free", {}),
        ("with a budget of $15 and add it to my cart", {}),
        ("with a budget of $15 only when certified", {}),
        ("with a budget of $15 items", {}),
        ("with a budget of $15 EUR", {}),
        ("with a budget of $15 and under $10", {}),
        ("with a budget of $15 and $5 delivery", {}),
    ],
)
def test_budget_connector_cannot_hide_constraints_or_disagree_with_money(
    resolved_grammar,
    budget_clause,
    price_change,
):
    original = CSV_BUDGET_CASES[1][0]
    message = original.replace("with a budget of $15", budget_clause)
    raw = deepcopy(resolved_grammar[original])
    raw["entities"]["price"].update(price_change)
    # Retain exact source spans while testing a contradictory/untrusted wire
    # interpretation. The failure must be the budget, not stale test offsets.
    context = raw["entities"]["shoppingContext"]
    for row in [*context["relations"], *context["sentenceRoles"]]:
        row["start"] = message.index(row["text"])
        row["end"] = row["start"] + len(row["text"])
    request = interpreted(gate.Resolution.model_validate(raw))
    assert shopping_plan(request, message) is None


@pytest.mark.parametrize("messages,budget,expected_relations", SEARCH_CONVERSATIONS)
@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_separate_recommendation_prompt_reuses_real_node_search_in_python_catalog(
    resolved_grammar,
    messages,
    budget,
    expected_relations,
    commerce_meaning,
):
    first, followup = resolved_grammar[tuple(messages)]
    assert first["status"] == "RESOLVED"
    source = gate.Resolution.model_validate(followup)
    assert source.status == "RESOLVED" and source.intent == "PRODUCT_SEARCH"
    assert source.searchUpdate is True
    assert source.entities["productText"] == "laptop"
    assert source.interpretationText is not None
    meaning = source.entities["shoppingContext"]
    assert [
        (row["relation"], row["value"]) for row in meaning["relations"]
    ] == expected_relations
    for row in [*meaning["relations"], *meaning["sentenceRoles"]]:
        assert source.interpretationText[row["start"] : row["end"]] == row["text"]
    request = interpreted(source)
    assert isinstance(request, InterpretedRequest)
    plan = shopping_plan(request, source.interpretationText)
    assert plan is not None and plan.clarification is None
    assert plan.query == "laptop" and plan.max_price == budget
    assert not plan.attributes and plan.intended_use is None
    if budget:
        assert source.entities["price"] == {
            "operator": "<=",
            "value": int(budget),
            "currency": "USD",
        }
    answer, calls = asyncio.run(
        scenario(
            source.interpretationText,
            {},
            [
                product(
                    name="Class Laptop", category="Laptop", price="650", attributes=[]
                )
            ],
            interpretation=request,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert "Class Laptop" in answer.text
    searches = [
        call["arguments"] for call in calls if call["name"] == "search_products"
    ]
    assert searches
    assert all(arguments.get("query") in {"laptop", "*"} for arguments in searches)
    assert all(not arguments.get("attributes") for arguments in searches)
    if budget:
        assert any(str(arguments.get("max_price")) == budget for arguments in searches)
    assert all(call["name"] in {"search_products", "get_product"} for call in calls)


def test_node_quantity_question_reaches_python_verified_price_arithmetic(
    resolved_grammar,
):
    source = gate.Resolution.model_validate(resolved_grammar[QUANTITY_QUESTION])
    assert source.status == "RESOLVED" and source.intent == "CHECK_PRICE"
    assert source.entities == {"productText": "Classic Gold Ring", "quantity": 3}
    request = interpreted(source)
    assert isinstance(request, InterpretedRequest)
    reader = Reader(current={**ring(), "price": "19.95"})
    events, metadata = asyncio.run(collect(reader, request))
    assert "59.85 USD" in text(events) and "before tax" in text(events)
    assert metadata["product_fact_status"] == "answered"
    assert reader.calls == [
        ("search", "Classic Gold Ring"),
        ("product", UUID(reader.current["id"])),
    ]
