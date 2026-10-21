"""OpenAI embeddings transport. Output is a validated provider-neutral vector batch."""

import asyncio
import json

import httpx

from app.commerce_contracts.embeddings import DIMENSIONS, validate_vectors
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers.openai import MAX_BYTES, OpenAIProvider


class OpenAIEmbeddings(OpenAIProvider):
    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not 1 <= len(texts) <= 16 or any(
            not t.strip() or len(t) > 4000 for t in texts
        ):
            raise ModelError("invalid_request")
        try:
            async with asyncio.timeout(self.timeout):
                async with self.client.stream(
                    "POST",
                    self.url.replace("/responses", "/embeddings"),
                    json={
                        "model": self.model,
                        "input": texts,
                        "dimensions": DIMENSIONS,
                        "encoding_format": "float",
                    },
                ) as response:
                    self._status(response.status_code)
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > MAX_BYTES:
                            raise ModelError("output_limit")
                    payload = json.loads(data)
                    items = payload["data"]
                    if len(items) != len(texts) or any(
                        type(i["index"]) is not int for i in items
                    ):
                        raise ValueError()
                    if {i["index"] for i in items} != set(range(len(texts))):
                        raise ValueError()
                    vectors = [
                        item["embedding"]
                        for item in sorted(items, key=lambda i: i["index"])
                    ]
                    validate_vectors(vectors, len(texts))
                    return vectors
        except (TimeoutError, httpx.TimeoutException):
            raise ModelError("timeout") from None
        except httpx.HTTPError:
            raise ModelError("unavailable") from None
        except (ValueError, KeyError, TypeError):
            raise ModelError("invalid_response") from None
