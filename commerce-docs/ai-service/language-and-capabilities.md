# Language interpretation and capabilities

Node owns deterministic English interpretation. Normalization, correction, dictionary scoring, entities, constraints, references and context feed the standard request contract. Python independently validates intent, status, requested actions and admission before selecting a workflow. A recognized intent may clarify, deny, hand off or fail; recognition is not successful execution.

| Request | Implemented behavior | Boundary |
| --- | --- | --- |
| Search / recommendations | Catalog constraints, grounded selection and product cards | Current product evidence and supported constraints required |
| Price / stock / product facts | Identity-resolved reads and allowlisted attributes | Missing/conflicting or unverified attributes remain unknown |
| Comparison | Catalog-grounded product comparison and explicit selection | Clear-comparison changes browser-owned selection |
| Bestsellers / discounts | Dedicated sales-period and discount routes | Recommendation relevance does not prove sales rank |
| Cart / wishlist | Scoped reads and supported add/remove/clear/quantity/transfer workflows | Identity, capabilities, selection and required confirmation apply |
| Checkout / create order | Cart review, product prompts and checkout UI handoff | Chat wording does not itself place an order |
| Reorder | Owned order selection and review handoff | Direct reorder adapter is not wired into live chat |
| Orders / shipments / support | Owned reads; support creation via validated form context | Unsupported changes are guided to UI workflows |
| Addresses / delivery | Saved-address and delivery reads and UI selection guidance | No general automatic address-change execution |
| Compound cart + wishlist | Narrow, fully consumed interpretation with optional serial writes | Both flags, scopes, fresh facts, persistence and receipts required |
| Knowledge / conversation | Approved-source retrieval and bounded application replies | Evidence and model output never grant execution authority |

Price handling separates amount, currency, range and product constraints. Clarification replies preserve the original command and revalidate resumed text. Product prompts keep each item quantity and require explicit catalog selection before cart actions. Recommendations must preserve evidence requirements and match merchant attributes rather than inventing purpose or product facts.

Conversational requests such as "I need bananas under $5" remain constrained catalog searches. Independently counted multi-item lists such as "I need two bananas and three apples" enter product selection guidance. Explicit polite purchase wording such as "I would like two bananas" retains its purchase journey. Counted-list splitting is shared by order recognition and product guidance, with guards for product model numbers and measurements. A price constraint must stay attached to the search rather than being dropped by a product prompt.

Wishlist location, access and content questions such as "Where is my wishlist?", "How do I find my favorites?" and "What have I saved for later?" resolve directly to `VIEW_WISHLIST`. The whole-request grammar in `wishlist-read-language.ts` recognizes personal wishlist aliases and selects the existing deterministic wishlist handler. Python renders the authorized saved-item count and up to three product cards, or the existing sign-in, empty-list or read-failure reply, without calling a model. Quoted examples, other customers' collections, additional commands and unsupported filters are excluded from this read grammar. The 1,000 new English examples in `commerce-assistant-platform/evals/wishlist-read/cases.json` are synthetic regression coverage; they do not measure independent customer accuracy or prove deployment.

Short explicit requests such as "where my wishlist?" and "what my saved products?" use the same direct read grammar, with omitted question auxiliaries allowed. Generic requests such as "what's my saved?", "my saved?" and "what I saved?" instead return a deterministic clarification: "Which saved information would you like to see: your wishlist or your saved addresses?" The language engine resolves the selected collection through the existing scoped read handler; it does not read customer data before that choice or call a model. Explicit references to saved addresses, orders or payment details remain outside the wishlist grammar. The examples are regression coverage for reusable wording rules, rather than an exact-message lookup table.

## Database-managed contextual vocabulary

`commerce_language_engine/data/knowledge/shopping-en-v1.json` contains the English
contextual vocabulary, declarative relationship rules, and sentence-role phrases.
Revision 5 contains 38 relationship rules and 563 concepts: 101 colors, 257 CLDR country/territory names, 69 people terms,
86 activities, 32 occasions, and 18 device-name concepts. The 597 aliases provide 1,160 canonical/alternate
vocabulary forms. Source versions, scope, aliases, and the Unicode license are
recorded in the adjacent `SOURCES.md`. There are 20 utterance-rule families
with 339 complete phrase/template forms and 11 question-rule families with 31
templates for product reads, comparisons, policy and compatibility questions.

