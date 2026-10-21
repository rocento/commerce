# Code map

Paths below are relative to `commerce-assistant-platform/app`. Root wrapper modules preserve stable entry points; inspect canonical engine packages for implementation.

| Change | Owning source |
| --- | --- |
| Startup and dependency composition | `commerce_action_engine/application/bootstrap.py` |
| HTTP admission / streaming / history | `commerce_action_engine/application/api/{chat,events,history,system}.py` |
| Turn coordination and prepared dependencies | `commerce_action_engine/application/{handle_turn,turn_dependencies}.py` |
| Language admission, contextual replay, semantic recovery and UNKNOWN fallback | `commerce_action_engine/application/language_admission.py` |
| Typed turn persistence ports and storage compatibility binding | `commerce_action_engine/application/{persistence,persistence_binding}.py` |
| Registry selection and routing traces | `commerce_action_engine/application/turn_routing.py` |
| Interpreted feature route bindings and handler context | `commerce_action_engine/application/handler_dispatch.py` |
| Transcript saving, memory flush and final cleanup/telemetry | `commerce_action_engine/application/turn_finalization.py` |
| Stream events, completion state and provider usage | `commerce_action_engine/application/turn_output.py` |
| Runtime response translation and shopping-state publication | `commerce_action_engine/application/shopping_runtime_responses.py` |
| Interpretation and UNKNOWN proposals | `commerce_action_engine/application/interpretation.py`, `commerce_action_engine/execution/language/`, `commerce_resolution_engine/language.py` |
| Shopping entry point and ordered stages | `commerce_action_engine/application/shopping.py`, `commerce_action_engine/application/shopping_flow/` |
| Pending shopping questions, active follow-ups and revision claims | `commerce_action_engine/application/shopping_continuation.py` |
| Compound recovery, review preparation and clarification publication | `commerce_action_engine/application/compound_coordinator.py` |
| Shopping clarification wire projection and read-only interpretation | `commerce_action_engine/application/handlers/shopping_clarification.py` |
| Shopping selection, constraints and evidence | `commerce_action_engine/actions/shopping/` |
| Catalog contracts and reads | `commerce_action_engine/actions/catalog/`, `commerce_action_engine/adapters/catalog.py` |
| Cart / wishlist / orders / delivery / support | `commerce_action_engine/application/handlers/`, `commerce_action_engine/actions/`, corresponding `commerce_action_engine/adapters/` |
| Cart read result and presentation | `commerce_action_engine/actions/shopping/cart_read.py`, `commerce_action_engine/application/handlers/cart_read.py` |
| Typed removal outcomes and confirmation/receipt policy | `commerce_action_engine/actions/shopping/cart_removal.py`, `commerce_action_engine/application/handlers/cart.py` |
| Wishlist-to-cart admission, selection and typed mutation outcomes | `commerce_action_engine/actions/customer/wishlist_transfer.py` |
| Wishlist transfer ports/receipts and response rendering | `commerce_action_engine/actions/customer/transfers.py`, `commerce_action_engine/application/handlers/wishlist_transfer.py` |
| Wishlist saves and cart-to-wishlist move outcomes | `commerce_action_engine/actions/customer/cart_to_wishlist.py` |
| Wishlist removal selection, bounded clearing and typed outcomes | `commerce_action_engine/actions/customer/wishlist_removal.py` |
| Shared cart/wishlist admission and cart-name normalization | `commerce_action_engine/actions/shopping/cart_admission.py` |
| Shared turn commerce read budget | `commerce_action_engine/adapters/read_budget.py` |
| Meaning, policy and registry | `commerce_action_engine/execution/core/` |
| Planning and compound admission | `commerce_action_engine/execution/planning/` |
| Compound execution and receipt recovery | `commerce_orchestration_engine/journeys/compound/` |
| Persistence, dispatch claims and request revisions | `commerce_action_engine/platform/{store,compound_plans,request_revisions}.py` |
| Identity and configuration | `commerce_action_engine/platform/{security,settings}.py` |
| Completion evidence and telemetry | `commerce_action_engine/platform/{completion,telemetry}.py` |
| Provider transport and budget admission | `commerce_resolution_engine/providers/`, `commerce_resolution_engine/admission.py` |
| Knowledge and intent-example ingestion | `commerce_knowledge_rag/`, `commerce_action_engine/adapters/intent_examples.py` |
| Shared engine contracts | `commerce_contracts/` |
| Node HTTP and dictionary loading | `commerce_language_engine/src/{server,runtime}.ts` |
| Node interpretation and composition | `commerce_language_engine/src/{engine,request-parser,semantic-request,semantic-graph}.ts` |
| Node prices, quantities and references | `commerce_language_engine/src/{price-language,quantities,reference-resolution}.ts` |
| Node counted order lists and product prompts | `commerce_language_engine/src/{order-product-language,product-guidance}.ts` |
| Node compound language | `commerce_language_engine/src/compound-language.ts` |
| Node vocabulary and dictionary compilation | `commerce_language_engine/src/{compiler,vocabulary-store}.ts`, `commerce_language_engine/src/generation/` |

