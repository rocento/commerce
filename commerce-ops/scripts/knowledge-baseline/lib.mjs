import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const sha256=body=>createHash('sha256').update(body).digest('hex');
export const count=values=>Object.fromEntries([...new Set(values)].sort().map(value=>[value,values.filter(x=>x===value).length]));
export function percentile(values,p){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];}
export function parseJsonSequence(text){
 const output=[];let start=-1,depth=0,string=false,escape=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(start<0){if(/\s/.test(c))continue;if(c!=='{'&&c!=='[')throw new Error('Unexpected non-JSON input at '+i);start=i;}
  if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
  if(c==='"')string=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
  if(depth===0){output.push(JSON.parse(text.slice(start,i+1)));start=-1;}
 }
 if(start>=0)throw new Error('Incomplete JSON sequence');return output;
}
// Observable symptoms, not a claim to know historical internal root causes.
const taxonomy={
 catalog_filter_leak:'interpretation',comparison_misread_as_conflict:'interpretation',intent_failure:'interpretation',wrong_intent:'interpretation',misinterpreted_condition:'interpretation',ignored_constraints:'interpretation',multi_intent_failure:'interpretation',
 context_loss:'context',false_no_match:'retrieval',imprecise_product_match:'retrieval',wrong_or_missing_product:'retrieval',
 generic_restatement:'response_quality',irrelevant_generic_answer:'response_quality',generic_clarification:'response_quality',unnecessary_clarification:'response_quality',incomplete_answer:'response_quality',limited_clarification:'response_quality',
 unsupported_action:'unsupported_action',assistant_error:'operational_error',unhelpful_no_match:'unattributed_no_match',
};
export function classifyHistorical(row){
 const tags=(row.failure_categories??'').split(';').filter(Boolean);
 const unknown=tags.filter(tag=>!Object.hasOwn(taxonomy,tag));
 if(unknown.length)throw new Error('Unmapped historical labels: '+unknown.join(','));
 return {categories:[...new Set(tags.map(tag=>taxonomy[tag]))].sort(),basis:'historical assessment labels; provisional symptom classification',historicalTags:tags,
  missingCatalogEvidence:'not_established_by_saved_grade',evaluationError:'requires_independent_review',
  missingEvidenceSignal:/cannot verify|couldn[’']t verify|not (?:listed|provided)|not enough information/i.test(row.assistant_responses??''),
  causalLimit:'No-match and uncertainty wording alone cannot distinguish missing products, missing facts, retrieval defects, or correct abstention.'};
}
export function classifyCurrent(row){
 return [...new Set(row.failures.map(f=>/followup/.test(f.code)?'context':'interpretation'))].sort();
}
export function familySplit(family){
 // Entire source families stay together, including all store variants.
 return parseInt(sha256('enterprise-phase0-split-v1:'+family).slice(0,8),16)%5===0?'reserved_regression':'development_regression';
}
export function validateBenchmarkApproval(approved,candidate,candidateSha256){
 assert.equal(approved.status,'owner_approved_after_ai_review');
 assert.equal(approved.humanApproved,true);
 assert.equal(approved.humanReviewed,false,'Do not convert delegated AI assessment into independent human review');
 assert.equal(approved.independentHumanAdjudication,false);
 assert.equal(approved.executed,false);
 assert.equal(approved.approval.conditionSatisfied,true);
 assert.equal(approved.sourceCandidate.sha256,candidateSha256);
 assert.equal(approved.cases.length,candidate.cases.length);
 assert.equal(new Set(approved.cases.map(c=>c.key)).size,candidate.cases.length);
 for(const c of approved.cases){
  const prior=candidate.cases.find(p=>p.key===c.key);assert.ok(prior,'Unexpected benchmark case');
  assert.deepEqual(c.turns,prior.turns,'Approval must not silently change the shopper prompt');
  assert.equal(c.family,prior.family);assert.equal(c.store,prior.store);
  assert.equal(c.split,prior.split==='held_out_candidate'?'held_out_reserved':prior.split);
  assert.equal(c.executed,false);assert.equal(c.review.status,'approved');
  assert.equal(c.review.realistic,true);assert.equal(c.review.expectedBehaviorAppropriate,true);
  assert.ok(c.review.notes.length>0);assert.ok(c.expected.length>0);assert.ok(c.fixture.currencyPolicy);
 }
 return true;
}
