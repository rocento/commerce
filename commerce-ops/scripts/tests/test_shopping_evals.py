"""Evaluation errors must not masquerade as assistant quality."""

import gzip
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location(
    "shopping_evals", SCRIPTS / "shopping-evals.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_full_corpus_unique_balanced_and_reproducible():
    rows = list(runner.generate(100000, 42))
    assert len({row["id"] for row in rows}) == 100000
    assert len({tuple(row["messages"]) for row in rows}) == 100000
    assert all(
        count == 6250 for count in runner.Counter(r["family"] for r in rows).values()
    )
    assert rows[:64] == list(runner.generate(64, 42))
    assert rows[:64] != list(runner.generate(64, 43))
    assert all(len(r["messages"]) == len(r["expectations"]) for r in rows)


def test_correct_intent_does_not_hide_wrong_price_quantity_or_product():
    expected = {
        "status": "RESOLVED",
        "intent": "ADD_TO_CART",
        "paths": {
            "entities.items.0.quantity": 2,
            "entities.items.0.productText": "apples",
            "entities.price.currency": "USD",
        },
    }
    actual = {
        "status": "RESOLVED",
        "intent": "ADD_TO_CART",
        "message": "Understood",
        "entities": {
            "items": [{"quantity": 3, "productText": "pears"}],
            "price": {"currency": "EGP"},
        },
    }
    assert {f["field"] for f in runner.score_turn(expected, actual)} == set(
        expected["paths"]
    )


def test_v2_templates_are_balanced_reproducible_and_split_without_leakage():
    rows = list(runner.corpus_v2.generate(3000, 42))
    assert len({r["id"] for r in rows}) == 3000
    assert set(runner.Counter(r["family"] for r in rows).values()) == {100}
    assert rows[:100] == list(runner.corpus_v2.generate(100, 42))
    partitions = {}
    for row in rows:
        assert len(row["messages"]) == len(row["expectations"])
        partitions.setdefault(row["template_id"], set()).add(row["split"])
    assert len(partitions) == 124
    assert all(len(p) == 1 for p in partitions.values())
    assert all(
        "plan" in r["expectations"][0] for r in rows if r["family"] == "strict_minimum"
    )
    assert all(
        r["oracle_kind"] == "human_review"
        for r in rows
        if r["family"].endswith("review")
    )


def test_v2_full_500000_capacity_unique_and_balanced():
    ids, families = set(), runner.Counter()
    for row in runner.corpus_v2.generate(500000, 20260923):
        assert row["id"] not in ids
        ids.add(row["id"])
        families[row["family"]] += 1
        assert row["language"] == "en"
        assert not re.search(
            r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]",
            " ".join(row["messages"]),
        )
    assert len(ids) == 500000
    assert len(families) == 30 and set(families.values()) == {16666, 16667}
    assert not {"arabic", "mixed_language"} & families.keys()


def test_safety_invariants_and_plan_semantics_are_separate_from_intent():
    result = {"status": "RESOLVED", "intent": "ADD_TO_CART", "message": "Okay"}
    assert (
        runner.score_turn({"forbid_resolved_intents": ["ADD_TO_CART"]}, result)[0][
            "field"
        ]
        == "safety.resolved_intent"
    )
    assert not runner.score_turn(
        {"forbid_resolved_intents": ["ADD_TO_CART"]},
        {**result, "status": "NEEDS_CONTEXT"},
    )
    expected = {"plan": {"min_price": "20", "exclusive_min": True}}
    assert (
        runner.score_turn(
            expected, result, {"min_price": "20", "exclusive_min": False}
        )[0]["field"]
        == "plan.exclusive_min"
    )
    assert not runner.score_turn(
        {"normalized_paths": {"entities.productText": "Fnd-123"}},
        {**result, "entities": {"productText": "fnd-123"}},
    )
    assert runner.score_turn(
        {"normalized_paths": {"entities.productText": "Fnd-123"}},
        {**result, "entities": {"productText": "find-123"}},
    )


