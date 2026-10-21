"""Execute production shopping paths against bounded frozen tool observations."""

import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx

from app.commerce_action_engine.adapters.core import (
    CommerceCatalogAdapter,
    SystemClock,
)
from app.commerce_action_engine.adapters.reasoning import reasoning_adapter
from app.commerce_action_engine.application.baskets import plan_basket
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.agents import Principal, default_agents
from app.commerce_action_engine.execution.core.facade import CompatibilityFacade
from app.commerce_action_engine.execution.core.library import (
    build_registry,
    provider_capabilities,
)
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelResponse,
    ToolCall,
    Usage,
)
from app.commerce_resolution_engine.runtime import RuntimeErrorCode
from evals.lab.catalog_oracle import frozen_profile
from evals.lab.models import CaseResult, Failure, Report
from evals.lab.scoring import catalog_assertions, segments


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def runtime_digest():
    root = Path(__file__).parents[2]
    files = sorted((root / "app").rglob("*.py")) + sorted(
        (root / "evals/lab").glob("*.py")
    )
    return digest(
        {
            str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files
        }
    )


def dataset_digest(dataset):
    data = dataset.model_dump(mode="json")
    # Approved phrase sets are unordered. Their serialized order must not alter identity.
    for snapshot in data["snapshots"]:
        if not snapshot.get("catalog_complete"):
            snapshot.pop("catalog_complete", None)
        if snapshot.get("category_memberships") == {}:
            snapshot.pop("category_memberships", None)
        if snapshot["catalog_schema"].get("categories") == []:
            snapshot["catalog_schema"].pop("categories", None)
            if snapshot["catalog_schema"].get("categories_complete") is True:
                snapshot["catalog_schema"].pop("categories_complete", None)
        for attribute in snapshot["catalog_schema"]["attributes"]:
            if attribute.get("description") in (None, ""):
                attribute.pop("description", None)
        # Product enrichment added this optional default after the v1 baseline.
        # Empty names add no evidence; real category names must still bind identity.
        for product in snapshot["products"]:
            if product.get("category_names") == []:
                product.pop("category_names")
            if product.get("category_ids") == []:
                product.pop("category_ids")
        for answer in snapshot["policies"]["answers"]:
            answer["phrases"] = sorted(answer["phrases"])
    extension_defaults = {
        "predicates": [],
        "category_ids": [],
        "excluded_ids": [],
        "min_price": None,
        "exclusive_min": False,
        "forbid_results": False,
        "require_eligible": False,
        "allow_clarification": False,
        "clarification": None,
        "preserved_paths": {},
    }
    for case in data["cases"]:
        for turn in case["turns"]:
            if turn.get("language_result") is None:
                turn.pop("language_result", None)
            for field, default in extension_defaults.items():
                if turn["expected"].get(field) == default:
                    turn["expected"].pop(field, None)
    return digest(data)


class ScriptedProvider:
    def __init__(self, output, fault=None):
        self.output, self.fault = output, fault

    async def generate(self, request):
        if self.fault in {"timeout", "rate_limit", "invalid_response"}:
            raise ModelError(self.fault)
        calls = (
            (ToolCall("blocked", "place_order", {}),)
            if self.fault == "unauthorized_tool"
            else ()
        )
        return ModelResponse(
            "UNTRUSTED MODEL PROSE",
            calls,
            request.output_schema.model_validate(self.output),
            Usage(0, 0, 0),
            "scripted-extraction",
            "stop",
        )


class ObservedProvider:
    def __init__(self, delegate):
        self.delegate = delegate
        self.calls = 0
        self.responses = []

    async def generate(self, request):
        # The eval has no model-callable mutation tools, including in live mode.
        if request.tools or request.tool_results:
            raise RuntimeErrorCode("tool_not_allowed")
        self.calls += 1
        response = await self.delegate.generate(request)
        self.responses.append(response)
        return response


