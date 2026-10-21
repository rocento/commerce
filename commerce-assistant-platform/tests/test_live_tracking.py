import asyncio
import json
from uuid import uuid4

from app.commerce_action_engine.platform.live_tracking import LiveFeed
from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug, traced


def test_live_feed_requires_watcher_redacts_and_isolates_tenants():
    feed = LiveFeed()
    request = str(uuid4())
    feed.publish(
        "a",
        request,
        "stage",
        {"stage": "customer_request", "data": {"message": "private"}},
    )
    initial = feed.read("a")
    assert not initial["events"]
    feed.publish(
        "a",
        request,
        "stage",
        {
            "stage": "customer_request",
            "data": {"password": "secret", "message": "test@example.com"},
        },
    )
    result = feed.read("a", initial["cursor"])
    assert len(result["events"]) == 1
    assert "secret" not in json.dumps(result) and "test@example.com" not in json.dumps(
        result
    )
    assert feed.read("a", result["cursor"])["events"] == []
    assert feed.read("b", initial["cursor"])["events"] == []


def test_retention_restart_and_byte_limits_signal_gaps():
    now = [0]
    feed = LiveFeed(max_events=2, clock=lambda: now[0])
    cursor = feed.read("a")["cursor"]
    for _ in range(4):
        feed.publish("a", str(uuid4()), "finished", {"truncated": False})
    batch = feed.read("a", cursor)
    assert batch["reset"] and len(batch["events"]) == 2
    restarted = LiveFeed(clock=lambda: now[0])
    assert restarted.read("a", batch["cursor"])["reset"]
    now[0] = 61
    assert feed.read("a", cursor)["reset"]
    assert feed.tenants["a"]["bytes"] == 0
    now[0] = 77
    feed.publish("a", str(uuid4()), "finished", {})
    assert not feed.read("a", batch["cursor"])["events"]


def test_start_is_visible_before_function_returns_and_off_has_no_events():
    feed = LiveFeed()
    cursor = feed.read("a")["cursor"]
    request = str(uuid4())

    def publish(ident, kind, data):
        feed.publish("a", ident, kind, data)

    @traced
    async def work():
        batch = feed.read("a", cursor)
        stages = [e["data"]["stage"] for e in batch["events"]]
        assert stages == ["customer_request", "python_function_start"]
        await asyncio.sleep(0)
        return 42

    async def run():
        token = begin_debug(request, "hello", enabled=True, publish=publish)
        try:
            assert await work() == 42
        finally:
            report = finish_debug(token)
        assert [e["stage"] for e in report["events"]] == [
            "customer_request",
            "python_function",
        ]

    asyncio.run(run())
    events = feed.read("a", cursor)["events"]
    assert events[-1]["kind"] == "finished"
    assert events[1]["data"]["data"]["callId"] == events[2]["data"]["data"]["callId"]
    latest = feed.read("a")["cursor"]
    token = begin_debug(
        str(uuid4()), "off", enabled=True, allowed=False, publish=publish
    )
    assert finish_debug(token) is None
    assert not feed.read("a", latest)["events"]


def test_bad_observer_does_not_break_the_request():
    def failed(*args):
        raise RuntimeError("observer is unavailable")

    token = begin_debug(str(uuid4()), "hello", enabled=True, publish=failed)
    assert finish_debug(token)["events"][0]["stage"] == "customer_request"


def test_bounded_batches_resume_without_duplicates_and_reject_invalid_cursor():
    import pytest

    feed = LiveFeed()
    initial = feed.read("a")["cursor"]
    for _ in range(140):
        feed.publish("a", str(uuid4()), "finished", {"truncated": False})
    first = feed.read("a", initial)
    second = feed.read("a", first["cursor"])
    assert len(first["events"]) == 128 and len(second["events"]) == 12
    assert len({e["sequence"] for e in first["events"] + second["events"]}) == 140
    with pytest.raises(ValueError, match="Invalid live cursor"):
        feed.read("a", "invalid")


def test_expired_watcher_lease_marks_unobserved_interval_as_a_gap():
    now = [0]
    feed = LiveFeed(clock=lambda: now[0])
    cursor = feed.read("a")["cursor"]
    now[0] = 16
    feed.publish("a", str(uuid4()), "finished", {})
    resumed = feed.read("a", cursor)
    assert resumed["reset"] is True and resumed["events"] == []


def test_resume_after_lease_expiry_does_not_replay_already_seen_events():
    now = [0]
    feed = LiveFeed(clock=lambda: now[0])
    cursor = feed.read("a")["cursor"]
    feed.publish("a", str(uuid4()), "finished", {})
    cursor = feed.read("a", cursor)["cursor"]
    now[0] = 16
    resumed = feed.read("a", cursor)
    assert resumed["reset"] is True and resumed["events"] == []


def test_evicted_idle_stream_changes_identity_even_without_prior_events():
    now = [0]
    feed = LiveFeed(clock=lambda: now[0])
    cursor = feed.read("a")["cursor"]
    now[0] = 90
    resumed = feed.read("a", cursor)
    assert resumed["reset"] is True
    assert resumed["cursor"].split(":")[0] != cursor.split(":")[0]
