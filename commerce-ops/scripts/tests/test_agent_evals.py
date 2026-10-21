"""The evaluation harness must not turn missing or failed evidence into success."""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "agent_evals", Path(__file__).parents[1] / "agent-evals.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_failure_skip_and_missing_denominators(tmp_path):
    xml = tmp_path / "result.xml"
    xml.write_text(
        '<testsuite><testcase classname="gold" name="ok" time=".1"/><testcase classname="gold" name="bad" time=".2"><failure/></testcase><testcase classname="gold" name="skip"><skipped/></testcase></testsuite>'
    )
    rows = runner.python_results(xml)
    result = runner.summarize(
        rows,
        {
            "factual_correctness": ["gold"],
            "permission_scenario_failure_rate": ["gold"],
            "missing": ["absent"],
        },
    )
    assert result["factual_correctness"]["value"] == 0.5
    assert result["factual_correctness"]["skipped"] == 1
    assert result["permission_scenario_failure_rate"]["value"] == 0.5
    assert result["missing"]["value"] is None
    assert result["latency"]["p95"] == 0.2


def test_rust_output_does_not_count_summary_or_build_errors_as_passes():
    rows = runner.rust_results(
        "test a ... ok\ntest b ... FAILED\ntest c ... ignored, needs service\ntest result: FAILED. 1 passed\nerror: build failed",
        "merchant",
    )
    assert [r["status"] for r in rows] == ["passed", "failed", "skipped"]
    assert runner.rust_results("error: build failed", "merchant") == []


@pytest.mark.parametrize("status", ["passed", "failed", "skipped", "process_error"])
def test_main_exit_code_and_report_reflect_actual_evidence(
    tmp_path, monkeypatch, status
):
    manifest = tmp_path / "suite.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "python_files": ["test.py"],
                "rust_suites": [],
                "dimensions": {"factual_correctness": ["gold"]},
            }
        )
    )
    monkeypatch.setattr(runner, "MANIFEST", manifest)
    monkeypatch.setenv(
        "AGENT_EVAL_DATABASE_URL", "postgres://secret-test-only@localhost/disposable"
    )
    monkeypatch.setattr(
        runner.sys, "argv", ["agent-evals.py", "--output", str(tmp_path / "report")]
    )

    def command(args, _cwd, env, **_kwargs):
        assert "DATABASE_URL" not in env
        assert "M09_TEST_DATABASE_URL" in env
        path = Path(
            next(arg.split("=", 1)[1] for arg in args if arg.startswith("--junitxml="))
        )
        marker = (
            "<failure/>"
            if status == "failed"
            else "<skipped/>"
            if status == "skipped"
            else ""
        )
        path.write_text(
            f'<testsuite><testcase classname="gold" name="one">{marker}</testcase></testsuite>'
        )
        return subprocess.CompletedProcess(
            args,
            1 if status in ("failed", "process_error") else 0,
            "private canary: secret-test-only",
        )

    monkeypatch.setattr(runner, "command", command)
    assert runner.main() == (0 if status == "passed" else 1)
    content = (tmp_path / "report/report.json").read_text()
    assert "secret-test-only" not in content
    assert json.loads(content)["status"] == (
        "passed" if status == "passed" else "failed"
    )


def test_report_case_ids_do_not_publish_parameter_payloads():
    value = runner.case_id(
        "tests.provider", "test_invalid[secret-canary-" + "x" * 10000 + "]"
    )
    assert "secret-canary" not in value and len(value) < 240
    assert value == runner.case_id(
        "tests.provider", "test_invalid[secret-canary-" + "x" * 10000 + "]"
    )
    assert "budget-stock-variant" in runner.case_id(
        "tests.test_gold_evals", "test_gold_discovery[budget-stock-variant]"
    )