Python tests live in [tests](../../commerce-assistant-platform/tests); Node tests in [language tests](../../commerce-assistant-platform/app/commerce_language_engine/tests). AI persistence migrations live in [migrations](../../commerce-assistant-platform/migrations). Shared meaning and planning schema assets live in [meaning contracts](../../commerce-assistant-platform/contracts/commerce-meaning) and [planning contracts](../../commerce-assistant-platform/contracts/commerce-planning).

For interpretation changes start with `test_intent_dispatch.py`, `test_reasoning_admission.py` and `test_live_interpretation.py`. Compound changes use `test_compound_coordinator.py`, `test_compound_admission.py`, `test_compound_execution.py`, `test_compound_plan_chat.py` and the PostgreSQL suite `test_compound_execution_postgres.py`. Node grammar changes need the corresponding language tests as well as typechecking. See [commands and prerequisites](local-development.md).

## Changing turn finalization

`application/turn_finalization.py` coordinates persistence and final cleanup using the existing `TurnOutput` and prepared persistence ports. Normal completion records usage, response source, planning and completion metadata before saving the transcript, then flushes personalization memory. `HandleTurn` emits `done` only after that sequence succeeds. Compound recovery retains its separate save-before-answer path without a memory flush.

`HandleTurn` keeps exception mapping, cancellation propagation, stream ownership, admission closure and memory-context reset. It then awaits finalization: refresh usage and completion, close the lease, summarize/emit the trace, exit its context, finish diagnostics, save tracking and record the route metric. Preserve the nested `finally` blocks: lease or trace-emission failures still finish diagnostic context cleanup, but propagate before tracking/metric persistence. Tracking writes retain their shield and two-second timeout; route metrics retain their unshielded two-second timeout. Ordinary telemetry write failures remain best effort.

Use `test_turn_finalization.py` for persistence/flush ordering and cleanup failures, together with `test_turn_metadata.py`, `test_turn_persistence.py`, `test_turn_boundary.py`, runtime stream, compound recovery and tracking suites for HTTP/SSE behavior. The architecture checker prevents direct transcript/telemetry persistence returning to `HandleTurn` and event emission entering finalization.

## Changing turn metadata and completion

`TurnOutput` owns one mutable metadata dictionary for the entire turn. `HandleTurn`, `TurnRouting`, language admission, feature handlers and `ShoppingRuntimeResponses` share that record. Their metadata properties expose the same dictionary without allowing replacement; use in-place updates, never copies or rebinding, when contributing runtime usage, routing, failure or completion facts.

Completion calculation runs against that shared state before transcript saving and again during final cleanup. Transcript serialization, final diagnostic evidence and trace recording therefore see the completion facts available at their respective lifecycle boundaries. A later disconnect or persistence failure can legitimately change the final outcome after an earlier write; this does not retroactively rewrite stored transcripts. Public messages, event sequencing and finalization order remain unchanged.

This fixes the earlier runtime-completion copy, which detached saved model/tool metadata from `TurnOutput` and could omit the computed completion record from the transcript. Use `test_turn_metadata.py` to verify transcript snapshots, diagnostics and traces across success, clarification, unverified outcomes, errors, denial and disconnects. The architecture checker rejects metadata replacement in the turn and its coordinators.

## Changing language admission and fallback

`application/language_admission.py` coordinates claimed shopping replies, compound/ordinary clarifications, selected-product and order context, search/recommendation follow-ups, optional semantic read recovery and the single UNKNOWN-only language proposal. It uses explicit ports for model-budget admission, example retrieval and provider selection. `TurnRouting.language_provider` retains general-route binding and extraction/default provider precedence. Concrete transports and provider construction remain outside the coordinator.

`LanguageAdmissionState` retains the interpreted request, rewritten message, follow-up identity and partial diagnostic progress across awaited failures or cancellation. `HandleTurn` copies that progress even when admission raises, then retains ownership of action dispatch, SSE events, completion metadata, delegation to turn finalization. A `LanguageBudgetBlocked` result makes the turn emit its existing unavailable/done response before any action dispatch.

