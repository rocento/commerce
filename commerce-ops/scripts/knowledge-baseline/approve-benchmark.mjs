// Records the owner's specific 2026-10-10 conditional approval after AI review.
// Does not execute prompts, import a dataset, or change runtime/production data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,count} from './lib.mjs';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-phase0-20261010'));
const target=join(out,'benchmark-approved.json');
if(existsSync(target))throw new Error('Approved revision already exists; preserve it and create a new explicit revision for further changes.');
const originalBytes=readFileSync(join(out,'benchmark-candidate.json'));
const candidate=JSON.parse(originalBytes);
assert.equal(candidate.cases.length,24);assert.equal(candidate.executed,false);
const source=[
 {id:'fda-fragrances',url:'https://www.fda.gov/cosmetics/cosmetic-ingredients/fragrances-cosmetics',checkedOn:'2026-10-10',supports:'Unscented labeling does not establish absence of fragrance ingredients.'},
 {id:'fda-pregnancy',url:'https://www.fda.gov/cosmetics/resources-consumers-cosmetics/cosmetics-pregnancy',checkedOn:'2026-10-10',supports:'Cosmetic safety concerns during pregnancy should be discussed with a health care provider; this benchmark does not prescribe treatment.'},
 {id:'fda-shelf-life',url:'https://www.fda.gov/cosmetics/cosmetics-labeling/shelf-life-and-expiration-dating-cosmetics',checkedOn:'2026-10-10',supports:'Shelf life concerns product-specific safe use over time. A generic duration alone cannot identify the expiry date of a particular shipment.'},
];
const notes={
 purpose_budget:'Common purpose-and-budget shopping request. Expectations preserve the budget and require evidence for suitability, without promising stock or imposing invented hardware thresholds.',
 ambiguous_currency:'Plausible cross-border purchase. The prompt makes the dollar denomination ambiguous; the fixture supplies no prior currency choice.',
 model_compatibility:'Common request with insufficient product identity. Targeted model/specification clarification is useful; a shared brand is not proof of compatibility.',
 recipient_quantity:'Realistic household planning. Headcount and purchase quantity must remain separate; shopping guidance does not authorize a cart write.',
 negative_ingredient:'Realistic ingredient exclusion. Missing label evidence must remain unknown; no guarantee about individual allergy safety is inferred.',
 unit_comparison:'Practical shopper arithmetic with all operands supplied. Verified calculations are 6/0.75=8, 9/1.2=7.5, 3/0.25=12, and 6/0.6=10 currency units per kilogram.',
 gift_budget:'Common gift request. Recipient and occasion are useful context but do not determine material preferences, fit, or a delivery promise.',
 material_exclusion:'Material and color/plating are meaningfully distinct. The expectations require evidence rather than an authenticity assumption.',
 service_policy:'Realistic customization/return question. A pendant can have relevant dimensions; the policy must come from the merchant, not a generic rule.',
 explicit_product_read:'Realistic product/label search. Unscented and fragrance-free remain distinct; neither establishes individual medical suitability.',
 pregnancy_evidence:'Realistic reassurance question. General evidence boundaries and a health-care-provider referral are appropriate; no product-specific medical conclusion is supplied.',
 batch_expiry:'Realistic stock question. Generic shelf life and current batch expiry are different; actual shipment expiry remains unknown until the relevant item/batch is identifiable.',
};
const revised={
 'EK0-019':['Recognize sunscreen, an unscented-label requirement, and a strict price cap.','Verify the unscented claim from relevant product evidence. Do not equate unscented with fragrance-free or infer absence of fragrance ingredients.','Do not infer individual medical suitability.'],
 'EK0-023':['Ask which product is meant if no product is selected, then retrieve relevant batch-specific stock evidence if available.','State the expiry of the actual item to be sent only when its allocation/batch identity and expiry are verified; otherwise explain that it cannot yet be confirmed.','Do not substitute generic shelf life for the shipment batch expiry date.'],
 'EK0-024':['Identify the product and relevant current batch before stating its expiry date.','Distinguish generic shelf life from actual batch expiry; do not calculate a calendar date without the required batch/manufacture evidence.','Report unknown when the current batch date is unavailable.'],
};
const cases=candidate.cases.map(c=>({...c,split:c.split==='held_out_candidate'?'held_out_reserved':c.split,expected:revised[c.key]??c.expected,
 fixture:{language:'en',priorConversation:[],selectedProducts:[],catalogSnapshot:null,merchantPolicy:null,currencyPolicy:c.family==='ambiguous_currency'?'No established currency; the explicit cross-currency ambiguity requires clarification.':'For bare $ amounts, this synthetic fixture declares USD. This is not a universal interpretation of the $ symbol.',evidenceAvailability:'No product facts, stock, merchant policy, or shipment allocation is supplied by the prompt alone. Evaluate an actual response against its separately identified fixture/snapshot.'},
 review:{status:'approved',decision:revised[c.key]?'approve_with_clarification':'approve',approver:'project owner (user)',assessedBy:'Codex (AI)',reviewedOn:'2026-10-10',realistic:true,expectedBehaviorAppropriate:true,notes:notes[c.family],clarifications:revised[c.key]?'Expectation clarified under owner-authorized AI review; original proposal retained.':'No change to expected obligations; shared fixture assumptions made explicit.'},
 evidenceSources:c.key==='EK0-019'?['fda-fragrances']:c.family==='pregnancy_evidence'?['fda-pregnancy']:c.family==='batch_expiry'?['fda-shelf-life']:[],executed:false}));
