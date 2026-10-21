"""OpenAI Responses HTTP adapter; vendor payloads stop at this boundary."""

import asyncio
import json
import re
from collections.abc import AsyncGenerator
from contextlib import aclosing
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelEvent,
    ModelRequest,
    ModelResponse,
    ToolCall,
    Usage,
)

from .diagnostics import dispatched, prepared, provider_capture

DIRECT_URL = "https://api.openai.com/v1/responses"
PROXY_URL = "http://assistant-provider:8082/v1/responses"
MAX_BYTES = 1_048_576
MAX_INVALID_OUTPUT_BYTES = 16_384
MAX_VALIDATION_ISSUES = 16


def _record_invalid_response(
    data: Any,
    request: ModelRequest,
    phase: str,
    answer: str | None,
    validation_error: ValidationError | None = None,
) -> None:
    """Record bounded evidence only in the existing private operator capture."""
    if request.output_schema is None:
        return
    from app.commerce_resolution_engine.diagnostics import debug_record

    diagnostic: dict[str, Any] = {
        "phase": phase,
        "output_schema": request.output_schema.__name__,
    }
    if answer is not None:
        encoded = answer.encode("utf-8", errors="replace")
        diagnostic["model_output"] = encoded[:MAX_INVALID_OUTPUT_BYTES].decode(
            "utf-8", errors="ignore"
        )
        diagnostic["model_output_truncated"] = len(encoded) > MAX_INVALID_OUTPUT_BYTES
    if validation_error is not None:
        # Pydantic messages, input and validator context can contain sensitive
        # values. Unknown field names are data too, so exclude them from locations.
        fields = set(request.output_schema.model_fields)
        issues = validation_error.errors(
            include_url=False, include_context=False, include_input=False
        )
        diagnostic["validation_issues"] = [
            {
                "type": issue["type"]
                if re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}", issue["type"])
                else "unknown",
                "location": [
                    part
                    if type(part) is int or (isinstance(part, str) and part in fields)
                    else "unknown_field"
                    for part in issue["loc"][:8]
                ],
            }
            for issue in issues[:MAX_VALIDATION_ISSUES]
        ]
        diagnostic["validation_issues_truncated"] = len(issues) > MAX_VALIDATION_ISSUES
    raw_usage = data.get("usage") if isinstance(data, dict) else None
    if isinstance(raw_usage, dict):
        counts = {
            key: raw_usage[key]
            for key in ("input_tokens", "output_tokens", "total_tokens")
            if type(raw_usage.get(key)) is int and 0 <= raw_usage[key] <= 2**63 - 1
        }
        if counts:
            diagnostic["reported_usage"] = {
                "validation": "unverified_provider_counts",
                **counts,
            }
    debug_record("provider_invalid_response", diagnostic)


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Require closed objects so local validation cannot silently drop model fields."""
    schema = model.model_json_schema()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("type") == "object":
                if value.get("additionalProperties") is not False:
                    raise ModelError("invalid_request")
                value["required"] = list(value.get("properties", {}))
            value.pop("default", None)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(schema)
    return schema


class OpenAIProvider:
    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        timeout: float = 20,
        url: str = DIRECT_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        if (
            not model.strip()
            or not api_key.strip()
            or url not in (DIRECT_URL, PROXY_URL)
        ):
            raise ModelError("configuration")
        if not 0 < timeout <= 120:
            raise ModelError("configuration")
        self.model = model
        self.timeout = timeout
        self.url = url
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(timeout, connect=min(timeout, 5)),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    def _payload(self, request: ModelRequest, stream: bool) -> dict[str, Any]:
        if not 1 <= request.max_tokens <= 16384 or not request.messages:
            raise ModelError("invalid_request")
        if len(request.messages) > 64 or len(request.tools) > 32:
            raise ModelError("invalid_request")
        names = [tool.name for tool in request.tools]
        if len(set(names)) != len(names) or any(
            not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name) for name in names
        ):
            raise ModelError("invalid_request")
        inputs: list[dict[str, Any]] = []
        for message in request.messages:
            if not isinstance(message, Message) or message.role not in (
                "user",
                "assistant",
            ):
                raise ModelError("invalid_request")
            inputs.append({"role": message.role, "content": message.text})
        for result in request.tool_results:
            inputs.extend(
                [
                    {
                        "type": "function_call",
                        "call_id": result.call.id,
                        "name": result.call.name,
                        "arguments": json.dumps(result.call.arguments),
                    },
                    {
                        "type": "function_call_output",
                        "call_id": result.call.id,
                        "output": result.output,
                    },
                ]
            )
        payload: dict[str, Any] = {
            "model": self.model,
            "input": inputs,
            "instructions": request.instructions,
            "max_output_tokens": request.max_tokens,
            "store": False,
            "stream": stream,
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": strict_schema(tool.arguments),
                    "strict": True,
                }
                for tool in request.tools
            ]
        if request.output_schema:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "result",
                    "strict": True,
                    "schema": strict_schema(request.output_schema),
                }
            }
        try:
            if len(json.dumps(payload, allow_nan=False).encode()) > 131072:
                raise ModelError("invalid_request")
        except (ValueError, TypeError):
            raise ModelError("invalid_request") from None
        from app.commerce_resolution_engine.diagnostics import debug_record

        debug_record("provider_wire_payload", payload)
        prepared(payload)
        return payload

    @staticmethod
    def _status(status: int) -> None:
        if 200 <= status < 300:
            return
        if status in (401, 403):
            raise ModelError("authentication")
        if status == 429:
            raise ModelError("rate_limit")
        if status in (408, 504):
            raise ModelError("timeout")
        if status >= 500:
            raise ModelError("unavailable")
        raise ModelError("invalid_request")

    def _parse(self, data: Any, request: ModelRequest) -> ModelResponse:
        phase = "response_envelope"
        answer: str | None = None
        try:
            if not isinstance(data, dict):
                raise TypeError()
            status = data.get("status")
            if status == "incomplete":
                raise ModelError("output_limit")
            if status == "failed":
                code = (data.get("error") or {}).get("code")
                raise ModelError(
                    "rate_limit" if code == "rate_limit_exceeded" else "unavailable"
                )
            if status != "completed" or not isinstance(data["output"], list):
                raise ValueError()
            text: list[str] = []
            calls: list[ToolCall] = []
            definitions = {tool.name: tool for tool in request.tools}
            phase = "response_output"
            for item in data["output"]:
                if item["type"] == "message":
                    if item.get("role") != "assistant":
                        raise ValueError()
                    for content in item["content"]:
                        if content["type"] == "refusal":
                            raise ModelError("refused")
                        if content["type"] != "output_text" or not isinstance(
                            content["text"], str
                        ):
                            raise ValueError()
                        text.append(content["text"])
                elif item["type"] == "function_call":
                    name, call_id = item["name"], item["call_id"]
                    if (
                        name not in definitions
                        or not isinstance(call_id, str)
                        or not call_id
                    ):
                        raise ValueError()
                    phase = "tool_arguments"
                    args = definitions[name].arguments.model_validate_json(
                        item["arguments"], strict=True
                    )
                    calls.append(ToolCall(call_id, name, args.model_dump(mode="json")))
                    phase = "response_output"
                elif item["type"] != "reasoning":
                    # Never pass provider-hosted tools or reasoning to application code.
                    raise ValueError()
            if len(calls) > 32 or len({call.id for call in calls}) != len(calls):
                raise ValueError()
            answer = "".join(text)
            if not answer and not calls:
                raise ValueError()
            structured = None
            if request.output_schema and not calls:
                phase = "structured_output"
                structured = request.output_schema.model_validate_json(
                    answer, strict=True
                )
            phase = "response_usage"
            raw_usage = data["usage"]
            values = [
                raw_usage[key]
                for key in ("input_tokens", "output_tokens", "total_tokens")
            ]
            if (
                any(type(v) is not int or v < 0 for v in values)
                or values[2] != values[0] + values[1]
            ):
                raise ValueError()
            phase = "response_model"
            model = data["model"]
            if not isinstance(model, str) or not model:
                raise ValueError()
            return ModelResponse(
                answer,
                tuple(calls),
                structured,
                Usage(*values),
                model,
                "tool_calls" if calls else "stop",
            )
        except ValidationError as error:
            _record_invalid_response(data, request, phase, answer, error)
            raise ModelError("invalid_response") from None
        except (ValueError, KeyError, TypeError, AttributeError):
            _record_invalid_response(data, request, phase, answer)
            raise ModelError("invalid_response") from None

    async def generate(self, request: ModelRequest) -> ModelResponse:
        with provider_capture(self.model, "generate") as capture:
            response = await self._generate(request)
            if capture is not None:
                capture.complete(response)
            return response

    async def _generate(self, request: ModelRequest) -> ModelResponse:
        payload = self._payload(request, False)
        try:
            async with asyncio.timeout(self.timeout):
                dispatched()
                async with self.client.stream(
                    "POST", self.url, json=payload
                ) as response:
                    self._status(response.status_code)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            raise ModelError("output_limit")
                    return self._parse(json.loads(body), request)
        except (TimeoutError, httpx.TimeoutException):
            raise ModelError("timeout") from None
        except httpx.HTTPError:
            raise ModelError("unavailable") from None
        except (ValueError, UnicodeError):
            raise ModelError("invalid_response") from None

    async def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        with provider_capture(self.model, "stream") as capture:
            async with aclosing(self._stream(request)) as stream:
                async for event in stream:
                    if (
                        capture is not None
                        and event.type == "completed"
                        and event.response is not None
                    ):
                        capture.complete(event.response)
                    yield event

    async def _stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        payload = self._payload(request, True)
        try:
            async with asyncio.timeout(self.timeout):
                dispatched()
                async with self.client.stream(
                    "POST", self.url, json=payload
                ) as response:
                    self._status(response.status_code)
                    if "text/event-stream" not in response.headers.get(
                        "content-type", ""
                    ):
                        raise ModelError("invalid_response")
                    total = 0
                    buffer = b""
                    lines: list[bytes] = []
                    deltas: list[str] = []
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_BYTES:
                            raise ModelError("output_limit")
                        buffer += chunk
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            line = line.rstrip(b"\r")
                            if line:
                                if line.startswith(b"data:"):
                                    lines.append(line[5:].lstrip(b" "))
                                continue
                            if not lines:
                                continue
                            event = json.loads(b"\n".join(lines))
                            lines = []
                            kind = event["type"]
                            if kind == "response.output_text.delta":
                                delta = event["delta"]
                                if not isinstance(delta, str):
                                    raise ModelError("invalid_response")
                                deltas.append(delta)
                                # Structured JSON is released only after final schema validation.
                                if not request.output_schema:
                                    yield ModelEvent("text_delta", text=delta)
                            elif kind in (
                                "response.completed",
                                "response.failed",
                                "response.incomplete",
                            ):
                                result = self._parse(event["response"], request)
                                if result.text != "".join(deltas):
                                    raise ModelError("invalid_response")
                                yield ModelEvent("completed", response=result)
                                return
                            elif kind == "error":
                                raise ModelError(
                                    "rate_limit"
                                    if event.get("code") == "rate_limit_exceeded"
                                    else "unavailable"
                                )
                    raise ModelError(
                        "invalid_response"
                    )  # Truncated stream is never success.
        except (TimeoutError, httpx.TimeoutException):
            raise ModelError("timeout") from None
        except httpx.HTTPError:
            raise ModelError("unavailable") from None
        except (ValueError, KeyError, TypeError, UnicodeError):
            raise ModelError("invalid_response") from None