The `knowledge.packs`, `knowledge.concepts`, `knowledge.aliases`, and
`knowledge.rules` tables store immutable pack revisions. Revision 2 adds the
`knowledge.utterance_rules` table in migration 018 for sentence-role and budget
phrases; migration 019 adds the `two_options` and `one_question` preference values.
Migration 020 adds named-device compatibility concepts and the whole-request
`recommendation_followup` role with an explicit result reference.
Migration 021 adds `knowledge.question_rules` and bounded conversational lead-ins.

Revision 5 uses published rules to interpret shared prepositions and conjunctions:
“for my mother and gaming” has a recipient and a use; “for my mother's birthday”
has an occasion; “for my mother's iPhone” names a compatibility target. The owner
must match a published person concept. Relative use clauses require a preceding
person, and unknown conjuncts or conflicting meanings remain unresolved. Both
Node and Python validate literal source spans against the same release artifact.
Complete separate budget sentences such as “Budget $40” set an upper bound when
paired with an explicit search, independent of sentence order.

Question rules contain a read intent and full templates with bounded `{product}`,
`{other}`, `{quantity}`, or `{device}` slots. For example, “What would {quantity}
of {product} cost before delivery” resolves to a price read with a preserved
quantity. Python calculates the subtotal from a current exact product read;
it does not promise quantity availability or a checkout total. Compatibility
questions retain both targets and request specifications before claiming a match.
Templates cannot introduce write intents or execute arbitrary expressions.

Vocabulary, relationship markers and question templates change through an
immutable pack import, activation and artifact export; service code consumes
that reviewed artifact. This is data-driven grammar, not automatic training or
unrestricted live editing of active rules. New structural grammar may still need
code and tests. A new phrase alone cannot add a catalog capability.

The offline evaluator `scripts/evaluate-shopper-csv.ts` replays all 4,000 source
conversations (4,675 turns) and checks routes, named products, quantities, budgets,
relationships and follow-ups. Use its `--baseline` option to compare a frozen
engine with a candidate under the same rubric. The CSV is development coverage,
not an independent accuracy benchmark; parsing does not prove catalog relevance,
medical suitability, stock, policy terms or successful execution. The reports in
`output/language-engine-csv-20261009/` retain the source digests and failed cases.
Aliases share existing
`lexicon.terms` identities but do not enter the legacy unrestricted entity
extractor or contribute action-intent scores. The compiler builds first-token
indexes from the published pack; requests do not query PostgreSQL per word.

Rules attach complete phrases to an explicit product search: for example,
`for my mother` is a recipient, `for online classes` is intended use, `in color
midnight blue` is a color requirement, and `made in Egypt` is an origin
requirement. Source spans, negation, concept IDs, and rule IDs remain available in
`entities.shoppingContext`. Ambiguous names such as Jordan require adequate
context. Quoted product names, additional actions, and safety conditions retain
their established interpretation paths. Vocabulary alone cannot create a store
action. This is bounded English coverage, not an exhaustive natural-language
grammar; unrecognized relationships can require clarification.

Python validates each source span before excluding contextual wording from
catalog filter parsing. Recipient and intended-use context do not invent product
facts or demographic preferences. Explicit color, audience, and country
requirements need a matching live catalog field; delivery coverage needs the
delivery workflow. An understood use case can remain context even without a
merchant purpose tag.

