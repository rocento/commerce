"""Validated interpretation ports for deterministic follow-up policies."""

from typing import Protocol

from pydantic import JsonValue

from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)


class FollowupInterpretation(Protocol):
    @property
    def result(self) -> InterpretedRequest | InterpretationFailure: ...

    @property
    def route(self) -> str: ...


class FollowupInterpreter[Result: FollowupInterpretation](Protocol):
    async def resolve(
        self, text: str, *, context: dict[str, JsonValue] | None = None
    ) -> Result: ...

    def question(
        self, text: str, *, intent: str | None = None, confidence: float = 0
    ) -> Result: ...

    def clarify(
        self,
        previous: Result,
        message: str,
        *,
        missing: list[str] | None = None,
        reset_confidence: bool = True,
    ) -> Result: ...

    def with_entities(
        self, previous: Result, entities: dict[str, JsonValue]
    ) -> Result: ...

    def has_plan(
        self, interpretation: Result, text: str, *, complete: bool
    ) -> bool: ...
