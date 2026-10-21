"""Full Node → admission → scoped clarification → SSE journeys; no commerce writes."""

import asyncio
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_understanding import real_resolve

from app.commerce_action_engine.application import bootstrap
from app.commerce_action_engine.application.followups import resume_compound
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.execution.language import gate

ORIGINAL = "add 2 of it to cart then also to wishlist"


class Revisions:
    """Application port fake; actual database statements are tested separately."""

    def __init__(self):
        self.active = {}
        self.saved = []

    async def admit_customer_request(self, tenant, customer, request):
        assert tenant is not None and customer is not None and request is not None

    async def open(self):
        pass

    async def close(self):
        pass

    async def purge(self, tenant):
        pass

    async def context(self, *scope):
        return []

    async def save(self, *args):
        self.saved.append(args)

    async def begin_request(
        self, *scope, expected_revision=None, original="", question=""
    ):
        if expected_revision is not None and self.active.get(scope) != (
            expected_revision,
            original,
            question,
        ):
            return None
        revision = uuid4()
        self.active[scope] = (revision, None, None)
        return revision

    async def publish_question(self, *args):
        scope, revision, original, question = args[:3], *args[3:]
        if self.active.get(scope) != (revision, None, None):
            return False
        self.active[scope] = (revision, original, question)
        return True


class NoModel:
    async def generate(self, request):
        pytest.fail("Compound review reached a model")

    async def stream(self, request):
        pytest.fail("Compound review reached a model")
        yield

    async def aclose(self):
        pass


@pytest.fixture
def chat(identity, monkeypatch):
    config, _, headers = identity
    store = Revisions()
    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    monkeypatch.setattr(gate, "resolve", real_resolve)

    def commerce(request):
        pytest.fail("Compound review reached commerce")

    config = replace(config, store_password_file="test-only")
    with TestClient(
        bootstrap.create_app(
            config, model=NoModel(), transport=httpx.MockTransport(commerce)
        )
    ) as client:
        conversation = str(uuid4())

        def send(
            message, clarification=None, *, owner=None, conversation_id=conversation
        ):
            request = str(uuid4())
            response = client.post(
                "/v1/chat",
                headers=headers(
                    request_id=request, **({"sub": owner} if owner else {})
                ),
                json={
                    "request_id": request,
                    "message": message,
                    "conversation_id": conversation_id,
                    **({"clarification": clarification} if clarification else {}),
                },
            )
            assert response.status_code == 200
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert events[-1]["type"] == "done"
            assert not any(e["type"] == "error" for e in events), events
            return events

        yield send, store


def question(events):
    return next(e["clarification"] for e in events if e.get("clarification"))


def text(events):
    return "".join(e.get("text", "") for e in events)


def test_product_reply_preserves_both_actions_and_quantity(chat):
    send, store = chat
    pending = question(send(ORIGINAL))
    assert pending["revision"] and "both" in pending["question"]
    answer = send("banana", pending)
    assert "2 banana to cart" in text(answer) and "2 banana to wishlist" in text(answer)
    assert not any(e.get("clarification") for e in answer)
    assert store.saved[-1][-1]["compound_review"] == "understood"
    assert store.saved[-1][-1]["completion"]["status"] != "completed"
    assert "expired or was replaced" in text(send("banana", pending))


def test_rejected_answer_rotates_revision_and_keeps_original(chat):
    send, _ = chat
    first = question(send(ORIGINAL))
    second = question(send("yes", first))
    assert second["revision"] != first["revision"]
    assert second["original_message"] == ORIGINAL
    assert "expired or was replaced" in text(send("banana", first))
    assert "2 banana to wishlist" in text(send("banana", second))


@pytest.mark.parametrize("reply", ["cancel", "actually add 3 apples to wishlist"])
def test_cancellation_and_complete_correction_close_old_revision(chat, reply):
    send, _ = chat
    pending = question(send(ORIGINAL))
    answer = send(reply, pending)
    assert not any(e.get("clarification") for e in answer)
    assert ("Cancelled" if reply == "cancel" else "3 apples to wishlist") in text(
        answer
    )
    if reply != "cancel":
        assert "2 banana" not in text(answer)
    assert "expired or was replaced" in text(send("banana", pending))


def test_new_request_supersedes_old_and_cannot_be_rearmed(chat):
    send, _ = chat
    first = question(send(ORIGINAL))
    latest = question(send("add it to cart and add apples to wishlist"))
    assert "expired or was replaced" in text(send("banana", first))
    assert "1 banana to cart" in text(send("banana", latest))


