"""Capture optimizations preserve source evidence and secret redaction."""

import inspect
from concurrent.futures import ThreadPoolExecutor
from types import CodeType

from app.commerce_action_engine.platform.tracking import redact_tracking
from app.commerce_resolution_engine import diagnostics


def test_source_matches_python_inspection_for_deployed_nested_and_decorated_code():
    from app.commerce_action_engine.application.handle_turn import HandleTurn

    def codes(code):
        yield code
        for child in code.co_consts:
            if isinstance(child, CodeType):
                yield from codes(child)

    for code in codes(HandleTurn.run.__code__):
        # Comprehensions have no independent function block; they aren't traced.
        if code.co_name.startswith("<"):
            continue
        actual = diagnostics._source(code)
        lines, line = inspect.getsourcelines(code)
        expected = "".join(lines)
        assert actual["source"] == expected[:24000]
        assert actual["line"] == line
        assert (
            actual["sha256"]
            == diagnostics.hashlib.sha256(expected.encode()).hexdigest()
        )


def test_source_cache_is_bounded_and_uses_code_identity():
    from app.commerce_action_engine.application.handle_turn import HandleTurn

    original = HandleTurn.run.__code__
    copies = [original.replace(co_name=f"copy_{index}") for index in range(270)]
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(diagnostics._source, copies))
    assert all(result is not None for result in results)
    assert len(diagnostics._source_cache) <= 256
    code, result = diagnostics._source_cache[id(copies[-1])]
    assert code is copies[-1]
    assert diagnostics._source(copies[-1]) is result
    assert diagnostics._source((lambda: None).__code__) is None


def test_redaction_memo_never_bypasses_secret_keys_or_crosses_calls(monkeypatch):
    from app.commerce_action_engine.platform import store

    original = store.redact
    calls = []
    monkeypatch.setattr(
        store, "redact", lambda value: (calls.append(value), original(value))[1]
    )
    text = "test@example.com Bearer fixture-token phone +201234567890"
    document = {
        "plain": text,
        "items": [text, text],
        "authorization": text,
        "nested": {"PASSWORD": text},
        "token": "eyJabc.def.ghi",
    }
    first = redact_tracking(document)
    assert calls.count(text) == 1
    assert first["authorization"] == first["nested"]["PASSWORD"] == "[redacted]"
    assert first["token"] == "[token redacted]"
    assert "test@example.com" not in str(first) and "fixture-token" not in str(first)
    assert document["plain"] == text
    second = redact_tracking(document)
    assert second == first and calls.count(text) == 2
