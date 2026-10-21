"""Application issuance, admission, scope checks and storefront SSE round trips."""

import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_compound_clarification import NoModel, Revisions
from test_shopping_clarifications import question

from app.commerce_action_engine.application import bootstrap, shopping
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.contracts import Usage


class Questions(Revisions):
    def __init__(self):
        super().__init__()
        self.pending = {}
        self.active_search = {}

    async def begin_request(self, *scope, **kwargs):
        result = await super().begin_request(*scope, **kwargs)
        if result:
            self.pending.pop(scope, None)
            self.active_search.pop(scope, None)
        return result

    async def publish_shopping_question(self, *args, store_id, session_id):
        scope, revision, original, plan = args[:3], *args[3:]
        if not await super().publish_question(
            *scope, revision, original, plan.question
        ):
            return False
        self.pending[scope] = (store_id, session_id, revision, original, plan)
        return True

    async def save_active_shopping(self, *args, store_id, session_id):
        scope, revision, original, active = args[:3], *args[3:]
        if self.active.get(scope) != (revision, None, None):
            return False
        self.active_search[scope] = (store_id, session_id, revision, original, active)
        return True

    async def shopping_active(self, *scope, store_id, session_id):
        state = self.active_search.get(scope)
        if state is None or state[:2] != (store_id, session_id):
            return None
        return {"revision": state[2], "original_message": state[3], "active": state[4]}

    async def claim_active_shopping(self, *scope, store_id, session_id, revision):
        state = await self.shopping_active(
            *scope, store_id=store_id, session_id=session_id
        )
        if state is None or state["revision"] != revision:
            return None
        return await self.begin_request(*scope)

    async def shopping_question(
        self, *scope, store_id, session_id, revision=None, original=None, question=None
    ):
        value = self.pending.get(scope)
        if value is None:
            return None
        saved_store, saved_session, saved_revision, saved_original, plan = value
        if (store_id, session_id) != (saved_store, saved_session):
            return None
        if revision is not None and revision != saved_revision:
            return None
        if original is not None and original != saved_original:
            return None
        if question is not None and question != plan.question:
            return None
        return {
            "revision": saved_revision,
            "original_message": saved_original,
            "plan": plan,
        }

    async def claim_shopping_question(
        self, *scope, store_id, session_id, revision, original, question
    ):
        if (
            await self.shopping_question(
                *scope,
                store_id=store_id,
                session_id=session_id,
                revision=revision,
                original=original,
                question=question,
            )
            is None
        ):
            return None
        return await self.begin_request(
            *scope, expected_revision=revision, original=original, question=question
        )