Only an explicit UNKNOWN can install a proposal permit. Semantic recovery runs before the generation-budget check and shares its bounded example retrieval with fallback. A model proposal receives one attempt; its permit is revoked before language-engine revalidation, including invalid-response and cancellation paths. The turn calls `LanguageAdmissionState.close()` in final cleanup to restore the caller's context. Keep this lifetime and the existing metadata-update order when extending admission.

Use `test_language_admission.py` for permit, budget, cancellation and partial-progress behavior; retain `test_language_fallback.py`, `test_live_interpretation.py`, `test_interpreted_followups.py`, `test_semantic_recovery_chat.py`, `test_intent_rag_chat.py` and turn/continuation suites for HTTP and SSE compatibility. The architecture checker prevents the coordinator from taking over transport, commerce writes or turn persistence and keeps language admission out of `HandleTurn`.

## Adding a feature handler

1. Put domain decisions and typed results in the owning `actions/` package, with a narrow protocol for the reads or writes it requires. Keep transport and stream presentation outside that package.
2. Add the application handler that renders those results using the turn's `EventFactory`. Prefer explicit outcome variants when success, clarification and uncertain writes require different evidence.
3. For a standard interpreted route, add a `HandlerRoute` and binding in `application/handler_dispatch.py`. Its adapter receives `HandlerContext` and passes only the fields and ports that the feature uses. Keep language recognition and route policy in their existing owners; registering a handler grants no authority.
4. Preserve admission ordering and resource lifetime. Handlers do not emit `done`, persist the whole turn, select a model fallback or repeat an uncertain mutation. The turn owns those cross-feature concerns.
5. Cover applicable success, missing-input, ambiguous-choice, denied, empty, stale-state, cancellation and uncertain-write cases. Use `test_handler_dispatch.py` for registry/stream lifecycle behavior and the cart read/removal suites as examples of feature tests. Existing integration tests observe owning handler modules rather than incidental imports in `handle_turn.py`.

## Changing wishlist-to-cart transfers

`actions/customer/wishlist_transfer.py` owns admission, owned-product matching and mutation sequencing. It uses the existing transfer ports in `actions/customer/transfers.py`; the handler renders its typed outcomes and owns stream events and metadata.

Named transfers distinguish missing input, failed reads, missing/ambiguous matches, unverified cart changes, confirmed cart addition with unverified wishlist removal, and completed transfers. `TransferRemovalUnverified` carries the confirmed cart without claiming a completed transfer. `TransferCompleted` requires cart evidence containing the selected product and an acknowledged wishlist removal. Removal denial still propagates `ToolDenied.completed_action = "cart_add"`; cancellation and uncertain writes never trigger a retry or successor mutation.

Bulk and random transfers use separate `prepare_selection` and `execute_selection` calls. Preparation deduplicates customer-owned IDs and caps the selected set at 200. The handler announces that selection before execution, so closing the stream at the announcement cannot dispatch a write. Execution returns a typed receipt or an unverified outcome; presentation keeps five-item blocks. Random choice is injected by the handler for reproducible testing.

The named journey reports completed-call counts through an observer before each subsequent await. Preserve that timing, the lazy commerce factory and the original quantity-validation order when extending the flow. Use `test_wishlist_transfer_domain.py` for outcome, cancellation and stream-close cases, and `test_wishlist_transfer.py` plus `test_interpreted_wishlist_transfer.py` for the existing response and HTTP contracts.

## Changing wishlist removal and clearing

`actions/customer/wishlist_removal.py` owns matching against customer-owned wishlist IDs and mutation sequencing through narrow ports. Named removal uses exact name/SKU matching and returns acknowledged or unverified removal; ambiguous matches remain choices and never authorize a write. Single-item removal preserves the endpoint acknowledgement contract without adding a verification read.

Bulk clearing deduplicates IDs in order and accepts at most 100 unique items. It deletes serially, then reads the wishlist to distinguish requested items still present from successful removal with concurrent additions. An uncertain deletion reports the acknowledged prefix and uncertain ID; a failed final read reports acknowledged removals without inventing a remaining state. Denial and cancellation propagate. No outcome causes an automatic retry, and a failed deletion stops all successor work.

The customer handler owns events, read measurement and metadata timing. It injects a measurement scope for a single deletion so the failed tool call is recorded before the domain converts unavailability into an outcome. Bulk metadata retains the original update timing. Use `test_wishlist_removal.py` for outcomes, cancellation, telemetry and public SSE/HTTP contracts; retain product-reference and customer read/access coverage alongside it.

