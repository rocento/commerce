# Architecture

The request path is language interpretation → planning → execution → domain services → response. The Rust gateway authenticates the customer and supplies tenant-bound delegated capabilities. Node interprets English. Python validates that interpretation, selects bounded workflows, calls scoped commerce APIs, and renders grounded responses.

| Owner | Location under `commerce-assistant-platform/app` | Responsibility |
| --- | --- | --- |
| Application/action engine | `commerce_action_engine` | FastAPI admission, lifecycle, deterministic actions, commerce adapters and AI persistence |
| Language engine | `commerce_language_engine` | English normalization, matching, entity extraction, references, context and semantic composition |
| Resolution engine | `commerce_resolution_engine` | Provider integration, structured model proposals and model admission/budgets |
| Orchestration engine | `commerce_orchestration_engine` | Compound journey preparation, serial execution, reconciliation and recovery |
| Knowledge retrieval | `commerce_knowledge_rag` | Approved-source ingestion, scoped knowledge and distinct intent-example retrieval |
| Shared contracts | `commerce_contracts` | Neutral types, identities, errors and validation shared between engines |

The ASGI entry point is `app.main:app`; composition lives in `commerce_action_engine/application/bootstrap.py`. The orchestration engine is a Python package within this application. Node runs as a separate process. AI storage is separate from authoritative Commerce storage.

`handle_turn.py` coordinates the request. `TurnRouting` owns registry selection, compatible fallback binding and routing traces; `TurnOutput` owns sequenced stream events, accumulated response state, evidence-backed completion metadata and provider usage accounting. These request-scoped objects share the prepared dependencies and preserve the existing stream contract.

`application/handler_dispatch.py` binds interpreted feature routes to their handlers through `HandlerContext` and `HandlerBinding`. Compound review, product-choice, denied and address handling retain their precedence in the turn. Held outcomes and model/search/cart-read/delivery fallback paths are intentionally outside this registry. A binding closes its handler stream and propagates failures; it never retries another handler. Each feature still consumes its own narrow commerce ports. The action inventory in `actions/registry.py` remains descriptive and does not dynamically execute implementation strings.

Cart reads use `actions/shopping/cart_read.py` for the authoritative snapshot and `application/handlers/cart_read.py` for presentation. Cart removal returns an explicit union of input, choice, confirmation, no-change, completed and unverified outcomes. Only the completed variant carries a removal receipt. The application renders those variants without inferring success from text or nullable fields. Other action families can adopt this pattern incrementally while preserving their wire contracts.

Wishlist-to-cart transfers use `actions/customer/wishlist_transfer.py` for admission, owned-product matching and mutation sequencing. Explicit outcomes distinguish completed transfers from uncertain cart writes and confirmed cart additions whose wishlist removal remains unverified. Bulk preparation is read-only and returns a bounded selection; the handler announces it before executing the transfer. The domain never retries uncertain mutations or owns stream lifetime. The application handler renders results, preserves call accounting before fallible operations, and publishes cart summaries only for completed transfers.

Wishlist saves and cart-to-wishlist moves use `actions/customer/cart_to_wishlist.py`. Shared cart admission stays pure in `actions/shopping/cart_admission.py`. The typed workflow distinguishes save acknowledgement, uncertain destination writes, unverified or mismatched source removal, and verified moves with an exact removed quantity. The cart handler consumes those outcomes directly; the old `cart.execute` tuple remains a compatibility projection. Missing current-cart evidence suppresses the cart summary, and neither cancellation nor uncertainty authorizes a retry.

Wishlist removal and clearing use `actions/customer/wishlist_removal.py`. Named selection is restricted to owned IDs, and a single deletion reports endpoint acknowledgement. Bulk clearing caps the ordered, deduplicated selection at 100 items and verifies the final state. Typed outcomes distinguish uncertain deletion, unavailable verification, retained requested items and concurrent additions. Failures stop successor operations; denials and cancellation propagate without retries. The customer handler retains event and metadata ownership and injects single-write measurement so unavailable writes still produce failed tool spans.