def test_parallel_workers_keep_conversations_isolated_and_in_input_order(tmp_path):
    observed = []
    for workers in [1, 3]:
        output = tmp_path / str(workers)
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "shopping-evals.py"),
                "run",
                "--corpus",
                "v2",
                "--count",
                "64",
                "--workers",
                str(workers),
                "--output",
                str(output),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        cases = [json.loads(line) for line in (output / "cases.jsonl").open()]
        rows = [json.loads(line) for line in (output / "results.jsonl").open()]
        assert [r["id"] for r in rows] == [r["id"] for r in cases]
        observed.append(
            [
                (
                    r["id"],
                    r["outcome"],
                    [
                        (
                            t["result"]["status"],
                            t["result"]["entities"],
                            t["disposition"],
                        )
                        for t in r["turns"]
                    ],
                )
                for r in rows
            ]
        )
        report = json.loads((output / "report.json").read_text())
        assert sum(report["dispositions"].values()) == report["turns"]
        assert sum(c["cases"] for c in report["oracle_kinds"].values()) == 64
        assert (
            json.loads((output / "manifest.json").read_text())[
                "source_changes_during_run"
            ]
            == []
        )
    assert observed[0] == observed[1]


def test_missing_nested_value_fails_and_review_has_no_invented_oracle():
    result = {"message": "Understood", "status": "RESOLVED", "intent": "PRODUCT_SEARCH"}
    expected = {
        "status": "RESOLVED",
        "intent": "PRODUCT_SEARCH",
        "paths": {"entities.items.0.quantity": 2},
    }
    assert runner.score_turn(expected, result)[0]["actual"] is None
    assert runner.score_turn(None, result) == []
    assert runner.score_turn(None, {"message": ""})