## Changing saves and cart-to-wishlist moves

`actions/customer/cart_to_wishlist.py` owns the typed `execute` entry point for `ADD_TO_WISHLIST` and `CART_MOVE_TO_WISHLIST`. It checks the shared pure policy in `actions/shopping/cart_admission.py` before reading the cart. The policy retains raw-confidence, complete-request, entity and destination checks, including descriptive attributes that are part of the full product name. It does not discover products, call tools or grant capabilities.

Outcomes distinguish missing input, no catalog match, bounded product choices, an unverified wishlist write, saved-to-wishlist with unverified cart removal, a mismatched remaining quantity, a completed save and a completed move. `WishlistMoved` carries the product ID, removed quantity and authoritative updated cart. `WishlistRemovalMismatch` carries expected and actual remaining quantities. `WishlistRemovalUnverified` deliberately carries no cart, so the pre-write snapshot cannot be presented as current. Saving without moving uses `WishlistSaved` and never removes from the cart.

Moves require one matching owned cart item. Only an acknowledged wishlist addition can precede cart removal; a completed move also requires the exact expected quantity in the returned cart. Preserve `ToolDenied.completed_action = "wishlist_add"` after destination success, propagation of cancellation and no automatic retry after uncertainty. A selected catalog product cannot replace a missing owned source item.

The cart handler consumes typed outcomes and retains existing messages, product prompts, cart visibility and SSE sequencing. `actions/shopping/cart.execute` still projects wishlist outcomes to its legacy tuple for existing callers; new wishlist code should use the typed entry point. Shared admission also remains in the existing add/update/clear/checkout paths. Cover those paths when changing it. Use `test_cart_to_wishlist.py`, `test_cart_actions.py`, `test_interpreted_cart_actions.py` and `test_cart_handler.py` for validation.

## Changing cart mutations and checkout handoff

`actions/shopping/cart.execute_cart` owns add, quantity update, clear and checkout handoff through `CartMutationActions`. It returns explicit needs-input, needs-choice, no-change, updated, update-unverified or checkout-ready outcomes. Empty carts and unsuccessful product matching are no-change outcomes; only choices carry product candidates. `CartUpdated` carries the authoritative response acknowledged by the existing mutation port, without adding receipt verification or extra reads. `CartUpdateUnverified` deliberately carries no cart, so a pre-write snapshot cannot be presented as current.

The cart handler consumes these outcomes and retains existing messages, product prompts, blocks and SSE ordering. A checkout-ready outcome means the admitted request has a nonempty owned cart, not that an order was placed. Only bare checkout requests emit `open_checkout`; product-bearing requests keep the ordinary checkout-link response. Admission and identity/quantity validation order, cancellation and denial propagation, and the prohibition on retrying uncertain writes remain unchanged.

`cart.execute` remains a compatibility entry point returning `(text, cart, choices)`, including existing removal and wishlist delegation. New add/update/clear/checkout callers should use `execute_cart`; removal and wishlist callers use their own typed journeys. Validate changes with `test_cart_outcomes.py`, `test_cart_actions.py`, `test_interpreted_cart_actions.py`, `test_cart_handler.py`, the removal/wishlist suites and `test_handler_dispatch.py`.

## Changing shopping behavior

`application/shopping.py` preserves the public entry point and coordinates the stages below. Each stage returns explicit facts or a final `ShoppingAnswer`; a clarification stops the flow before later reads. The stage records are frozen, while their domain models remain mutable. Stages that refine an incoming plan copy it before making changes.

| Change | Stage owner under `application/shopping_flow/` |
| --- | --- |
| Tool validation, request budget, timeout and schema discovery | `catalog.py` |
| Resume/revision handling, interpretation/model plan and monetary evidence | `preparation.py` |
| Product identity, merchant schema, required constraints and currency | `grounding.py` |
| Fresh details/comparison reads and cheaper-reference limits | `references.py` |
| Bounded searches, fallback reads and candidate evidence checks | `retrieval.py` |
| Answer metadata, ranking, cards and response text | `presentation.py` |
| Stage records and the public answer type | `contracts.py` |

Keep reusable business rules in `actions/shopping/`; stages coordinate those rules and their ports. Keep concrete HTTP, database and provider clients outside the stages. Every catalog call goes through the same request-scoped `ShoppingCatalog`, including optional identity and fallback reads, so adding a stage does not reset the tool budget. Preserve the public `shopping_answer` signature and its domain compatibility exports.