class DraftRecorder:
    """Only records planner intent. SQLx suites prove real quote/apply semantics."""

    def __init__(self, case):
        self.case, self.draft = case, None
        self.methods = []

    async def context(self, task):
        return await self.call("GET", task)

    async def quote(self, task, draft):
        return await self.call("POST", task, draft)

    async def call(self, method, task, draft=None):
        self.methods.append(method)
        if method == "GET":
            return {
                "cancelled": False,
                "task_revision": 1,
                "source_revision": 1,
                "cart": {
                    "items": [p.model_dump() for p in self.case.cart_items],
                    "currency": "USD",
                },
                "draft": self.draft
                or (
                    {"goal": self.case.previous_goal.model_dump()}
                    if self.case.previous_goal
                    else {}
                ),
            }
        if method != "POST" or len(self.methods) > 2:
            raise RuntimeErrorCode("tool_not_allowed")
        self.draft = draft
        return {"id": str(UUID(int=901)), "can_apply": not draft["goal"]["unresolved"]}


def extracted_value(data, path):
    for key in path.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


async def run_case(
    case,
    snapshot,
    live_provider=None,
    candidates=None,
    grounded_intent=False,
    commerce_core=False,
    commerce_meaning=False,
    commerce_planning=False,
):
    started = time.monotonic()
    row = CaseResult(
        id=case.id,
        store=case.store,
        language=case.language,
        journey=case.journey,
        suite=case.suite,
        status="passed",
    )

    def recorded_products():
        recorded = {}
        for product in snapshot.products:
            payload = product.model_dump(mode="json")
            memberships = set(payload.get("category_ids", [])) | set(
                snapshot.category_memberships.get(str(product.id), [])
            )
            if memberships:
                payload["category_ids"] = sorted(memberships)
            recorded[str(product.id)] = payload
        return recorded

    products = recorded_products()
    principal = Principal(tenant=snapshot.tenant_id, persona="shopper")
    agent = default_agents(snapshot.tenant_id).load(snapshot.tenant_id, "shopper")
    drafts = DraftRecorder(case)
    history = ()
    prior_pending = None
    tokens_in = tokens_out = 0
    ledger_before = live_provider.spent_micros if live_provider else None

    def transport(request):
        if (
            request.url.path != "/v1/assistant-tools/shopper"
            or request.method != "POST"
            or request.headers.get("authorization") != "Bearer frozen-eval-only"
        ):
            raise RuntimeErrorCode("tool_not_allowed")
        body = json.loads(request.content)
        name, args = body["name"], body["arguments"]
        row.tool_calls.append(name)
        if case.tool_fault == "unavailable":
            return httpx.Response(503)
        if case.tool_fault == "malformed":
            return httpx.Response(200, json={"products": "not-a-list"})
        if name == "get_catalog_schema":
            selected = []
        elif name == "get_product":
            selected = (
                [products[args["product_id"]]] if args["product_id"] in products else []
            )
        elif name == "compare_products":
            selected = [products[p] for p in args["product_ids"] if p in products]
        elif name == "search_products":
            # Replay the recorded retrieval observation, including bad candidates;
            # the actual runtime must independently filter and rank it.
            selected = [
                products[p]
                for p in (case.candidates if candidates is None else candidates)
            ]
        else:
            raise RuntimeErrorCode("tool_not_allowed")
        return httpx.Response(
            200,
            json={
                "products": selected,
                "category": None,
                "catalog_schema": snapshot.catalog_schema.model_dump(mode="json")
                if name == "get_catalog_schema"
                else None,
                **(
                    {"catalog_profile": frozen_profile(snapshot, args)}
                    if name == "search_products" and snapshot.catalog_complete
                    else {}
                ),
                **(
                    {"default_currency": snapshot.products[0].currency}
                    if name == "get_catalog_schema"
                    and snapshot.catalog_complete
                    and len({p.currency for p in snapshot.products}) == 1
                    else {}
                ),
            },
        )

    async with httpx.AsyncClient(
        base_url="http://frozen-catalog.invalid",
        transport=httpx.MockTransport(transport),
    ) as client:
        tools = {
            t.definition.name: t
            for t in registry(client, "frozen-eval-only", principal, {})
        }
        for index, turn in enumerate(case.turns):
            # Keep each turn's oracle immutable even when a test explicitly
            # advances the captured catalog between a question and its reply.
            oracle_snapshot = snapshot.model_copy(deep=True)
            products = recorded_products()
            provider = ObservedProvider(
                live_provider
                or ScriptedProvider(turn.model_output, case.provider_fault)
            )
            actor = ActorContext(
                tenant_id=str(snapshot.tenant_id),
                store_id=str(snapshot.tenant_id),
                session_id=str(UUID(int=900)),
                request_id=str(UUID(int=1000 + index)),
                channel="evaluation",
            )
            decision = CompatibilityFacade(
                build_registry(), SystemClock(), enabled=commerce_core
            ).select(
                actor,
                case.journey if case.kind == "basket" else "discovery",
                deterministic=case.kind == "policy",
            )
            execution_provider = (
                reasoning_adapter(provider, provider_capabilities())
                if decision.path == "core"
                else provider
            )
            execution_tools = (
                CommerceCatalogAdapter(tools, principal, actor).runtime_tools()
                if decision.path == "core"
                else tools
            )
            text, blocks, error, extracted = "", (), None, {}
            pending = None
            resolved_frame = None
            drafts.methods = []
            from app.commerce_action_engine.platform.telemetry import (
                TurnTrace,
                trace_turn,
            )

            meaning_trace = TurnTrace()
            with trace_turn(meaning_trace):
                try:
                    if case.kind == "policy":
                        text = (
                            snapshot.policies.match(turn.message, snapshot.observed_at)
                            or "No exact approved policy match."
                        )
                    elif case.kind == "basket":
                        text, blocks = await plan_basket(
                            turn.message,
                            case.journey,
                            UUID(int=900),
                            execution_provider,
                            execution_tools,
                            principal,
                            drafts,
                            commerce_meaning=commerce_meaning,
                            commerce_planning=commerce_planning,
                            planning_prices=(400, 1600),
                        )
                    else:
                        interpretation = None
                        if turn.language_result is not None:
                            from app.commerce_action_engine.application.context import (
                                TurnContext,
                            )
                            from app.commerce_action_engine.application.interpretation import (
                                interpret_resolution,
                            )
                            from app.commerce_action_engine.execution.language.gate import (
                                Resolution,
                            )

                            interpretation = interpret_resolution(
                                Resolution.model_validate(turn.language_result),
                                TurnContext(actor=actor),
                            ).result
                        resumed = (
                            resolve_shopping_reply(prior_pending, turn.message)
                            if prior_pending is not None
                            else None
                        )
                        if resumed is not None and resumed.error:
                            # The application/SSE suite checks re-emitting this
                            # question and revision CAS. The lab must never turn
                            # an invalid reply into an accepted stored frame.
                            raise RuntimeErrorCode("invalid_shopping_choice")
                        answer = await shopping_answer(
                            turn.message,
                            execution_provider,
                            agent,
                            principal,
                            execution_tools,
                            history=history,
                            grounded_intent=grounded_intent,
                            commerce_meaning=commerce_meaning,
                            commerce_planning=commerce_planning,
                            planning_prices=(400, 1600),
                            interpretation=interpretation,
                            **(
                                {
                                    "shopping_resume": resumed.frame,
                                    "shopping_resume_revision": prior_pending.descriptor_revision,
                                    "shopping_resume_question": prior_pending,
                                }
                                if resumed is not None and resumed.frame is not None
                                else {}
                            ),
                        )
                        if answer:
                            text, blocks = answer.text, answer.blocks
                            question = getattr(answer, "pending_shopping", None)
                            if question is not None:
                                pending = question.model_dump(mode="json")
                            prior_pending = question
                            frame = getattr(answer, "shopping_frame", None)
                            if frame is not None:
                                resolved_frame = frame.model_dump(mode="json")
                except (ModelError, RuntimeErrorCode) as exc:
                    error = exc.code
                except Exception:  # noqa: BLE001 -- contain errors without publishing secrets
                    # Never include exception messages which could contain credentials.
                    error = "unexpected_runtime_error"
            row.provider_calls += provider.calls
            for response in provider.responses:
                tokens_in += response.usage.input_tokens
                tokens_out += response.usage.output_tokens
                if response.structured:
                    extracted = response.structured.model_dump(mode="json")
            external = live_provider and error in {
                "timeout",
                "rate_limit",
                "unavailable",
                "authentication",
                "budget_exceeded",
            }
            if external:
                row.status = "failed" if row.failures else "quarantined"
                row.failures.append(Failure(assertion=error, layer="provider"))
            elif error != turn.expected.error:
                row.failures.append(
                    Failure(
                        assertion="error:" + (error or "expected_error_missing"),
                        layer="provider"
                        if isinstance(error, str)
                        and error in {"invalid_response", "timeout", "rate_limit"}
                        else "runtime",
                    )
                )
            if not error and not turn.expected.error:
                row.failures.extend(
                    catalog_assertions(
                        blocks,
                        text,
                        oracle_snapshot,
                        turn.expected,
                        pending=pending,
                        frame=resolved_frame or extracted,
                    )
                )
                for path, expected in turn.expected.extracted.items():
                    if extracted_value(extracted, path) != expected:
                        row.failures.append(
                            Failure(
                                assertion="extraction:" + path, layer="understanding"
                            )
                        )
                if turn.expected.locked_products is not None and (
                    not drafts.draft
                    or sorted(drafts.draft["goal"]["locked_products"])
                    != sorted(turn.expected.locked_products)
                ):
                    row.failures.append(
                        Failure(
                            assertion="product_lock_preservation",
                            layer="understanding",
                            safety=True,
                        )
                    )
                if turn.expected.unresolved is not None and (
                    not drafts.draft
                    or bool(drafts.draft["goal"]["unresolved"])
                    != turn.expected.unresolved
                ):
                    row.failures.append(
                        Failure(
                            assertion="unresolved_constraints",
                            layer="policy",
                            safety=True,
                        )
                    )
            if provider.calls > turn.expected.max_calls:
                row.failures.append(
                    Failure(assertion="provider_call_limit", layer="runtime")
                )
            if "UNTRUSTED MODEL PROSE" in text:
                row.failures.append(
                    Failure(
                        assertion="untrusted_provider_prose",
                        layer="policy",
                        safety=True,
                    )
                )
            row.trace.append(
                {
                    "turn": index + 1,
                    "catalog_revision": oracle_snapshot.catalog_schema.version,
                    "core": decision.model_dump(mode="json"),
                    "error": error,
                    **(
                        {"planning": meaning_trace.planning}
                        if commerce_planning
                        else {}
                    ),
                    **(
                        {
                            "meaning": dict(meaning_trace.totals),
                            "policy": meaning_trace.policy_decisions,
                        }
                        if commerce_meaning
                        else {}
                    ),
                    "answer": text,
                    **({"pending_shopping": pending} if pending is not None else {}),
                    **(
                        {"shopping_frame": resolved_frame}
                        if resolved_frame is not None
                        else {}
                    ),
                    "extracted": extracted,
                    "provider_models": [
                        response.model for response in provider.responses
                    ],
                    "draft": drafts.draft,
                    "product_ids": [
                        str(p.id) for b in blocks for p in b.products or []
                    ],
                    "planner_methods": drafts.methods[:],
                }
            )
            history += (Message("user", turn.message), Message("assistant", text))
            if error:
                break
    if row.failures and row.status != "quarantined":
        row.status = "failed"
    # A prior deterministic assertion failure can never be hidden by a later outage.
    if row.status == "quarantined" and len(row.failures) > 1:
        row.status = "failed"
    row.latency_ms = round((time.monotonic() - started) * 1000)
    if live_provider:
        row.input_tokens, row.output_tokens = tokens_in, tokens_out
        row.cost_micros = (
            live_provider.spent_micros - ledger_before if tokens_in else None
        )
    return row


