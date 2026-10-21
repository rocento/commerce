"""Provider-neutral application contracts. No transport or vendor objects."""

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel

ErrorCode = Literal[
    "configuration",
    "authentication",
    "rate_limit",
    "timeout",
    "unavailable",
    "invalid_request",
    "invalid_response",
    "refused",
    "output_limit",
    "budget_exceeded",
]


class ModelError(Exception):
    def __init__(self, code: ErrorCode):
        self.code = code
        super().__init__(f"Model request failed: {code}")


@dataclass(frozen=True)
class Message:
    role: Literal["user", "assistant"]
    text: str


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    arguments: type[BaseModel]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, object]


@dataclass(frozen=True)
class ToolResult:
    call: ToolCall
    output: str


@dataclass(frozen=True)
class ModelRequest:
    messages: tuple[Message, ...]
    instructions: str = ""
    max_tokens: int = 1024
    tools: tuple[ToolDefinition, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    output_schema: type[BaseModel] | None = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class ModelResponse:
    text: str
    tool_calls: tuple[ToolCall, ...]
    structured: BaseModel | None
    usage: Usage
    model: str
    finish_reason: Literal["stop", "tool_calls"]


@dataclass(frozen=True)
class ModelEvent:
    type: Literal["text_delta", "completed"]
    text: str = ""
    response: ModelResponse | None = None


class ModelProvider(Protocol):
    async def generate(self, request: ModelRequest) -> ModelResponse: ...

    def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]: ...

    async def aclose(self) -> None: ...
