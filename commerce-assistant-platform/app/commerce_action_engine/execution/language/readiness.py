"""Bounded, coalesced language-readiness reads; never send customer input."""

import asyncio
import time
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

LanguageState = Literal["ready", "unavailable", "not_configured", "incompatible"]


class LanguageHealth(BaseModel):
    model_config = ConfigDict(strict=True)

    status: Literal["ok"]
    resolutionContractVersion: int = Field(ge=1, le=1)
    dictionaryVersion: int = Field(gt=0)
    intents: int = Field(gt=0)
    generationFingerprint: str | None = None
    supportedResolutionContractVersions: list[int] | None = None


class LanguageReadiness:
    def __init__(
        self,
        url: str,
        expected_fingerprint: str = "",
        *,
        timeout: float = 1.5,
        cache_seconds: float = 5,
    ) -> None:
        self.url = url.rstrip("/")
        self.expected_fingerprint = expected_fingerprint
        self.timeout = timeout
        self.cache_seconds = cache_seconds
        self._expires = 0.0
        self._state: LanguageState = "unavailable"
        self._lock = asyncio.Lock()

    async def check(self, client: httpx.AsyncClient) -> LanguageState:
        if not self.url:
            return "not_configured"
        async with self._lock:
            if time.monotonic() < self._expires:
                return self._state
            try:
                async with asyncio.timeout(self.timeout):
                    async with client.stream(
                        "GET",
                        self.url + "/api/ready",
                        follow_redirects=False,
                        timeout=self.timeout,
                    ) as response:
                        response.raise_for_status()
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > 4096:
                                raise ValueError("oversized_language_health")
                health = LanguageHealth.model_validate_json(body)
                self._state = (
                    "incompatible"
                    if self.expected_fingerprint
                    and health.generationFingerprint != self.expected_fingerprint
                    else "ready"
                )
            except ValidationError:
                self._state = "incompatible"
            except (httpx.HTTPError, TimeoutError, ValueError):
                self._state = "unavailable"
            self._expires = time.monotonic() + self.cache_seconds
            return self._state