async def run(
    dataset,
    live_provider=None,
    observations=None,
    *,
    scope=None,
    grounded_intent=False,
    commerce_core=False,
    commerce_meaning=False,
    commerce_planning=False,
):
    rows = []
    excluded = {}
    snapshots = {s.id: s for s in dataset.snapshots}
    if observations:
        if observations.dataset_sha256 != dataset_digest(dataset) or set(
            observations.candidates
        ) != {c.id for c in dataset.cases}:
            raise ValueError("Retrieval observations must cover this exact dataset")
        for case in dataset.cases:
            ids = observations.candidates[case.id]
            if len(ids) > 5 or not set(ids) <= {
                str(p.id) for p in snapshots[case.snapshot].products
            }:
                raise ValueError("Retrieval observations exceed the scoped snapshot")
    for case in dataset.cases:
        if live_provider and not case.live:
            continue
        if scope and case.language not in scope.languages:
            excluded[case.id] = case.language
            continue
        snapshot = snapshots[case.snapshot]
        if live_provider and snapshot.source != "isolated_store":
            raise ValueError("Live cases require a captured isolated-store snapshot")
        rows.append(
            await run_case(
                case,
                snapshot,
                live_provider,
                observations.candidates[case.id] if observations else None,
                grounded_intent,
                commerce_core,
                commerce_meaning,
                commerce_planning,
            )
        )
    status = (
        "failed"
        if any(r.status == "failed" for r in rows)
        else "incomplete"
        if not rows or any(r.status != "passed" for r in rows)
        else "passed"
    )
    return Report(
        mode="live" if live_provider else "replay",
        dataset_revision=dataset.revision,
        dataset_sha256=dataset_digest(dataset),
        runtime_sha256=runtime_digest(),
        created_at=datetime.now(UTC),
        model=live_provider.model if live_provider else "scripted-extraction",
        status=status,
        results=rows,
        segments=segments(rows),
        live_stores={
            store: "canary_selected"
            if any(c.live and c.store == store for c in dataset.cases)
            else "not_configured"
            for store in sorted({s.store for s in dataset.snapshots})
        },
        budget=live_provider.summary() if live_provider else None,
        retrieval_revision=observations.engine_revision
        if observations
        else "dataset-frozen-observations",
        retrieval_sha256=digest(observations.model_dump(mode="json"))
        if observations
        else None,
        runtime_features=(["grounded_intent"] if grounded_intent else [])
        + (["commerce_core"] if commerce_core else [])
        + (["commerce_meaning"] if commerce_meaning else [])
        + (["commerce_planning"] if commerce_planning else []),
        scope_id=scope.id if scope else "all-languages",
        scope_sha256=digest(scope.model_dump(mode="json")) if scope else None,
        scope_reason=scope.reason if scope else None,
        excluded_cases=excluded,
    )


def project_scope(report, scope):
    """Explicitly project historical evidence without rerunning or relabeling cases."""
    if report.scope_sha256 is not None:
        raise ValueError("Project the original full-scope evidence only")
    scoped = report.model_copy(deep=True)
    scoped.results = [r for r in report.results if r.language in scope.languages]
    scoped.excluded_cases = {
        r.id: r.language for r in report.results if r.language not in scope.languages
    }
    scoped.scope_id, scoped.scope_reason = scope.id, scope.reason
    scoped.scope_sha256 = digest(scope.model_dump(mode="json"))
    scoped.segments = segments(scoped.results)
    scoped.status = (
        "failed"
        if any(r.status == "failed" for r in scoped.results)
        else "incomplete"
        if not scoped.results or any(r.status != "passed" for r in scoped.results)
        else "passed"
    )
    # A live budget belongs to the original full execution, not the projected subset.
    scoped.budget = None
    return scoped