Shopping runs through a short coordinator in `application/shopping.py`. The `shopping_flow/` stages prepare a plan, ground it against the merchant schema, resolve fresh product references, retrieve bounded candidates and present verified results. Typed stage records carry only the facts needed by later stages, and early answers stop the pipeline. `ShoppingCatalog` owns the shared tool-call budget, validation, timeout and planning integration for the entire shopping request. Domain constraints, evidence rules and selection stay in `actions/shopping/`.

Shopping continuations have a separate application coordinator in `application/shopping_continuation.py`. It reads scoped server state and returns a fresh-request, claimed-resume or stop outcome. Pending questions take precedence over active-search follow-ups; stale or unclaimable state cannot resume a search. Domain resolvers decide how a reply refines the frame. `HandleTurn` retains request replacement, response metadata and SSE lifetime, and runs continuation admission after compound recovery and before ordinary revision/language admission.

Compound coordination lives in `application/compound_coordinator.py`. Its scoped request and explicit recovery/preparation outcomes separate saved-plan lookup, receipt reconciliation, review preparation and question publication from the turn lifecycle. It uses narrow persistence and lazy commerce ports while the canonical compound journeys own preparation and serial write execution. Recovery cannot restart writes. `HandleTurn` applies returned evidence to metadata, saves the transcript and emits stream events, preserving metadata updates between fallible operations.

`application/persistence.py` declares explicit persistence ports for request revisions, shopping continuations, compound plans/receipts, completion context and tracking. `persistence_binding.py` binds available operations once during preparation and projects stored continuation dictionaries into typed state. `HandleTurn` consumes these ports without discovering storage methods at runtime. Read, claim and publication capabilities remain independent, including for partial adapters; unavailable recovery evidence cannot authorize another write. The core `TurnStore` covers transcript/history and model budgets, while concrete SQL storage remains in `platform/`.

## Trust boundaries

Language results and retrieved examples are untrusted input. A recognized intent selects an allowlisted workflow but grants no permission. The gateway JWT binds tenant, customer and request; delegated tokens determine which commerce reads and writes are permitted. Python only calls the fixed `http://assistant-tools:8081` facade and must never receive general Commerce database credentials.

Only an explicit `UNKNOWN` interpretation admits customer model fallback. Ambiguous requests, missing context, unsupported behavior and resolver outages do not admit it. The model proposes structured language; commerce proposals must pass Node revalidation and preservation checks. Conversation proposals select application-owned replies. Model output cannot directly authorize commerce tools.

Compound execution is limited to admitted cart-add plus independent wishlist-add requests. Writes run serially, with fresh evidence, dispatch claims and correlated receipts before successors. Failure or uncertain outcome stops successors. Recovery reads saved receipts and does not restart writes. This sequence has no all-or-nothing transaction or automatic compensation. Stored review plans are non-executable.

SSE completion means the stream ended. Evidence-backed completion and mutation receipts determine whether commerce work succeeded.

Catalog discovery evaluates at most forty candidates after variant expansion and checks their live stock in batches of twenty under the same delivery scope. It returns at most eight products. Product-list length, per-product discovery rank, returned-count metadata and stored ranking observations share that bound. Regression checks include expanded variant families and six- and eight-result responses through the catalog adapter and recommendation workflow; invalid ninth ranks and inconsistent product evidence remain rejected.

## Change rules

Start with [the code map](code-map.md) and inspect the owning domain and its public interface. Keep provider integration separate from deterministic commerce logic. Put logic in its domain, avoid generic root modules and dumping-ground utility files, and prefer package public APIs over deep imports. Preserve wire contracts unless the requested change explicitly includes them. Update these guides when ownership or behavior changes and run focused checks plus architecture enforcement.

These rules replace the removed source-folder contributor guide. [The architecture checker](../../commerce-ops/scripts/check-ai-architecture.py) enforces import boundaries independently of documentation.
