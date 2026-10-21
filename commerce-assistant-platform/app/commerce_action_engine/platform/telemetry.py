"""Bounded per-request timing traces. Never accept prompts, payloads or arbitrary labels."""

import json
import logging
import time
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Literal

Phase = Literal["provider", "tool", "retrieval", "history", "persistence"]
_logger = logging.getLogger("assistant.performance")
_logger.setLevel(logging.INFO)
if not _logger.handlers:
    _logger.addHandler(logging.StreamHandler())
_logger.propagate = False

_current: ContextVar["TurnTrace | None"] = ContextVar("assistant_trace", default=None)


@dataclass
class TurnTrace:
    started: float = field(default_factory=time.monotonic)
    first_text_ms: int | None = None
    provider_first_token_ms: int | None = None
    spans: list[dict[str, object]] = field(default_factory=list)
    totals: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    core: dict[str, object] | None = None
    policy_decisions: list[dict[str, object]] = field(default_factory=list)
    planning: dict[str, object] | None = None
    execution: dict[str, object] | None = None

    def mark(self, provider: bool = False) -> None:
        key = "provider_first_token_ms" if provider else "first_text_ms"
        if getattr(self, key) is None:
            setattr(self, key, int((time.monotonic() - self.started) * 1000))

    def summary(self) -> dict[str, object]:
        return {
            "request_ms": int((time.monotonic() - self.started) * 1000),
            "first_text_ms": self.first_text_ms,
            "provider_first_token_ms": self.provider_first_token_ms,
            **self.totals,
        }

    def emit(self, request_id: str, outcome: str) -> None:
        _logger.info(
            json.dumps(
                {
                    "event": "assistant_turn",
                    "trace_id": request_id,
                    "outcome": outcome,
                    "timings": self.summary(),
                    "spans": self.spans,
                    **({"core": self.core} if self.core else {}),
                    **({"planning": self.planning} if self.planning else {}),
                    **({"execution": self.execution} if self.execution else {}),
                    **(
                        {"policy": self.policy_decisions}
                        if self.policy_decisions
                        else {}
                    ),
                },
                separators=(",", ":"),
            )
        )


@contextmanager
def trace_turn(trace: TurnTrace) -> Iterator[None]:
    token = _current.set(trace)
    try:
        yield
    finally:
        _current.reset(token)


def mark_provider_token() -> None:
    if trace := _current.get():
        trace.mark(provider=True)


def catalog_counter(
    name: Literal["catalog_cache_hits", "catalog_network_calls", "catalog_coalesced"],
) -> None:
    if trace := _current.get():
        trace.totals[name] += 1


@contextmanager
def phase(name: Phase) -> Iterator[None]:
    trace = _current.get()
    if trace is None:
        yield
        return
    started = time.monotonic()
    outcome = "completed"
    try:
        yield
    except BaseException as error:
        outcome = "failed"
        trace.totals[f"{name}_errors"] += 1
        if name == "provider" and getattr(error, "code", None) == "rate_limit":
            trace.totals["provider_rate_limits"] += 1
        raise
    finally:
        duration = int((time.monotonic() - started) * 1000)
        trace.totals[f"{name}_ms"] += duration
        trace.totals[f"{name}_count"] += 1
        if len(trace.spans) < 32:
            trace.spans.append(
                {
                    "span_id": f"{len(trace.spans) + 1:016x}",
                    "phase": name,
                    "offset_ms": int((started - trace.started) * 1000),
                    "ms": duration,
                    "outcome": outcome,
                }
            )


def meaning_summary(frame: object, clarification: object) -> None:
    from app.commerce_action_engine.execution.core.meaning import (
        Clarification,
        ConstraintFrame,
    )

    if (
        isinstance(frame, ConstraintFrame)
        and isinstance(clarification, Clarification)
        and (trace := _current.get())
    ):
        trace.totals["meaning_requirements"] += len(frame.requirements)
        trace.totals["meaning_conflicts"] += len(frame.conflicts)
        trace.totals["meaning_clarifications"] += int(clarification.required)
        trace.totals["meaning_assumptions"] += int(not clarification.required)


def policy_summary(decision: object) -> None:
    from app.commerce_action_engine.execution.core.policy import PolicyDecision

    if isinstance(decision, PolicyDecision) and (trace := _current.get()):
        if len(trace.policy_decisions) < 8:
            trace.policy_decisions.append(
                {
                    "policy": decision.policy,
                    "version": decision.version,
                    "outcome": decision.outcome,
                    "reason": decision.reason,
                    "risk": decision.risk.value,
                    "confirmation": decision.confirmation,
                    "expires_at": decision.expires_at,
                    "audit_ref": decision.audit_ref,
                }
            )
        trace.totals["policy_decisions"] += 1
        trace.totals[f"policy_{decision.risk.value}_{decision.outcome}"] += 1


def planning_summary(value: dict[str, object]) -> None:
    if trace := _current.get():
        trace.planning = value


def execution_summary(value: dict[str, object]) -> None:
    trace = _current.get()
    if trace:
        trace.execution = value


def discovery_summary(report: object) -> None:
    from app.commerce_action_engine.actions.catalog.discovery import DiscoveryReport

    if isinstance(report, DiscoveryReport) and (trace := _current.get()):
        for name in (
            "lexical_candidates",
            "relation_candidates",
            "evaluated",
            "eligible",
            "returned",
        ):
            trace.totals["discovery_" + name] += getattr(report, name)
        trace.totals["discovery_" + report.outcome] += 1