## Changing shopping runtime responses

`application/shopping_runtime_responses.py` translates one `RuntimeEvent` at a time into progress, text or validated block fields for the turn's event factory. `ShoppingRuntimeResponses` tracks cumulative text length, tool calls and answer metadata; `ShoppingResponseScope` carries the server-established tenant, owner, store, session, conversation, request revision and message. Guest ownership remains the established session identity. Publication uses only the existing `ActiveShoppingWriter` and `ShoppingQuestionPublisher` interfaces.

Preserve publication before text delivery. A pending shopping question takes precedence over active-search saving and legacy clarification fields. Only successful question publication attaches a resumable shopping clarification; missing scope, absent publication support or a rejected publication still returns the existing text without resumable fields. Active-search save rejection retains the existing text response. Publication exceptions and cancellation propagate without retry, and text exceeding the cumulative 8,000-character limit fails before either publication operation.

The coordinator updates the shared turn metadata before validating response blocks, including partial progress when validation fails. `HandleTurn` owns runtime iteration, event sequencing, stream closure, error mapping, delegation to turn finalization and the final `done` event. The coordinator never advances the runtime or emits a final event. Validate with `test_shopping_runtime_responses.py`, `test_shopping_runtime_stream.py`, `test_shopping_clarification_sse.py` and the runtime, continuation, persistence and turn-boundary suites.

## Changing shopping continuations

`application/shopping_continuation.py` resolves pending questions and active-search replies through `ShoppingPersistence`. Its scoped inputs retain tenant, owner, store and session identity; conversation and explicit revision/question values come from the validated request. A guest's owner remains the server-established session identity.

The coordinator returns one of three outcomes:

- `ShoppingFresh`: continue ordinary admission, clearing an old shopping clarification when a fresh request supersedes it.
- `ShoppingResume`: continue from a server-owned frame after a successful revision claim, carrying the original message, descriptor revision and typed question.
- `ShoppingStop`: stop with a stale-state, conflicting-reply or clarification response. A newly issued prompt is resumable only when publication succeeded.

The coordinator does not emit stream events, invoke providers or retry claims. `HandleTurn` applies outcomes to the request and response metadata, renders questions and owns stream completion. Saved compound recovery still runs first; ordinary request revisions and language admission run afterward. Preserve this ordering when adding a continuation case.

## Changing compound coordination

`application/compound_coordinator.py` coordinates saved-plan recovery, review preparation and clarification publication using `CompoundPersistence`, `QuestionPublisher` and a lazy commerce port. `CompoundRequest` carries the validated request identity, conversation, revision, message and original input fingerprint. Recovery runs before shopping continuation admission and always uses that original fingerprint, including when a later clarification rewrites the working message.

Recovery returns `NoCompoundRecovery` or `RecoveredCompound`. Preparation returns `CompoundReviewOnly`, `PreparedCompound` or `CompoundPreparationFailed`; the latter carries the existing unavailable, unsupported or superseded response. A plan view carries response text, action states, receipt evidence and any product choice. A clarification is resumable only when publication returns `CompoundClarification`.

The coordinator retains the existing planning flag, revision, catalog, storage and delegated-token gates. Preparation and receipt reconciliation go through `application/handlers/compound.py` into the canonical compound journeys; action claims and write dispatch remain inside those journeys. Recovering an existing plan can reconcile authoritative receipts but cannot dispatch another write. `HandleTurn` applies metadata between preparation and clarification publication, delegates transcript saving to turn finalization and streams the result. Preserve this ordering so failures and cancellation report the same evidence as the completed work.

## Adding persistence support

Declare the capability in `application/persistence.py`, implement it in the storage adapter and bind it during turn preparation. `persistence_binding.py` supports existing adapters that expose only some operations and converts dictionary continuation records to typed state. `PreparedTurn` accepts an explicit `TurnPersistence`; direct construction also binds a supplied legacy store once.

Reads, claims, publications and compound receipt transitions are independently available. A successful read does not imply permission or support to claim a revision or write state. The turn must check the specific optional port it needs, preserve tenant/customer/conversation/store/session scope, and stop if the required claim or recovery evidence is unavailable. Do not add method discovery inside `HandleTurn`.

The migrations cover standard dispatch, cart reads/removal/mutations and checkout handoff, wishlist saves, removal/clearing and transfers in both directions, shopping stages, shopping continuations, compound coordination and turn persistence ports. Other action result contracts can adopt explicit outcome variants in separate feature-sized refactors.
