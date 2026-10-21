"""Loopback-only manual integration lab: real engine/runtime, fixture catalog, no paid LLM."""

import json
import os
from functools import partial
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.handlers.guidance import guidance
from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    reasoning_fallback_message,
)
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.agents import Principal, default_agents
from app.commerce_action_engine.execution.language import gate as language_gate
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.runtime import AgentRuntime

app = FastAPI()
WHO = Principal(tenant=UUID(int=1), persona="shopper")


class OfflineProvider:
    async def generate(self, request):
        raise ModelError("unavailable")


class Input(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


def catalog(request):
    body = json.loads(request.content)
    if body["name"] == "get_catalog_schema":
        return httpx.Response(
            200,
            json={
                "products": [],
                "category": None,
                "catalog_schema": {
                    "industry": "grocery",
                    "version": "lab-1",
                    "attributes": [],
                },
            },
        )
    products = []
    for n, name, category, price in [
        (11, "Apples", "apple", "2.50"),
        (12, "Bananas", "banana", "3.00"),
        (13, "Milk", "milk", "4.00"),
    ]:
        products.append(
            {
                "id": str(UUID(int=n)),
                "name": name,
                "price": price,
                "currency": "USD",
                "category_id": str(UUID(int=n + 100)),
                "category_name": category,
                "product_type": "simple",
                "attributes": [],
                "in_stock": True,
                "route": f"/products/{UUID(int=n)}",
            }
        )
    # Real shopping verification filters these fixture facts against the plan.
    return httpx.Response(200, json={"products": products, "category": None})


@app.get("/", response_class=HTMLResponse)
async def index():
    return Path(__file__).with_suffix(".html").read_text()


@app.post("/api/chat")
async def chat(body: Input):
    result = await language_gate.resolve(
        os.getenv("AI_LANGUAGE_ENGINE_URL", "http://127.0.0.1:3187"), body.message
    )
    identity = str(uuid4())
    context = TurnContext(
        actor=ActorContext(
            tenant_id=str(WHO.tenant),
            store_id=str(WHO.tenant),
            session_id=identity,
            request_id=identity,
            channel="evaluation",
        )
    )
    decision = interpret_resolution(result, context)
    route = decision.route
    output = {
        "engine": result.model_dump() if result else None,
        "route": route,
        "model_calls": 0,
        "blocks": [],
        "tools": [],
    }
    if route == "unavailable":
        output["message"] = (
            "The language engine is unavailable. Please try again shortly."
        )
    elif isinstance(decision.result, InterpretedRequest) and route in {
        "clarify",
        "guided_action",
        "engine_response",
    }:
        output["message"] = (
            result.message
            if route != "guided_action"
            else result.message + "\n\n" + guidance(decision.result)
        )
    elif route == "reorder":
        output["message"] = (
            "The engine recognized a reorder. The connected assistant can place it using the signed commerce API. This fixture lab never creates orders."
        )
    elif route == "cart":
        output["message"] = (
            "Your demo cart is empty. This lab does not access your real cart."
        )
    elif route == "order":
        output["message"] = (
            "Choose an order in My orders. This lab does not access real orders."
        )
    else:
        try:
            async with httpx.AsyncClient(
                base_url="http://fixture", transport=httpx.MockTransport(catalog)
            ) as client:
                runtime = AgentRuntime(
                    default_agents(WHO.tenant),
                    {"default": OfflineProvider()},
                    registry(client, "lab-token", WHO, {}),
                    shopping=True,
                    shopping_handler=partial(
                        shopping_answer, interpretation=decision.result
                    ),
                )
                async for event in runtime.stream(
                    agent_id="shopper",
                    principal=WHO,
                    message=body.message,
                    fallback_message=reasoning_fallback_message(decision.result),
                ):
                    if event.type == "tool_started":
                        output["tools"].append(event.text)
                    if event.answer:
                        output["message"] = event.answer.text
                        output["blocks"] = [
                            b.model_dump(mode="json", exclude_none=True)
                            for b in event.answer.blocks
                        ]
                        output["model"] = event.answer.model
        except ModelError:
            output.update(
                route="llm_fallback",
                message="This request needs the LLM fallback. The local lab has paid model calls disabled; the connected assistant uses its configured model.",
            )
    return output
