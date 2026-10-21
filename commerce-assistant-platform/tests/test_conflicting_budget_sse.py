"""Contradictory prices stop the real assistant stream before catalog retrieval."""

import pytest
from test_routing_reliability import (
    CORE,
    answer_text,
    frozen_demo,
    presented_ids,
    sse_turn,
)
from test_routing_reliability import (
    identity as identity,  # noqa: PLC0414 -- pytest fixture
)


@pytest.mark.parametrize("flags", [frozenset(), CORE], ids=["legacy", "core"])
def test_conflicting_budget_clarifies_without_catalog_search(
    identity, monkeypatch, flags
):
    events, calls, parsed = sse_turn(
        identity,
        monkeypatch,
        "Find rings under $5 and over $100",
        frozen_demo("jewelry"),
        flags=flags,
    )
    assert parsed[0]["status"] == "NEEDS_CONTEXT"
    assert "non-empty price range" in answer_text(events)
    assert not presented_ids(events)
    assert not any(c.get("name") == "search_products" for c in calls)