@pytest.mark.parametrize("compressed", [False, True])
def test_semantic_success_does_not_hide_unmapped_assistant_route(tmp_path, compressed):
    rows = [
        {
            "family": "price_constraints",
            "outcome": "passed",
            "turns": [{"route": "unmapped"}],
        },
        {
            "family": "requirements_review",
            "outcome": "review",
            "turns": [{"route": "unmapped"}],
        },
    ]
    (tmp_path / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    if compressed:
        with gzip.open(tmp_path / "results.jsonl.gz", "wb") as stream:
            stream.write((tmp_path / "results.jsonl").read_bytes())
        (tmp_path / "results.jsonl").unlink()
    report = {
        "created_at": "test",
        "cases": 2,
        "turns": 2,
        "outcomes": {},
        "routes": {},
        "families": {},
        "examples": {},
        "latency_ms": {},
    }
    runner.finalize_report(report, tmp_path)
    assert report["semantic_pass_but_unmapped"] == 1
    assert report["route_gap_families"] == {
        "price_constraints": 1,
        "requirements_review": 1,
    }
    assert len((tmp_path / "route-gaps.jsonl").read_text().splitlines()) == 2


def test_real_worker_and_report_keep_denominators_and_sources_honest(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "run",
            "--count",
            "32",
            "--output",
            str(tmp_path),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads((tmp_path / "report.json").read_text())
    assert report["cases"] == 32 and report["turns"] == 36
    assert sum(report["outcomes"].values()) == 32
    assert report["outcomes"]["review"] == 2
    assert sum(report["routes"].values()) == 36
    assert report["actual_llm_calls"] == 0
    assert not report["full_assistant_evaluated"]
    assert json.loads((tmp_path / "manifest.json").read_text())["status"] == "completed"
    rows = [
        json.loads(line)
        for line in (tmp_path / "results.jsonl").read_text().splitlines()
    ]
    assert all(t["source"] == "local_engine" for row in rows for t in row["turns"])
    assert (
        sum(t["llm_fallback_eligible"] for row in rows for t in row["turns"])
        == report["routes"]["fallback"]
    )
    assert len((tmp_path / "review.jsonl").read_text().splitlines()) == 2


def test_failed_worker_produces_incomplete_manifest_not_quality_report(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "run",
            "--count",
            "1",
            "--node",
            "nonexistent-shopping-eval-node",
            "--output",
            str(tmp_path),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode != 0
    assert (
        json.loads((tmp_path / "manifest.json").read_text())["status"] == "incomplete"
    )
    assert not (tmp_path / "report.json").exists()


@pytest.mark.parametrize("count", ["0", "-1", "100001"])
def test_invalid_size_is_rejected(count, tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "generate",
            "--count",
            count,
            "--output",
            str(tmp_path),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode != 0
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "extra", [["--count", "500001"], ["--workers", "0"], ["--workers", "9"]]
)
def test_v2_limits_are_checked_before_generation(extra, tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "generate",
            "--corpus",
            "v2",
            "--output",
            str(tmp_path),
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0 and not list(tmp_path.iterdir())


def test_generation_failure_is_recorded_as_incomplete(monkeypatch, tmp_path):
    def broken(*args):
        yield next(runner.corpus_v2.generate(1))
        raise ValueError("capacity exhausted")

    monkeypatch.setattr(runner, "generate", broken)
    monkeypatch.setattr(
        sys,
        "argv",
        ["shopping-evals.py", "generate", "--count", "2", "--output", str(tmp_path)],
    )
    with pytest.raises(ValueError, match="capacity exhausted"):
        runner.main()
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["status"] == "incomplete" and manifest["stage"] == "generation"
    assert manifest["generated_cases"] == 1
    assert not (tmp_path / "report.json").exists()


def test_equivalent_add_operations_do_not_hide_ordering_or_missing_actions():
    expected = {
        "any_of_paths": {
            "operations": [
                ["ADD_ITEM", "START_CHECKOUT"],
                ["ADD_ITEM", "ADD_ITEM", "START_CHECKOUT"],
            ]
        }
    }
    for operations in [
        ["ADD_ITEM", "START_CHECKOUT"],
        ["ADD_ITEM", "ADD_ITEM", "START_CHECKOUT"],
    ]:
        assert not runner.score_turn(
            expected, {"message": "Okay", "operations": operations}
        )
    for operations in [["START_CHECKOUT"], ["START_CHECKOUT", "ADD_ITEM"], []]:
        assert runner.score_turn(
            expected, {"message": "Okay", "operations": operations}
        )


@pytest.mark.parametrize("compressed", [False, True])
def test_replay_preserves_original_observations_and_rejects_mismatched_messages(
    tmp_path,
    compressed,
):
    source, target = tmp_path / "source", tmp_path / "replay"
    subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "run",
            "--corpus",
            "v2",
            "--count",
            "32",
            "--workers",
            "2",
            "--output",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    before = (source / "results.jsonl").read_bytes()
    observations = source / "results.jsonl"
    if compressed:
        observations = source / "results.jsonl.gz"
        with gzip.open(observations, "wb") as stream:
            stream.write(before)
        (source / "results.jsonl").unlink()
    stored = observations.read_bytes()
    subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "replay",
            "--source",
            str(source),
            "--output",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert observations.read_bytes() == stored
    assert [json.loads(line) for line in (target / "results.jsonl").open()] == [
        json.loads(line) for line in before.splitlines()
    ]
    assert json.loads((target / "report.json").read_text())["replayed_observations"]
    assert not list(target.glob("worker-*.log"))
    rows = [json.loads(line) for line in before.splitlines()]
    rows[0]["messages"] = ["tampered input"]
    tampered = "".join(json.dumps(r) + "\n" for r in rows)
    if compressed:
        with gzip.open(observations, "wt", encoding="utf-8") as stream:
            stream.write(tampered)
    else:
        observations.write_text(tampered)
    bad = tmp_path / "bad"
    failed = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "shopping-evals.py"),
            "replay",
            "--source",
            str(source),
            "--output",
            str(bad),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert failed.returncode != 0
    assert json.loads((bad / "manifest.json").read_text())["status"] == "incomplete"


def test_recognized_intent_with_wrong_backend_route_fails():
    result = {"message": "Understood", "status": "RESOLVED", "intent": "CART_TOTAL"}
    expected = {"status": "RESOLVED", "intent": "CART_TOTAL", "route": "cart"}
    assert runner.score_turn(expected, result, selected_route="search") == [
        {"field": "route", "expected": "cart", "actual": "search"}
    ]
    assert runner.score_turn(expected, result, selected_route="cart") == []


def test_action_report_does_not_count_skips_or_errors_as_passes(tmp_path):
    from shopping_eval.actions import summarize_junit

    path = tmp_path / "results.xml"
    path.write_text(
        '<testsuites><testsuite><testcase name="ok"/><testcase name="bad"><failure message="wrong tool"/></testcase><testcase name="skip"><skipped/></testcase><testcase name="error"><error message="fixture failed"/></testcase></testsuite></testsuites>'
    )
    assert [r["status"] for r in summarize_junit(path)] == [
        "passed",
        "failed",
        "skipped",
        "failed",
    ]