Sentence-role rules separate a complete background statement or answer preference
from an explicit shopping request. For example, “I am new here. I need a laptop
for online classes and my limit is $400. Keep it short.” retains the product,
intended use, maximum budget, and request for a short answer separately. The eight
answer preferences are `short`, `explain_fit`, `tradeoffs`, `uncertainty`,
`no_assumptions`, `practical_start`, `two_options`, and `one_question`; they must
not become product keywords or catalog requirements. `two_options` limits the
number of presented options, not the purchase quantity, and never invents a
second catalog match. `one_question` requests one targeted clarification grounded
in the known product, use, and budget. Its server-issued budget question accepts
a bare amount while preserving the other requirements and consumes the question
preference after the reply. Without that pending question, budget follow-ups
require explicit budget wording. `entities.shoppingContext.sentenceRoles` retains the role,
source text, source span, and rule ID for recognized segments, while
`responsePreferences` retains the preference codes. A request for short answers does not remove evidence or
required clarifications.

The optional pack `utteranceRules` entries use stable IDs, a role, a list of
complete phrases, and a preference only for `response_preference` entries.
`recommendation_followup` entries match a complete request and use a bounded
`reference` (`FIRST`) rather than pretending a rejected result is background.
`budget_update` phrases have exactly one `{amount}` placeholder. Capitalization,
common contractions, punctuation, and edge courtesy words use bounded
normalization. Unknown text is preserved rather than dropped, and the vocabulary
does not interpret arbitrary quoted text or grant commerce actions.

Natural follow-ups such as “Actually my budget is $200 now. What would you
change?” update the maximum price of an existing search while retaining its
product and intended use. A price-only follow-up without an active search needs
context. Negated, conditional, conflicting, or additional-action requests are
not silently reduced to a budget edit. Currency changes use the shopper's
explicit currency; they do not imply currency conversion. Continuations use
`interpretationText` as the validated source for reconstructed spans and retain
the updated request in `context.next.activeSearch.text`, including recognized
answer preferences.

Revision 3 also supports preference-only follow-ups such as “Can you explain why
that fits what I asked for?” or “I am confused. Ask me just one question.” These
require a prior search, preserve its product/use/budget, and retain validated
source text. They do not establish which specific product a shopper selected.
Multiple uses such as “for reading and video calls” remain distinct intended-use
relations; coordinated wording does not require a combined vocabulary concept.
“Travel photography” is a separate use from general travel. Product suitability
for any of these uses still requires catalog evidence.


Revision 4 adds broad `drawing`, `design`, and `running a small business` uses.
They preserve what the shopper stated rather than inferring a particular design
discipline, software package, or technical specification. Music production and
university assignments already existed in the vocabulary.

Named-device wording such as “a charger for an iPhone 13” becomes a compatibility
evidence requirement. The `for` and `compatible with` rules retain the named
device. The generic iPhone family requires an exact-model clarification and must
not inherit any particular model’s specifications. Model vocabulary stores names and aliases only; connector,
power, and actual product compatibility require catalog evidence or a focused
question. A buying-guidance question such as “How do I avoid buying the wrong
one?” must not turn into a purchase action or silently erase the named model.

A complete follow-up such as “I do not like the first suggestion. What is another
option?” requests a different result while retaining the search requirements.
The action flow must bind “first” to an actual prior displayed product before
excluding it. Without that result history, it asks which product was meant;
user wording alone cannot invent an earlier recommendation or product ID.

The Python image includes only the active `data/compiled.json` artifact from the
Node language-engine directory. It validates sentence-role IDs and complete
phrases against that artifact; source-pack edits alone do not activate new
masking rules. Deploy both runtimes with matching release data.

This is a bounded composition grammar. In a new request, the product and budget
currently belong in the same shopping clause (for example, “I need a laptop and
my budget is $400”). An independent budget sentence in that initial request
still uses the existing fallback; it is not silently removed as background.

Understanding a use and budget does not establish that a matching product is in
stock. No-match replies need catalog-grounded explanation and supported next
steps; unrelated or over-budget products must not be described as matching.
Local semantic checks and generated regression examples do not change the
historical live CSV labels or prove end-to-end success on a demo.

From `commerce-assistant-platform/app/commerce_language_engine`, preview and apply a pack using
the configured local `DATABASE_URL` and current production fingerprint:

```sh
npm run import:knowledge -- --pack data/knowledge/shopping-en-v1.json --database --expected-fingerprint CURRENT_FINGERPRINT
npm run import:knowledge -- --pack data/knowledge/shopping-en-v1.json --database --apply --expected-fingerprint CURRENT_FINGERPRINT
npm run activate-release -- CANDIDATE_RELEASE_ID
npm run export:db-release -- --sync-authoring
npm run verify:commerce-artifacts
```

