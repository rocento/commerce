"""Local ASGI concurrency/deadline/memory acceptance; no live provider or production claims."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import asyncio
import gc
import json
import sys
import time
import tracemalloc
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "commerce-assistant-platform"), str(ROOT / "commerce-assistant-platform/tests")]
import httpx
from app.commerce_resolution_engine.contracts import ModelEvent, ModelResponse, Usage
from app.main import create_app
from test_assistant import identity


@patch("app.commerce_action_engine.application.bootstrap.build_provider")
async def run(build_provider):
    monkeypatch = pytest.MonkeyPatch()
    config, _, sign = identity.__wrapped__(monkeypatch)
    config = replace(config, concurrency=4, turn_timeout=0.15)

    class Provider:
        active = 0
        peak = 0
        delay = 0.02

        async def stream(self, _request):
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                await asyncio.sleep(self.delay)
                yield ModelEvent("text_delta", "Synthetic verified response.")
                yield ModelEvent(
                    "completed",
                    response=ModelResponse(
                        "Synthetic verified response.",
                        (),
                        None,
                        Usage(1, 1, 2),
                        "fixture",
                        "stop",
                    ),
                )
            finally:
                self.active -= 1

        async def aclose(self):
            pass

    provider = Provider()
    build_provider.return_value = provider
    app = create_app(config)
    durations = []
    statuses = []
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://local"
        ) as client,
    ):

        async def request():
            rid = str(uuid4())
            headers = sign(request_id=rid)
            started = time.monotonic()
            response = await client.post(
                "/v1/chat",
                headers=headers,
                json={"request_id": rid, "message": "Performance fixture"},
            )
            durations.append(time.monotonic() - started)
            statuses.append(response.status_code)
            if response.status_code == 200:
                assert (
                    "event: done" in response.text
                    and "event: error" not in response.text
                )
            return response

        await asyncio.gather(*(request() for _ in range(16)))
        tracemalloc.start()
        gc.collect()
        baseline = tracemalloc.get_traced_memory()[0]
        for _ in range(20):
            await asyncio.gather(*(request() for _ in range(16)))
            assert provider.active == 0
            assert (await client.get("/health")).status_code == 200
        gc.collect()
        retained = tracemalloc.get_traced_memory()[0] - baseline
        peak_memory = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        assert (
            provider.peak <= 4 and statuses.count(429) > 0 and statuses.count(200) > 0
        )
        assert all(status in (200, 429) for status in statuses)
        assert retained < 5_000_000
        provider.delay = 1
        rid = str(uuid4())
        started = time.monotonic()
        timeout = await client.post(
            "/v1/chat",
            headers=sign(request_id=rid),
            json={"request_id": rid, "message": "Deadline fixture"},
        )
        timeout_elapsed = time.monotonic() - started
        assert (
            "event: error" in timeout.text
            and timeout_elapsed < 1
            and provider.active == 0
        )
        provider.delay = 0.001
        await request()
    report = {
        "scope": "Synthetic neutral provider through the real runtime and in-process ASGI; no real network, database or vendor. Full DB persistence/ownership regressions run separately in agent-evals.",
        "requests": len(statuses),
        "accepted": statuses.count(200),
        "busy": statuses.count(429),
        "max_provider_concurrency": provider.peak,
        "request_p95_seconds": sorted(durations)[int(0.95 * (len(durations) - 1))],
        "retained_tracemalloc_bytes": retained,
        "peak_tracemalloc_bytes": peak_memory,
        "deadline_seconds": timeout_elapsed,
        "thresholds": {
            "max_concurrency": 4,
            "retained_bytes": 5_000_000,
            "deadline_seconds": 1,
        },
        "passed": True,
    }
    output = ROOT / "artifacts/agent-performance"
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "report.md").write_text(
        "# Local assistant performance acceptance\n\n"
        + report["scope"]
        + "\n\n```json\n"
        + json.dumps(report, indent=2)
        + "\n```\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:
        output = ROOT / "artifacts/agent-performance"
        output.mkdir(parents=True, exist_ok=True)
        (output / "report.json").write_text(
            json.dumps(
                {
                    "passed": False,
                    "reason": "Performance check failed; rerun for diagnostics.",
                }
            )
            + "\n"
        )
        (output / "report.md").write_text(
            "# Local assistant performance acceptance\n\nFAILED: rerun for diagnostics.\n"
        )
        raise