@pytest.mark.parametrize(
    "change", ["owner", "conversation", "original", "question", "revision"]
)
def test_scope_and_exact_question_are_bound(chat, change):
    send, _ = chat
    pending = question(send(ORIGINAL))
    altered = dict(pending)
    options = {}
    if change == "owner":
        options["owner"] = str(uuid4())
    elif change == "conversation":
        options["conversation_id"] = str(uuid4())
    elif change == "revision":
        altered["revision"] = str(uuid4())
    elif change == "original":
        altered["original_message"] = "add it to cart and add apples to wishlist"
    else:
        altered["question"] = "Which product?"
    assert "expired or was replaced" in text(send("banana", altered, **options))
    # Invalid claims do not consume the legitimate question.
    assert "2 banana to wishlist" in text(send("banana", pending))


def test_missing_revision_cannot_resume_a_compound_request(chat):
    send, _ = chat
    pending = question(send(ORIGINAL))
    pending.pop("revision")
    answer = send("banana", pending)
    assert "current clarification revision" in text(answer)
    assert "Requested actions:" not in text(answer)


def test_python_rechecks_preservation_after_language_reply(monkeypatch, context):
    prior = asyncio.run(real_resolve("", ORIGINAL))
    filled = asyncio.run(
        real_resolve("", "banana", context={"pendingActionRequest": ORIGINAL})
    )
    filled.requestedActions[1].items[0].quantity = 99

    async def forged(url, message, *, context=None):
        return filled if context else prior

    monkeypatch.setattr(gate, "resolve", forged)
    result, source = asyncio.run(
        resume_compound("", ORIGINAL, "banana", context=context)
    )
    assert (
        result.result == interpret_resolution(prior, context).result
        and source == ORIGINAL
    )


def test_inconsistent_reply_marker_cannot_grant_model_or_write_route():
    for status in ["UNKNOWN", "RESOLVED"]:
        result = gate.Resolution(
            status=status,
            intent="ADD_TO_CART",
            message="Review",
            confidence=1,
            compoundReply="rejected",
        )
        assert standard_route(result) == "clarify"
        assert result.status == "NEEDS_CONTEXT"


def test_missing_persistence_never_issues_a_resumable_compound_question(
    identity, monkeypatch
):
    config, request, headers = identity
    monkeypatch.setattr(gate, "resolve", real_resolve)

    def commerce(request):
        pytest.fail("Unscoped compound request reached commerce")

    with TestClient(
        bootstrap.create_app(
            config, model=NoModel(), transport=httpx.MockTransport(commerce)
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request, "message": ORIGINAL},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert not any(e.get("clarification") or e["type"] == "error" for e in events)
    assert "complete request again" in text(events)


@pytest.mark.parametrize("phase", ["original", "reply"])
def test_malformed_compound_reparse_fails_closed(monkeypatch, context, phase):
    from app.commerce_action_engine.contracts.interpretation import (
        InterpretationFailure,
    )

    prior = asyncio.run(real_resolve("", ORIGINAL))
    invalid = prior.model_copy(update={"clarificationReply": "true"})
    calls = []

    async def resolve(url, message, *, context=None):
        calls.append(message)
        return invalid if phase == "original" or context else prior

    monkeypatch.setattr(gate, "resolve", resolve)
    result, source = asyncio.run(
        resume_compound("", ORIGINAL, "banana", context=context)
    )
    assert isinstance(result.result, InterpretationFailure)
    assert result.result.code == "invalid_response"
    assert not hasattr(result, "resolution")
    assert source == ORIGINAL
    assert len(calls) == (1 if phase == "original" else 2)


@pytest.mark.parametrize("phase", ["original", "reply"])
def test_unavailable_compound_reparse_keeps_clarification(monkeypatch, context, phase):
    prior = asyncio.run(real_resolve("", ORIGINAL))

    async def resolve(url, message, *, context=None):
        return None if phase == "original" or context else prior

    monkeypatch.setattr(gate, "resolve", resolve)
    result, source = asyncio.run(
        resume_compound("", ORIGINAL, "banana", context=context)
    )
    assert result.route == "clarify"
    assert source == ORIGINAL
    if phase == "original":
        assert result.result.compound_reply == "rejected"
    else:
        assert result.result == interpret_resolution(prior, context).result