Imports are additive transactions. Repeating an identical revision is idempotent;
changed content needs a new revision. Activation selects an immutable release,
and an earlier release can be reactivated for rollback. The optional
`--sync-authoring` export synchronizes the generated dictionary, corpus, and
manifest as well as the runtime artifact and deployment bundle. Running services
load their compiled indexes at startup, so DB activation alone does not reload a
service. Publishing a pack locally does not deploy it to the public demos.

## UNKNOWN fallback and retrieval

An explicit UNKNOWN result can admit one bounded structured model interpretation attempt. Commerce wording is sent back through the deterministic resolver and checked against the original products, quantities and supported constraints. Unsupported, ambiguous or missing-context results and resolver failures do not trigger this path. Short referential UNKNOWN follow-ups may use bounded recent exchanges, with original-message validation still owning admission and contextual recovery restricted to reads.

Approved intent examples and answer knowledge have separate collections and purposes. Examples help interpretation; knowledge supports answers. Neither becomes a command source. Optional semantic read recovery has explicit feature, collection, embedding and budget gates; its default embedding budget is zero.

### Discovery example corpus

`commerce-assistant-platform/knowledge/intent-examples.discovery-v2.en.json` adds 24 authored,
versioned training examples across product desires, price-limited searches,
dinner/breakfast/lunch recommendations, cart viewing, and cart totals. Their
canonical wording, intent codes, and reviewed slots are checked against the
active language engine by the ingestion regression suite. These are authored
examples, not a claim of collected customer traffic. Source approval and
fingerprints are still validated by the existing operator ingestion flow.

Publish with `python -m app.knowledge_cli SOURCE.json --file
knowledge/intent-examples.discovery-v2.en.json --intent-examples --actor ACTOR_UUID`
from the AI service environment, using its provisioned separate knowledge-writer
credential, embedding configuration, tenant, and intent collection. Create a
distinct approved source identity or use a strictly higher revision for an
existing source; ingestion replaces that source's chunks. The supplied
`knowledge/intent-examples.source.example.json` is a template, not live tenant data.
Deployment alone does not publish the corpus into the index.

Run `npm run evaluate:intent-discovery -- /absolute/path/report.json` from
`commerce-assistant-platform/app/commerce_language_engine` to check all canonical examples and the
separate held-out set in `commerce-assistant-platform/evals/intent-discovery-holdout.en.json`.
This checks language routing, constraints, and exact phrase separation. It does
not measure embedding recall, live LLM proposal accuracy, or catalog recommendation
quality. Measure those with captured production-like requests after ingestion.

Meal examples may contain exactly one engine-reported `SEARCH_PRODUCTS` operation;
the example validator permits that single read for product search/recommendation
only. Write/compound operations remain inadmissible. Proposal acceptance allows
the generic `products` placeholder for bounded, purpose-only meal requests, while
rejecting changed purposes or omitted named products, budgets, and exclusions.

## Compound plans and recovery

The Node compound parser projects cart-plus-wishlist actions and a graph only when the entire input is accounted for. Python verifies the resolved contract independently. Conflict resolution happens before catalog preparation. Default planning is read-only; enabling execution admits only the supported procedure.

Execution revalidates facts, claims actions, records correlated receipts and stops on failures or uncertainty. Saved recovery queries outcomes without dispatching successors. Review plans cannot be executed. Request revisions and supersession protect dispatch state, and all commerce adapter instances share the turn's read reservations.

See [architecture](architecture.md) for trust boundaries and [the code map](code-map.md) for the owning implementation. Evaluate against pinned dictionary/corpus versions and validate live behavior separately from synthetic parser accuracy.

## Contract and release publishing

Use the [language release upgrade runbook](language-release-upgrade.md) for the versioned Node → Python contract, isolated drafts, exact-release evaluation and promotion. Imports stage inactive candidates; ordinary startup verifies its active release and never activates an archived image.
