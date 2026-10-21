"""Independent catalog oracles and paired, segment-level regression checks."""

import json
import math
from decimal import Decimal

from evals.lab.catalog_oracle import dynamic_assertions
from evals.lab.models import CaseResult, Failure, Report


def wilson(passed: int, total: int):
    if not total:
        return None
    z = 1.959963984540054
    p = passed / total
    den = 1 + z * z / total
    mid = (p + z * z / (2 * total)) / den
    radius = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / den
    return [max(0, mid - radius), min(1, mid + radius)]


def segments(rows: list[CaseResult]):
    groups = {}
    for row in rows:
        for key in [
            f"store:{row.store}",
            f"language:{row.language}",
            f"journey:{row.journey}",
            f"suite:{row.suite}",
            f"store_language:{row.store}:{row.language}",
        ]:
            groups.setdefault(key, []).append(row)
    result = {}
    for name, values in sorted(groups.items()):
        executed = [r for r in values if r.status in {"passed", "failed"}]
        passed = sum(r.status == "passed" for r in executed)
        times = sorted(r.latency_ms for r in executed)
        costs = [r.cost_micros for r in executed]
        result[name] = {
            "passed": passed,
            "executed": len(executed),
            "total": len(values),
            "quarantined": sum(r.status == "quarantined" for r in values),
            "not_run": sum(r.status == "not_run" for r in values),
            "pass_fraction": passed / len(executed) if executed else None,
            "wilson_95": wilson(passed, len(executed)),
            "safety_failures": sum(f.safety for r in values for f in r.failures),
            "p95_ms": times[math.ceil(0.95 * len(times)) - 1] if times else None,
            "provider_calls_per_passed_scenario": sum(
                r.provider_calls for r in executed
            )
            / passed
            if passed
            else None,
            "cost_micros_per_passed_scenario": sum(costs) / passed
            if passed and all(c is not None for c in costs)
            else None,
        }
    return result


def catalog_assertions(blocks, text, snapshot, expected, *, pending=None, frame=None):
    failures = []

    def check(ok, assertion, layer, safety=False):
        if not ok:
            failures.append(Failure(assertion=assertion, layer=layer, safety=safety))

    products = {str(p.id): p for p in snapshot.products}
    cards = [p for block in blocks for p in block.products or []]
    ids = [str(p.id) for p in cards]
    check(len(ids) == len(set(ids)), "duplicate_recommendation", "ranking")
    check(len(ids) >= expected.min_results, "useful_result_missing", "retrieval")
    if expected.ids is not None:
        check(ids == expected.ids, "expected_selection_order", "ranking")
    for card in cards:
        product = products.get(str(card.id))
        check(product is not None, "invented_or_cross_scope_product", "tool", True)
        if product is None:
            continue
        check(
            card.price == product.price and card.currency == product.currency,
            "authoritative_price_currency",
            "tool",
            True,
        )
        check(
            card.in_stock == product.in_stock,
            "authoritative_availability",
            "tool",
            True,
        )
        check(card.route == product.route, "scoped_product_route", "tool", True)
        if expected.currency:
            check(
                card.currency == expected.currency,
                "hard_currency",
                "understanding",
                True,
            )
        if expected.max_price:
            limit = Decimal(expected.max_price)
            check(
                Decimal(card.price) < limit
                if expected.exclusive_max
                else Decimal(card.price) <= limit,
                "hard_budget",
                "understanding",
                True,
            )
        if expected.in_stock:
            check(card.in_stock is True, "hard_in_stock", "retrieval", True)
        facts = {}
        for attribute in product.attributes:
            try:
                value = json.loads(attribute.value)
            except ValueError:
                value = attribute.value
            facts[attribute.name] = (value, attribute.source)
        for name, value in expected.attributes.items():
            fact = facts.get(name)
            check(
                fact is not None
                and str(fact[0]).casefold() == value.casefold()
                and fact[1] in {"MERCHANT", "VERIFIED", "IMPORTED"},
                "hard_attribute:" + name,
                "understanding",
                True,
            )
    for block in blocks:
        if block.products:
            check(
                [str(s.product_id) for s in block.sources or []]
                == [str(p.id) for p in block.products],
                "catalog_citations",
                "tool",
                True,
            )
    for phrase in expected.text_all:
        # v1 datasets predate the approved store-scoped no-match copy. Preserve
        # their factual oracle and frozen identity while accepting the reviewed
        # equivalent wording; no other expected explanation is broadened.
        approved_equivalent = (
            phrase == "No verified matches"
            and "I couldn’t find products matching your request in this store.".casefold()
            in text.casefold()
        )
        check(
            phrase.casefold() in text.casefold() or approved_equivalent,
            "required_explanation",
            "understanding",
        )
    for phrase in expected.text_none:
        check(
            phrase.casefold() not in text.casefold(),
            "unsupported_claim_or_injection",
            "policy",
            True,
        )
    failures.extend(dynamic_assertions(blocks, snapshot, expected, pending, frame))
    return failures


