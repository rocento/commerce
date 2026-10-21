"""Fail-closed local live-canary reservations; no retries or mutation capabilities."""

import json
import math

from app.commerce_resolution_engine.contracts import ModelError


class CappedProvider:
    PRICING = "https://developers.openai.com/api/docs/models/gpt-4.1-mini"

    def __init__(self, provider, max_calls=6, cap_micros=250_000):
        if provider.model not in {"gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"}:
            raise ValueError("Model needs reviewed pricing before a paid canary")
        if not 1 <= max_calls <= 20 or not 1 <= cap_micros <= 1_000_000:
            raise ValueError("Canary is bounded to 20 calls and one USD")
        self.provider, self.model = provider, provider.model
        self.max_calls, self.cap_micros = max_calls, cap_micros
        self.calls = self.spent_micros = self.reserved_micros = 0
        self.stopped = False

    async def generate(self, request):
        # Worst-case byte-token bound for text plus schema and framing headroom.
        # All input charged uncached; unused reservations are not released after errors.
        payload = self.provider._payload(request, False)
        input_bound = len(json.dumps(payload, ensure_ascii=False).encode()) + 8192
        reservation = math.ceil(input_bound * 0.40 + request.max_tokens * 1.60)
        if (
            self.stopped
            or self.calls >= self.max_calls
            or self.reserved_micros + reservation > self.cap_micros
        ):
            raise ModelError("budget_exceeded")
        self.reserved_micros += reservation
        self.calls += 1
        response = await self.provider.generate(request)
        usage = response.usage
        if (
            usage.input_tokens <= 0
            or usage.output_tokens <= 0
            or usage.input_tokens > input_bound
            or usage.output_tokens > request.max_tokens
        ):
            self.stopped = True
            raise ModelError("invalid_response")
        self.spent_micros += math.ceil(
            usage.input_tokens * 0.40 + usage.output_tokens * 1.60
        )
        return response

    def summary(self):
        return {
            "currency": "USD",
            "cap_micros": self.cap_micros,
            "reserved_micros": self.reserved_micros,
            "observed_cost_micros": self.spent_micros,
            "max_calls": self.max_calls,
            "calls": self.calls,
            "pricing_reviewed": "2026-09-21",
            "pricing_source": self.PRICING,
            "input_usd_per_million": 0.40,
            "output_usd_per_million": 1.60,
            "reservation_basis": "UTF-8 payload byte bound plus 8192 tokens, uncached input and maximum output; no reservation refunds or retries. Provider-side billing is authoritative.",
        }
