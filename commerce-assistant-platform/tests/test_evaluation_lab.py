"""Negative controls for M02: prove unsafe, missing and flaky evidence cannot pass."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelRequest,
    ModelResponse,
    Usage,
)
from evals.lab.budget import CappedProvider
from evals.lab.models import (
    Dataset,
    Expectation,
    Failure,
    RetrievalObservations,
    load_dataset,
)
from evals.lab.review import review_queue
from evals.lab.runner import dataset_digest, run
from evals.lab.scoring import (
    catalog_assertions,
    compare,
    segments,
    thresholds_after_baseline,
    wilson,
)

DATA = Path(__file__).parents[1] / "evals/lab/commerce-v1.json"


@pytest.fixture(scope="module")
def baseline():
    return asyncio.run(run(load_dataset(DATA)))


def test_frozen_runtime_baseline_covers_every_journey_store_and_language(baseline):
    assert baseline.status == "passed"
    assert {r.store for r in baseline.results} == {"grocery", "jewelry", "electronics"}
    assert {r.language for r in baseline.results} == {
        "en",
        "ar",
        "ar-eg",
        "mixed",
        "typo",
    }
    assert {r.journey for r in baseline.results} == {
        "discovery",
        "comparison",
        "gift",
        "compatibility",
        "meal",
        "shop",
        "optimize",
        "buy_again",
        "policy",
        "order_status",
        "support",
    }
    assert all(
        r.input_tokens is None and r.cost_micros is None for r in baseline.results
    )
    assert (
        compare(baseline, baseline, thresholds_after_baseline(baseline))["status"]
        == "passed"
    )


@pytest.mark.parametrize("mutation", ["price", "currency", "in_stock", "route", "id"])
def test_independent_oracle_rejects_corrupted_catalog_fact(mutation):
    snapshot = load_dataset(DATA).snapshots[0]
    product = snapshot.products[0]
    data = product.model_dump()
    data[mutation] = {
        "price": "0",
        "currency": "EGP",
        "in_stock": False,
        "route": "/products/wrong",
        "id": "00000000-0000-0000-0000-000000099999",
    }[mutation]
    card = SimpleNamespace(**data)
    block = SimpleNamespace(
        products=[card], sources=[SimpleNamespace(product_id=card.id)]
    )
    failures = catalog_assertions([block], "", snapshot, Expectation())
    assert any(f.safety for f in failures)


def test_hard_budget_and_untrusted_attributes_fail_even_if_card_facts_are_true():
    snapshot = load_dataset(DATA).snapshots[0]
    for product in (snapshot.products[0], snapshot.products[4]):
        block = SimpleNamespace(
            products=[product], sources=[SimpleNamespace(product_id=product.id)]
        )
        failures = catalog_assertions(
            [block],
            "",
            snapshot,
            Expectation(max_price="10", attributes={"roast": "dark"}),
        )
        assert any(f.assertion == "hard_budget" and f.safety for f in failures)
        if product == snapshot.products[4]:
            assert any(
                f.assertion == "hard_attribute:roast" and f.safety for f in failures
            )


@pytest.mark.parametrize("status", ["failed", "quarantined", "not_run"])
def test_regression_and_quarantine_never_pass(baseline, status):
    candidate = baseline.model_copy(deep=True)
    candidate.results[0].status = status
    candidate.status = "failed" if status == "failed" else "incomplete"
    if status == "failed":
        candidate.results[0].failures = [
            Failure(assertion="cross_scope", layer="tool", safety=True)
        ]
    candidate.segments = segments(candidate.results)
    result = compare(baseline, candidate, thresholds_after_baseline(baseline))
    assert result["status"] == "failed"
    assert baseline.results[0].id in result["paired_case_regressions"]
    assert result["threshold_errors"]


@pytest.mark.parametrize(
    "mutation", ["missing", "duplicate", "segment", "metrics", "dataset"]
)
def test_corrupted_or_incomparable_reports_are_rejected(baseline, mutation):
    candidate = baseline.model_copy(deep=True)
    if mutation == "missing":
        candidate.results.pop()
    elif mutation == "duplicate":
        candidate.results.append(candidate.results[0])
    elif mutation == "segment":
        candidate.results[0].language = "ar"
    elif mutation == "metrics":
        candidate.segments["store:grocery"]["passed"] = 0
    else:
        candidate.dataset_sha256 = "different"
    if mutation in {"missing", "duplicate", "segment"}:
        candidate.segments = segments(candidate.results)
    with pytest.raises(ValueError):
        compare(baseline, candidate)


def test_dataset_rejects_cross_scope_expected_products_and_unknown_fields():
    data = load_dataset(DATA).model_dump(mode="json")
    data["cases"][0]["turns"][0]["expected"]["ids"] = [
        data["snapshots"][1]["products"][0]["id"]
    ]
    with pytest.raises(ValidationError):
        Dataset.model_validate(data)
    data = load_dataset(DATA).model_dump(mode="json")
    data["cases"][0]["credentials"] = "must not be accepted"
    with pytest.raises(ValidationError):
        Dataset.model_validate(data)


class PaidFake:
    model = "gpt-4.1-mini"

    def __init__(self, error=None):
        self.calls = 0
        self.error = error

    def _payload(self, request, stream):
        return {"input": "synthetic"}

    async def generate(self, request):
        self.calls += 1
        if self.error:
            raise ModelError(self.error)
        return ModelResponse("", (), None, Usage(100, 20, 120), self.model, "stop")


def test_budget_reserves_before_call_never_retries_or_refunds_failed_request():
    async def check():
        fake = PaidFake("timeout")
        capped = CappedProvider(fake, max_calls=1, cap_micros=10000)
        request = ModelRequest(messages=(Message("user", "synthetic"),), max_tokens=100)
        with pytest.raises(ModelError, match="timeout"):
            await capped.generate(request)
        reserved = capped.reserved_micros
        with pytest.raises(ModelError, match="budget_exceeded"):
            await capped.generate(request)
        assert (
            fake.calls == 1
            and 0 < reserved == capped.reserved_micros <= capped.cap_micros
        )
        tiny = CappedProvider(PaidFake(), cap_micros=1)
        with pytest.raises(ModelError, match="budget_exceeded"):
            await tiny.generate(request)
        assert tiny.provider.calls == 0

    asyncio.run(check())


def test_unpriced_model_cannot_make_a_paid_call():
    fake = PaidFake()
    fake.model = "unreviewed-model"
    with pytest.raises(ValueError):
        CappedProvider(fake)


def test_external_canary_failure_is_incomplete_and_cost_unknown():
    async def check():
        report = await run(load_dataset(DATA), CappedProvider(PaidFake("timeout")))
        assert report.status == "incomplete" and len(report.results) == 6
        assert all(
            r.status == "quarantined" and r.cost_micros is None for r in report.results
        )
        assert all(m["pass_fraction"] is None for m in report.segments.values())

    asyncio.run(check())


def test_confidence_intervals_do_not_claim_certainty_from_small_samples():
    assert wilson(0, 0) is None
    assert 0 < wilson(6, 6)[0] < 0.7
    assert wilson(0, 6)[1] > 0.3


def test_search_candidate_changes_are_paired_against_unchanged_ground_truth(baseline):
    dataset = load_dataset(DATA)
    observations = RetrievalObservations(
        dataset_sha256=dataset_digest(dataset),
        engine_revision="negative-control-empty-search",
        candidates={c.id: [] for c in dataset.cases},
    )
    candidate = asyncio.run(run(dataset, observations=observations))
    assert candidate.dataset_sha256 == baseline.dataset_sha256
    assert candidate.retrieval_sha256 and candidate.status == "failed"
    assert compare(baseline, candidate)["paired_case_regressions"]
    observations.candidates[dataset.cases[0].id] = [
        str(dataset.snapshots[1].products[0].id)
    ]
    with pytest.raises(ValueError, match="scoped snapshot"):
        asyncio.run(run(dataset, observations=observations))


def test_identity_is_stable_for_unordered_approved_phrases():
    dataset = load_dataset(DATA)
    raw = dataset.model_dump(mode="json")
    for snapshot in raw["snapshots"]:
        for answer in snapshot["policies"]["answers"]:
            answer["phrases"].reverse()
    assert dataset_digest(dataset) == dataset_digest(Dataset.model_validate(raw))


def test_empty_product_enrichment_preserves_historical_dataset_identity():
    dataset = load_dataset(DATA)
    historical = json.loads(DATA.with_name("baseline.json").read_text())
    assert dataset_digest(dataset) == historical["dataset_sha256"]
    explicit = dataset.model_dump(mode="json")
    assert all(
        p["category_names"] == [] for s in explicit["snapshots"] for p in s["products"]
    )
    assert dataset_digest(Dataset.model_validate(explicit)) == dataset_digest(dataset)


@pytest.mark.parametrize(
    "field,value", [("category_names", ["Fresh produce"]), ("name", "Changed product")]
)
def test_product_evidence_changes_still_change_dataset_identity(field, value):
    dataset = load_dataset(DATA)
    changed = dataset.model_dump(mode="json")
    changed["snapshots"][0]["products"][0][field] = value
    assert dataset_digest(Dataset.model_validate(changed)) != dataset_digest(dataset)


def test_human_review_is_pending(baseline):
    queue = review_queue(baseline)
    assert queue["status"] == "pending_human_review" and not queue["judge"]["enabled"]
    assert all(
        item["reviewer"] is None and item["scores"] is None for item in queue["items"]
    )
