"""Scoped SQL, fail-closed claims, and compare-and-swap question publication."""

import asyncio
from uuid import UUID

from test_completion_store import store_for

from app.commerce_action_engine.platform.request_revisions import digest

SCOPE = tuple(UUID(int=i) for i in range(1, 4))
REVISION = UUID(int=4)


def test_claim_matches_revision_hashes_expiry_and_owner_under_a_lock():
    store, connection = store_for({"revision": REVISION})
    current = asyncio.run(
        store.begin_request(
            *SCOPE,
            expected_revision=REVISION,
            original="add it",
            question="Which product?",
        )
    )
    assert current and current != REVISION
    lock, claim, rotate = connection.calls[-3:]
    assert "FOR UPDATE" in lock[0] and lock[1] == SCOPE
    assert "expires_at>now()" in claim[0] and "AND pending" in claim[0]
    assert claim[1] == (*SCOPE, REVISION, digest("add it"), digest("Which product?"))
    assert "SET revision=EXCLUDED.revision,pending=false" in rotate[0]
    assert rotate[1] == (*SCOPE, current)


def test_invalid_claim_leaves_current_revision_untouched():
    store, connection = store_for(None)
    assert asyncio.run(store.begin_request(*SCOPE, expected_revision=REVISION)) is None
    assert not any(
        "INSERT INTO assistant.request_revisions" in sql for sql, _ in connection.calls
    )


def test_fresh_turn_invalidates_questions_before_language_work():
    store, connection = store_for(None)
    current = asyncio.run(store.begin_request(*SCOPE))
    assert current
    assert connection.calls[-1][1] == (*SCOPE, current)
    assert "expires_at=NULL" in connection.calls[-1][0]


def test_question_publication_is_bounded_and_cannot_rearm_an_older_turn():
    store, connection = store_for(None)
    assert not asyncio.run(
        store.publish_question(*SCOPE, REVISION, "add it", "Which product?")
    )
    sql, params = connection.calls[-1]
    assert "interval '15 minutes'" in sql
    assert "AND revision=%s AND NOT pending" in sql
    assert params == (digest("add it"), digest("Which product?"), *SCOPE, REVISION)
    store, _ = store_for({"revision": REVISION})
    assert asyncio.run(
        store.publish_question(*SCOPE, REVISION, "add it", "Which product?")
    )