const approved={schemaVersion:1,code:'enterprise-phase0-approved-benchmark',revision:2,createdAt:new Date().toISOString(),status:'owner_approved_after_ai_review',humanApproved:true,humanReviewed:false,independentHumanAdjudication:false,executed:false,
 sourceCandidate:{file:'benchmark-candidate.json',sha256:sha256(originalBytes),revision:candidate.revision},
 approval:{actor:'project owner (user)',date:'2026-10-10',exactUserMessage:'all approved if u see it relastice and good answers',condition:'AI review finds the cases realistic and their expected behavior appropriate.',conditionSatisfied:true,interpretation:'Owner authorized AI assessment and approved suitable cases. This records owner approval, not independent human case-by-case adjudication or approval of unobserved engine answers.'},
 splitPolicy:{unit:'whole semantic family across stores',heldOutUse:'Reserved prompts must remain unexecuted during development; a later authorized evaluation must record release, rubric, and fixture identity.',independence:'Family-disjoint within this benchmark and exact-prompt-disjoint from the original 10000-case corpus. Semantic novelty, independent authorship, and production accuracy are not certified.'},
 gradingPolicy:{expected:'Meaning-level obligations, not exact answer strings.',unknown:'When required evidence is absent, a targeted clarification or honest unknown may be correct; generic restatement is insufficient.',scope:'Scenarios include language, arithmetic, retrieval, and response obligations. Parser-only success cannot establish final-answer correctness.',executionStatus:'No benchmark answers evaluated. Executable assertions and catalog fixtures belong to the next implementation stage.'},
 membership:count(cases.map(c=>c.split)),sources:source,cases};
assert.equal(cases.filter(c=>c.split==='held_out_reserved').length,16);
assert.equal(new Set(cases.map(c=>c.key)).size,24);
for(const c of cases)assert.ok(c.review.notes);
writeFileSync(target,JSON.stringify(approved,null,2)+'\n');
const lines=['# Phase 0 approved benchmark','','Status: owner-approved after AI review, 2026-10-10. All 24 scenarios are accepted as realistic and their expected behavior is appropriate. These are expected outcomes, not observed engine answers.','','Approval from the project owner: “all approved if u see it relastice and good answers”. Codex performed the requested review. This is owner approval with delegated AI assessment; independent human case-by-case adjudication is not claimed.','','The original proposal remains in `benchmark-candidate.json`. Approved revision 2 is in `benchmark-approved.json`. Eight development cases and sixteen reserved cases remain unexecuted.','','## Review clarifications','','- Bare `$` amounts have an explicit USD test-fixture context. The two cross-currency cases intentionally have no established currency.','- Unscented labeling is not treated as proof that a product is fragrance-free. [FDA fragrance guidance](https://www.fda.gov/cosmetics/cosmetic-ingredients/fragrances-cosmetics).','- Batch/expiry questions first establish the product and batch. The assistant cannot promise the expiry of an unallocated shipment.','- Pregnancy cases assess evidence limits and appropriate referral, not medical treatment or personal safety recommendations. [FDA pregnancy guidance](https://www.fda.gov/cosmetics/resources-consumers-cosmetics/cosmetics-pregnancy).','','The unit-price arithmetic was checked independently: 8 versus 7.50 USD/kg, and 12 versus 10 USD/kg. All prompts are unchanged; three cases have clarified expectations and every case has explicit fixture assumptions.','','## Evaluation boundary','','No case is claimed to pass the engine. No production dataset or rule was changed. The sixteen reserved cases must not be used to tune implementation. Similarity to earlier behavior remains possible despite zero exact overlap with historical prompts.'];
for(const c of cases)lines.push('',`## ${c.key} — ${c.store} / ${c.family} / ${c.split}`,'',`> ${c.turns[0]}`,'',...c.expected.map(x=>'- '+x),'',`Decision: ${c.review.decision}  `,'Approver: project owner (user)  ','Assessment: Codex (AI)  ',`Review note: ${c.review.notes}`);
writeFileSync(join(out,'benchmark-review.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({approved:cases.length,membership:approved.membership,humanApproved:true,independentHumanAdjudication:false,executed:false}));
