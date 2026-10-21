"""Per-turn event sequencing, response evidence and provider usage accounting."""

from collections.abc import Mapping
from uuid import UUID

from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.platform import Settings, TurnTrace, estimated_micros
from app.commerce_action_engine.platform.completion import completion_metadata
from app.commerce_resolution_engine.admission import ReasoningGateway
from app.commerce_resolution_engine.diagnostics import capture_enabled, provider_totals


class TurnOutput:
    def __init__(
        self,
        request_id: UUID,
        config: Settings,
        active_config: Settings,
        tracked: Mapping[str, ReasoningGateway],
        trace: TurnTrace,
    ):
        self.request_id = request_id
        self.config = config
        self.active_config = active_config
        self.tracked = tracked
        self.trace = trace
        self.sequence = 0
        self.answer: list[str] = []
        self.blocks: list[dict[str, object]] = []
        self._metadata: dict[str, object] = {}

    @property
    def metadata(self) -> dict[str, object]:
        """One mutable record shared by routing, responses and final completion."""
        return self._metadata

    def diagnostic_evidence(self) -> dict[str, object]:
        """Selected private capture facts; reuse application completion policy."""
        if not capture_enabled():
            return {}
        completion = self.metadata.get("completion")
        timings = self.trace.summary()
        return {
            "completion": {
                key: completion[key]
                for key in (
                    "version",
                    "status",
                    "request_completed",
                    "task_completed",
                    "evidence",
                    "intent",
                    "mode",
                    "clarification_reply",
                    "clarification_recovered",
                )
                if key in completion
            }
            if isinstance(completion, dict)
            else None,
            "measurements": {
                "version": 1,
                "clock_domain": "python-turn-monotonic",
                "trace_id": str(self.request_id),
                "unit": "ms",
                "request_duration_ms": timings["request_ms"],
                "duration_boundary": "turn_start_to_lease_closed",
                "first_text_ms": timings["first_text_ms"],
                "first_text_boundary": "server_text_event_created",
            },
            "provider_totals": provider_totals(),
        }

    def usage_metadata(self) -> dict[str, object]:
        completed = [p for p in self.tracked.values() if p.calls]
        result: dict[str, object] = {
            "model_attempts": sum(p.attempts for p in self.tracked.values()),
            "model_calls": sum(p.calls for p in completed),
        }
        if not completed:
            return result
        result.update(
            {
                "provider": self.active_config.model_provider,
                "model": completed[0].model
                if len({p.model for p in completed}) == 1
                else "multiple",
                "input_tokens": sum(p.input_tokens for p in completed),
                "output_tokens": sum(p.output_tokens for p in completed),
            }
        )
        cost = 0
        priced = True
        for name, provider in self.tracked.items():
            if not provider.calls:
                continue
            ip, op = (
                (
                    self.config.small_model_input_micros_per_1k,
                    self.config.small_model_output_micros_per_1k,
                )
                if name == "extraction"
                else (
                    self.config.model_input_micros_per_1k,
                    self.config.model_output_micros_per_1k,
                )
            )
            priced = priced and bool(ip and op)
            cost += estimated_micros(
                provider.input_tokens, provider.output_tokens, ip, op
            )
        if priced:
            result["estimated_cost_micros"] = cost
        return result

    def record_completion(
        self,
        *,
        outcome: str,
        clarification_reply: bool,
        prior_completion: dict[str, object] | None,
    ) -> None:
        self.metadata.update(
            completion_metadata(
                self.metadata,
                outcome=outcome,
                blocks=self.blocks,
                clarification_reply=clarification_reply,
                prior_completion=prior_completion,
            )
        )

    def event(
        self, kind: str, *, fallback_model_used: bool = False, **fields: object
    ) -> AssistantEvent:
        if fields.get("code") in {"unavailable", "login_required"}:
            self.metadata["completion_disposition"] = (
                "denied" if fields["code"] == "login_required" else "unavailable"
            )
        if kind in {
            "message.delta",
            "content.blocks",
            "card.order",
            "ticket.created",
            "error",
            "done",
        }:
            fields["response_source"] = (
                "L"
                if fallback_model_used or any(p.attempts for p in self.tracked.values())
                else "R"
            )
        rich = fields.get("blocks")
        if kind == "content.blocks" and isinstance(rich, list):
            self.blocks.extend(
                block.model_dump(mode="json") if hasattr(block, "model_dump") else block
                for block in rich
            )
        if kind == "message.delta" and isinstance(fields.get("text"), str):
            self.answer.append(str(fields["text"]))
        event = AssistantEvent.model_validate(
            {
                "version": "1",
                "request_id": self.request_id,
                "sequence": self.sequence,
                "type": kind,
                **fields,
            }
        )
        if kind == "message.delta" and isinstance(fields.get("text"), str):
            self.trace.mark()
        self.sequence += 1
        return event
