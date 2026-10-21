# English shopping language knowledge sources

## Phase 2 expansion, revision 9

`shopping-en-phase2-v3.json` adds a restricted Princeton WordNet 3.1 noun subset and first-party shopper wording from `phase2-expansion-curated.json`. It contains 3,516 concepts and 5,580 canonical/alternate forms. The 88 governed rules are unchanged. This is an inactive candidate with AI-assisted extraction-policy/sample review, not independent human review of every entry or completion of the vocabulary scale target.

The source archive is [Princeton's WordNet 3.1 database](https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz), SHA-256 `3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`; the noun file hash is `2cad22fe43461ee7ae61a564ae6a518c57445c8597e53542caddb5c26a6a5d94`. See [the preserved WordNet notice](WORDNET-LICENSE.txt). The notice is also in the pack source field so exported database packs and upload bundles retain it. Attribution: Princeton University, WordNet 3.1, a lexical database for English (2011).

Only explicitly selected shopping noun branches are admitted. Multiple noun senses for one normalized spelling, existing concept collisions and out-of-scope branches are excluded. Diet labels are not product records. No source-derived product term establishes catalog availability, technical specifications, safety, ingredients or compatibility. A complete lexical noun can improve diagnostic product meaning without changing catalog entity authority. Arabic-script forms are excluded.

The deterministic builder is `scripts/prepare-vocabulary-expansion.ts` within the language engine. Source snapshots, checksums, exclusions, inactive staging and tests are in `output/enterprise-knowledge-expansion-20261010/` at the repository root. The [implementation report](../../../../../commerce-docs/ai-service/enterprise-knowledge-vocabulary-expansion.md) records exact coverage, resumable import commands, limitations and release gates.

`shopping-en-v1.json` is a versioned seed for the language knowledge database. Revision 5 contains **563 concepts and 597 alternate phrase spellings** (1,160 canonical/alternate forms): 101 colors, 257 countries/territories, 69 people/recipient terms, 86 activities, 32 occasions, and 18 device-name concepts. Its **38 relationship rules** and **20 utterance-rule families with 339 phrase/template forms** cover bounded English interpretation. Accented country names and English-used names of occasions are retained; this is not an Arabic lexicon.

## Country and territory data

English names, alternate names, and code mappings are derived from the Unicode Consortium's **CLDR release 48**, retrieved 2026-10-09:

- [English locale names](https://github.com/unicode-org/cldr/blob/release-48/common/main/en.xml), SHA-256 `416fb34c500e969a9e3e9bd1e363f8af5938df3cdda72aa7e636fa7e72123aae`.
- [Region validity](https://github.com/unicode-org/cldr/blob/release-48/common/validity/region.xml), SHA-256 `e751e0eedd46b52c38f3cdb72b0fab61ac8b48e052e8b28ba74b6ac26c4c8cb1`.
- [Supplemental country-code mappings](https://github.com/unicode-org/cldr/blob/release-48/common/supplemental/supplementalData.xml), SHA-256 `fb054c9f9a95f0c4da9dd1e5e0ef6dd208b6f9a73f45303011be247277d81bef`.
- [Unicode License V3](https://github.com/unicode-org/cldr/blob/release-48/LICENSE), SHA-256 `b4c0ae8ef04f7059f96ce5bbe0467f9fe6f6d81bbe13517701dfeb961fb4d0b6`.

The extraction expands every two-letter code range in `id[type=region][idStatus=regular]` and takes its default English territory name. All **257 CLDR regular regions** are represented exactly once. This includes countries, dependent territories, and CLDR regional entries such as Ascension Island (AC), Clipperton Island (CP), Sark (CQ), Diego Garcia (DG), Ceuta & Melilla (EA), Canary Islands (IC), Tristan da Cunha (TA), and Kosovo (XK). The pack does not equate this list with a list of sovereign states or make an assertion about political status. Macroregions, pseudo-locales, unknown-region values, and deprecated codes are excluded.

CLDR alternate display names, selected familiar English/formal names, and unaccented keyboard spellings are included as aliases. These aliases represent possible shopper wording, not changes to the source's canonical display names. Short codes such as `US`, `IN`, `NO`, `GB`, `UK`, and `UAE` are stored only in `metadata.codeAliases`. They are **not ordinary lexical aliases**, because lowercasing them can collide with words such as “us,” “in,” and “no.” A future code matcher must require an explicit country-code or geographic field. `metadata.code` is the CLDR region code; `metadata.standard` records `cldr_regular_region`.

Country phrases require geographic context such as delivery destination or origin. “Turkey sandwich,” “Jordan shoes,” and “Georgia's gift” must not silently become country restrictions.

## Curated shopping vocabulary

Colors, people, activities, and occasions were written for this repository, not copied from a third-party dictionary. Their aliases cover common English plurals, regional spellings, and shopping phrases. They are a practical starting vocabulary, not an exhaustive English dictionary.

- Colors include multiword names and American/British variants. No RGB equivalence is promised. Gold, silver, ivory, emerald, and pearl color descriptions do not imply those materials; food/color overlaps need contextual interpretation.
- People include age words, explicit gender words, family relationships, social relationships, groups, and shopper-relevant roles. They describe words supplied by the shopper. They do not establish exact age, infer identity, prescribe gendered preferences, or establish product or medical suitability. `personRole` distinguishes audience wording from recipient wording; syntax can still make an audience term refer to an individual recipient.
- Activities describe uses such as online classes, video editing, travel, and cooking. They are not catalog attributes. Suitability requires product evidence, and broad phrases such as “for work” may require clarification.
- Occasions include personal milestones and several familiar calendar/religious occasions. Mentioning an occasion must not infer a person's religion, demographics, or preferences.

`requiresContext` and `ambiguous` are interpretation flags, not authorization for a store action. Concepts preserve a distinction between understanding a shopper's meaning and proving a product fact. Rules belong to the same versioned pack and are maintained separately from this source data.

## Curated English sentence roles and budget edits

Revision 2 introduced `utteranceRules`, authored for this repository. Revision 3 expanded those reusable phrase families for browsing fatigue, confusion, two-option answers, one-question guidance, and contextual explanation follow-ups. Revision 4 adds whole-request first-result alternative forms and buying-guidance questions. They are not a lookup table of the evaluation questions. The active pack preserves the distinction between the shopping goal and the way the shopper wants the answer delivered:

| Role | Families | Phrase/template forms | Meaning |
| --- | ---: | ---: | --- |
| `background` | 5 | 65 | First visit, time pressure, uncertainty/confusion, browsing fatigue, and considering a purchase |
| `search_prompt` | 2 | 36 | General options/starting-point requests and buying-guidance questions |
| `response_preference` | 8 | 153 | Short answers, reasons for fit, tradeoffs, uncertainty, no assumptions, a practical starting point, two options, and one question |
| `budget_update` | 3 | 70 | Stated limits, replacement limits, and maximum spending amounts |
| `recommendation_followup` | 1 | 8 | Complete requests for another option instead of the first suggestion |
| `lead_in` | 1 | 4 | Reviewed inline introductions with an explicit comma or colon boundary |
| Total | 20 | 336 | English utterance forms; not additional product concepts |

Revision 3 adds 65 phrase/template forms over revision 2. `two_options` limits the presentation to at most two supported options; it is not an order quantity and does not require inventing a second result. `one_question` requests one targeted clarification using the known search rather than an ungrounded recommendation. Recognized standalone explanation or guidance follow-ups require the existing search context; they must not fabricate the previous selection.

Revision 3 contained 541 concepts and 501 aliases (1,042 canonical/alternate forms), including 82 activities. It added the distinct use `travel photography` with eight natural aliases and three aliases for the existing `remote work` concept. `working from home` was already a remote-work alias. These are stated uses, not evidence that a laptop or camera is suited to them. Coordinated uses such as `reading and video calls` remain two concepts; the parser composes them rather than requiring a new dictionary entry for every combination.


Revision 4 adds the broad activities `drawing`, `design`, and `running a small business`, with 12 aliases. Generic drawing does not imply digital drawing; generic design does not imply graphic design or a particular software package. Music production and university assignments were already present. These uses can inform clarification, but do not establish required specifications.

Revision 4 introduced three exact model names—iPhone 13, iPhone 15, and Samsung Galaxy S24—with nine common naming/typing aliases, plus the family name iPhone with alias Apple iPhone. The family concept has `requiresExactModel: true` and triggers an exact-model question; it cannot establish a model or shared connector. No connectors, wattages, charging protocols, or compatibility claims are stored in these concepts. The `for.device` and `compatible.with.device` rules label a `compatibility_target`; it is projected to the established `named_device_compatibility` evidence requirement, not an activity or an ordinary purpose filter. A shortened name, unsupported suffix, different model, or unverified catalog claim must remain explicit or be clarified. No relationship should infer compatibility from brand alone.

The `followup.reject_first` family has role `recommendation_followup` and reference `FIRST`. It matches the entire bounded request rather than masking a dislike sentence as background. The wording describes a requested alternative; identifying the rejected product requires actual scoped result history. If that history is absent, the system must ask which product the shopper meant rather than inventing an earlier recommendation. The eight `prompt.purchase_guidance` phrases are shopping questions, not guarantees or permission to purchase.

A phrase matches a complete sentence or recognized segment, with only bounded normalization of capitalization, punctuation, courtesy words, and common contractions. It is not an unrestricted substring deletion rule. Budget templates contain exactly one `{amount}` placeholder; currency and numeric parsing stay with the established money grammar. A budget edit needs an active product search or an explicit current shopping goal. Its numeric limit does not establish a product, a quantity, a delivery date, or an authorization to act.

Answer preferences describe presentation and evidence handling. For example, “explain the tradeoffs” is not part of the product name, and “do not assume my preferences” does not negate the shopping request. Removing a recognized presentation segment from catalog matching must preserve it as response metadata and retain source evidence. Unknown sentences, quoted product titles, medical/safety conditions, compatibility requirements, negated requests, and additional commerce actions must not disappear through this mechanism.

The phrase families do not establish customer demographics or product suitability. “I am new here” supplies background only; it does not prove account history. “I am short on time” does not promise expedited delivery. Phrase coverage remains bounded and can be extended through a new immutable pack revision.

`output/language-rules-20261009/authored-semantic-scenarios.json` retains the revision-2 scenarios. `output/language-cases-20-20261009/authored-semantic-scenarios.json` adds 48 independently composed revision-3 scenarios: 24 product searches, 12 contextual follow-ups, and 12 boundary cases. They are authored examples with semantic expectations, not live observations or claims of accuracy. The historical 4,000-case live CSV is not relabeled by these checks. Revision-4 scenarios are in `output/language-cases-next20-20261009/authored-semantic-scenarios.json`: 40 cases covering 16 searches, 6 continuations, 4 first-result alternatives, 6 compatibility requests, and 8 boundaries. Compatibility and alternatives require evidence-aware fixture checks beyond language extraction.

## Revision 5 corpus review and grammar vocabulary

The pack also contains 11 read-question families with 31 literal templates. These extract product names, comparison targets, quantities and known device names; they do not contain merchant facts. New `lead_in` phrases match only an explicit comma/colon boundary. Question slots cannot authorize writes or discard additional action clauses. Budget-only sentences use the published budget templates and are paired only with a complete shopping request.

The source of the review is `output/live-shopper-eval-20261008/live-shopping-assistant-4000-english.csv` and its scenario generator, `output/live-shopper-eval-20261008/corpus.py`. The CSV contains 4,000 observations across 120 demo/family combinations: 3,188 need-based scenarios from 80 templates and 812 questions about catalog products from 40 tasks. These are historical observations, not newly measured results. Reading the generator separately avoids mistaking its presentation wrappers for product requirements or treating thousands of paraphrases as thousands of independent behaviors.

All ten behavioral profiles and four follow-up templates were already represented by revision 4. Revision 5 adds the whole-sentence background `I am comparing options` used by catalog questions and four related forms. It adds eight generic shopping-option prompts, fourteen answer-presentation forms, and sixteen explicit budget templates. A question such as `What is safe?`, an allergy, a return condition, a delivery deadline, a comparison target, or an additional action is deliberately not a removable background phrase. These clauses need their own meaning and evidence handling. Four `lead_in` phrases (`hi`, `hello`, `quick question`, and `before i decide`) require an explicit comma or colon boundary before a complete request; they do not authorize arbitrary comma deletion.

The vocabulary adds 15 concepts and 74 aliases. Thirty-eight new aliases for existing activities cover natural wording of the existing uses without assigning hardware requirements. `daily use` is a new broad activity; it does not imply daily wear or suitability. Six recipient aliases are ordinary relationship wording. Four aliases describe daily use and 26 describe the new device targets. Coordinated concepts such as `reading and video calls` and `drawing and design` remain separate meanings; no full-sentence or combination entry is added.

Samsung Galaxy S23 and MacBook Air M1 are named model targets. Nintendo Switch, iPad/iPad Pro, Android tablets, Windows/USB-C/gaming laptops, MacBook/Air/Pro families, Canon cameras, and Bluetooth-only phones require an exact-model clarification. Device family or connection wording alone cannot prove compatibility, connector details, power, or accessory support. The aliases `older iPad` and `Bluetooth-only phone` preserve what the shopper said but do not supply an age, model, or verified connectivity fact. All device concepts require product evidence before compatibility can be asserted.

Eighteen additional relationship rules express existing semantic roles. `to use for` and `for use during` express intended use; `as a gift for` expresses a recipient; `to wear at` and `to celebrate` express an occasion; `to use with` and `that works with` express a compatibility target. Relative markers such as `who mainly uses it for` express a recipient's stated use only with an explicit person antecedent. This is not a claim that the person belongs to a demographic or that their intended use implies catalog specifications. The marker rules remain data; generic grammar handles attachment, coordination, negation, possessives, and unknown words. A marker may not consume an unrecognized restriction or action merely because its start is recognized.

## Validation applied to the seed

- Required concept fields, unique IDs, and nonempty canonical labels.
- All 257 source CLDR regular region codes present exactly once.
- No duplicate phrase across different concepts after the engine's current normalization.
- Canonical-equivalent and duplicate normalized aliases removed.
- No short country-code aliases in the ordinary matching vocabulary.
- No Arabic-script terms.

## Unicode notice

The country/territory names and mappings above are redistributed under Unicode-3.0. The original English locale data also carries: “Copyright © 1991-2025 Unicode, Inc.” The associated license follows in full.

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2004-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0
```