def compare(baseline: Report, candidate: Report, thresholds=None):
    for report in (baseline, candidate):
        if not report.results or len({r.id for r in report.results}) != len(
            report.results
        ):
            raise ValueError("Missing or duplicated case evidence")
        if report.segments != segments(report.results):
            raise ValueError("Segment metrics do not match case evidence")
    if (
        baseline.dataset_sha256 != candidate.dataset_sha256
        or baseline.mode != candidate.mode
        or baseline.scope_sha256 != candidate.scope_sha256
        or baseline.scope_id != candidate.scope_id
        or baseline.excluded_cases != candidate.excluded_cases
    ):
        raise ValueError(
            "Comparison requires the same dataset, execution mode and explicit scope"
        )
    before = {r.id: r for r in baseline.results}
    after = {r.id: r for r in candidate.results}
    if set(before) != set(after):
        raise ValueError("Case set changed; missing evidence cannot pass")
    for key, prior_case in before.items():
        if any(
            getattr(prior_case, field) != getattr(after[key], field)
            for field in ("store", "language", "journey", "suite")
        ):
            raise ValueError("Case segment changed")
    regressions = [
        key
        for key in before
        if before[key].status == "passed" and after[key].status != "passed"
    ]
    safety = [r.id for r in candidate.results if any(f.safety for f in r.failures)]
    differences = {}
    for key, metric in candidate.segments.items():
        prior = baseline.segments[key]
        delta = (
            metric["pass_fraction"] - prior["pass_fraction"]
            if metric["pass_fraction"] is not None
            and prior["pass_fraction"] is not None
            else None
        )
        differences[key] = {"baseline": prior, "candidate": metric, "delta": delta}
    gate_errors = []
    if thresholds:
        if (
            thresholds["dataset_sha256"] != baseline.dataset_sha256
            or thresholds["mode"] != baseline.mode
            or thresholds.get("scope_sha256") != baseline.scope_sha256
        ):
            raise ValueError("Threshold baseline identity mismatch")
        if set(thresholds["segments"]) != set(baseline.segments):
            raise ValueError("Threshold segments changed")
        for key, rule in thresholds["segments"].items():
            observed = candidate.segments[key]
            if (
                observed["not_run"]
                or observed["quarantined"]
                or observed["executed"] < rule["minimum_cases"]
            ):
                gate_errors.append(key + ":incomplete")
            if (
                observed["pass_fraction"] is not None
                and rule["target"] is not None
                and observed["pass_fraction"]
                < rule["target"] - rule["maximum_regression"]
            ):
                gate_errors.append(key + ":quality_regression")
    return {
        "version": "1",
        "status": "failed"
        if regressions
        or safety
        or gate_errors
        or candidate.status != "passed"
        or any(r.status != "passed" or r.failures for r in candidate.results)
        else "passed",
        "paired_case_regressions": regressions,
        "candidate_failures": [
            r.id for r in candidate.results if r.status == "failed" or r.failures
        ],
        "incomplete_cases": [
            r.id for r in candidate.results if r.status in {"quarantined", "not_run"}
        ],
        "safety_failures": safety,
        "threshold_errors": gate_errors,
        "segments": differences,
    }


def thresholds_after_baseline(report: Report):
    return {
        "version": "1",
        "dataset_sha256": report.dataset_sha256,
        "mode": report.mode,
        "scope_sha256": report.scope_sha256,
        "basis": "Observed baseline, zero loss on paired passing cases; Wilson intervals describe this finite case sample, not production prevalence.",
        "segments": {
            key: {
                "baseline": m["pass_fraction"],
                "target": m["pass_fraction"],
                "wilson_95": m["wilson_95"],
                "maximum_regression": 0,
                "minimum_cases": m["executed"],
                "status": "measured" if m["executed"] else "unavailable",
            }
            for key, m in report.segments.items()
        },
    }