@pytest.fixture
def chat(identity, monkeypatch):
    config, _, headers = identity
    store = Questions()
    seen = []
    language_seen = []
    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    monkeypatch.setattr(bootstrap, "build_provider", lambda _: NoModel())

    async def resolve(url, message):
        language_seen.append(message)
        return gate.Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            entities={"productText": "rings"},
            message="",
            confidence=1,
        )

    async def answer(
        message,
        *args,
        shopping_resume=None,
        shopping_resume_revision=None,
        shopping_resume_question=None,
        **kwargs,
    ):
        seen.append(
            (
                message,
                shopping_resume,
                shopping_resume_revision,
                shopping_resume_question,
            )
        )
        if shopping_resume is None:
            return shopping.ShoppingAnswer(
                "Which style do you prefer?",
                Usage(0, 0, 0),
                "deterministic",
                0,
                pending_shopping=question(),
            )
        from test_catalog_schema import catalog_schema, schema_attribute

        from app.commerce_action_engine.actions.catalog.contracts import (
            CatalogProfile,
            CatalogSchema,
        )

        profile = CatalogProfile(
            revision="catalog-v1",
            scope="current_sellable_category",
            complete=True,
            candidate_count=2,
            matched_count=2,
            facets_complete=True,
            prices=[],
            facets=[
                {
                    "code": "metal",
                    "label": "Metal",
                    "data_type": "select",
                    "covered_count": 2,
                    "values": [{"value": "Gold", "label": "Gold", "count": 1}],
                    "values_complete": True,
                },
                {
                    "code": "color",
                    "label": "Color",
                    "data_type": "select",
                    "covered_count": 2,
                    "values": [{"value": "Gold", "label": "Gold", "count": 1}],
                    "values_complete": True,
                },
            ],
        )
        return shopping.ShoppingAnswer(
            "Products for your refined request.",
            Usage(0, 0, 0),
            "deterministic",
            0,
            shopping_frame=shopping_resume,
            shopping_revision="catalog-v1",
            shopping_profile=profile,
            shopping_schema=CatalogSchema.model_validate(
                catalog_schema(
                    "jewelry",
                    [
                        schema_attribute("metal", options=["Gold"]),
                        schema_attribute("color", options=["Gold"]),
                    ],
                )
            ),
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(shopping, "shopping_answer", answer)
    monkeypatch.setattr(bootstrap, "shopping_answer", answer)
    config = replace(config, store_password_file="test-only")

    def commerce(request):
        pytest.fail("The application continuation test reached a commerce tool")

    with TestClient(
        bootstrap.create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        conversation = str(uuid4())

        def send(
            message, clarification=None, *, overrides=None, conversation_id=conversation
        ):
            request = str(uuid4())
            response = client.post(
                "/v1/chat",
                headers={
                    **headers(request_id=request, **(overrides or {})),
                    "x-commerce-catalog-token": "test-scoped-read",
                },
                json={
                    "request_id": request,
                    "conversation_id": conversation_id,
                    "message": message,
                    **({"clarification": clarification} if clarification else {}),
                },
            )
            assert response.status_code == 200, response.text
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert events[-1]["type"] == "done" and not any(
                event["type"] == "error" for event in events
            ), events
            return events

        yield send, store, seen, language_seen


def pending(events):
    return next(
        event["clarification"] for event in events if event.get("clarification")
    )


def text(events):
    return "".join(event.get("text", "") for event in events)


def test_server_question_and_reply_are_read_only_and_skip_unknown_reasoning(chat):
    send, _, seen, language_seen = chat
    context = pending(send("I need luxury rings"))
    assert context["kind"] == "shopping" and context["choices"] == [
        "Classic",
        "Statement",
    ]
    result = send("Classic", {**context, "choices": ["Forged value"]})
    assert "refined request" in text(result) and not any(
        event.get("clarification") for event in result
    )
    assert language_seen == ["I need luxury rings"]
    _, frame, revision, original_question = seen[-1]
    assert frame.attributes[-1].value == "classic" and frame.attributes[0].value == "7"
    assert frame.min_price == "100" and frame.max_price == "800"
    assert revision == "catalog-v1" and original_question.frame.query == "rings"
    assert "expired or were replaced" in text(send("Classic", context))


def test_luxury_rings_budget_choice_resumes_the_original_search(chat, monkeypatch):
    from app.commerce_action_engine.actions.shopping.contracts import ShoppingChoice

    budget = question().model_copy(
        update={
            "question": "What is your budget? You can give a maximum amount, or show the available options.",
            "field": "budget",
            "choices": [
                ShoppingChoice(label="Up to 234.00 USD", value="234.00", operator="lte")
            ],
        }
    )
    monkeypatch.setattr(__name__ + ".question", lambda: budget)
    send, _, seen, language_seen = chat
    context = pending(send("I need luxury rings"))
    assert context["choices"] == ["Up to 234.00 USD"]
    result = send("Up to 234.00 USD", context)
    assert "refined request" in text(result)
    original, frame, revision, _ = seen[-1]
    assert original == "I need luxury rings"
    assert frame.query == "rings" and frame.currency == "USD"
    assert frame.max_price == "234.00" and not frame.exclusive_max
    assert frame.min_price == "100" and frame.attributes[0].value == "7"
    assert revision == "catalog-v1" and language_seen == [original]


def test_attribute_choice_round_trip_uses_server_fields_not_browser_choices(
    chat, monkeypatch
):
    from test_attribute_clarification import catalog

    from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
    from app.commerce_action_engine.actions.shopping.grounding import (
        attribute_clarification,
        ground_request,
    )

    message = "I need silver rings"
    schema = catalog()
    frame = ground_request(
        ShoppingIntent(shopping=True, query=message), message, schema
    ).frame
    plan = attribute_clarification(frame, message, schema)
    assert plan is not None
    monkeypatch.setattr(__name__ + ".question", lambda: plan)
    send, _, seen, language_seen = chat
    context = pending(send(message))
    assert context["choices"] == ["Metal: Silver", "Color: Silver"]
    assert not context["optional"] and "resolves" not in context
    # The shared raw value cannot accidentally choose either field.
    assert pending(send("silver", context))["choices"] == context["choices"]
    result = send("Metal: Silver", {**context, "choices": ["Forged: Silver"]})
    assert "refined request" in text(result)
    frame = seen[-1][1]
    assert [(c.name, c.value) for c in frame.attributes] == [("metal", "silver")]
    assert not frame.unresolved_requirements
    assert language_seen == [message]


@pytest.mark.parametrize("reply", ["Classic", "under $500", "Show options"])
def test_bare_replies_recover_only_active_server_state(chat, reply):
    send, _, seen, language_seen = chat
    pending(send("I need luxury rings"))
    assert "refined request" in text(send(reply))
    assert len(language_seen) == 1 and seen[-1][1].discovery_refined
    if reply == "under $500":
        assert seen[-1][1].max_price == "500" and seen[-1][1].exclusive_max


@pytest.mark.parametrize(
    "change",
    [
        "owner",
        "session",
        "conversation",
        "revision",
        "original",
        "question",
        "missing_revision",
    ],
)
def test_forged_or_foreign_reply_never_consumes_the_legitimate_question(chat, change):
    send, _, seen, _ = chat
    context = pending(send("I need luxury rings"))
    altered = dict(context)
    options = {}
    if change == "owner":
        options["overrides"] = {"sub": str(uuid4())}
    elif change == "session":
        options["overrides"] = {"sid": str(uuid4())}
    elif change == "conversation":
        options["conversation_id"] = str(uuid4())
    elif change == "revision":
        altered["revision"] = str(uuid4())
    elif change == "missing_revision":
        altered.pop("revision")
    elif change == "original":
        altered["original_message"] = "find all products"
    else:
        altered["question"] = "Choose anything"
    assert "expired or were replaced" in text(send("Classic", altered, **options))
    assert len(seen) == 1
    assert "refined request" in text(send("Classic", context))


def test_invalid_reply_keeps_question_and_fresh_request_supersedes_it(chat):
    send, _, seen, language_seen = chat
    context = pending(send("I need luxury rings"))
    retry = pending(send("Imaginary", context))
    assert retry == context and len(seen) == 1
    send("find phones", context)
    assert (
        language_seen == ["I need luxury rings", "find phones"] and seen[-1][1] is None
    )
    assert "expired or were replaced" in text(send("Classic", context))


def test_guest_questions_bind_the_public_conversation_and_revision(chat):
    send, _, seen, _ = chat
    guest = {"sub": None, "sid": None}
    context = pending(send("I need luxury rings", overrides=guest))
    result = send("Classic", context, overrides=guest)
    assert "refined request" in text(result) and not result[-1]["saved"]
    assert seen[-1][1].attributes[-1].value == "classic"


def test_later_budget_preserves_a_settled_facet_and_original_budget(chat):
    send, _, seen, language_seen = chat
    context = pending(send("I need luxury rings"))
    send("Classic", context)
    assert "refined request" in text(send("under $500"))
    frame = seen[-1][1]
    assert frame.max_price == "500" and frame.min_price == "100" and frame.exclusive_max
    assert frame.attributes[-1].value == "classic" and len(language_seen) == 1


def test_ambiguous_active_value_asks_a_typed_question_before_adding_a_constraint(chat):
    send, _, seen, language_seen = chat
    send("Classic", pending(send("I need luxury rings")))
    context = pending(send("Gold"))
    assert context["question"] == "Which product feature did you mean?"
    assert (
        context["choices"] == ["Metal: Gold", "Color: Gold"] and not context["optional"]
    )
    assert len(seen) == 2
    send("Metal: Gold", context)
    assert (
        seen[-1][1].attributes[-1].name == "metal"
        and seen[-1][1].attributes[-1].value == "Gold"
    )
    assert len(language_seen) == 1


def test_conflicting_active_budget_does_not_clear_the_existing_search(chat):
    send, _, seen, language_seen = chat
    send("Classic", pending(send("I need luxury rings")))
    result = send("under $50")
    assert "conflicts" in text(result) and len(seen) == 2 and len(language_seen) == 1
    send("under $500")
    assert seen[-1][1].max_price == "500" and seen[-1][1].min_price == "100"
