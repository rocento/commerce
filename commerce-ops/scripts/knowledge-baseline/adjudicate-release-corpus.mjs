/** A versioned semantic correction of the frozen corpus, never a prediction-to-label conversion. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const root=new URL('../../',import.meta.url);
const original=new URL('output/enterprise-knowledge-release-prep-20261010/production-corpus.jsonl',root);
export const originalSha256='fe898fcdafd7c189d5226079558071348ecb8b941f1c28090b37c92df5dbaf74';
const sha=value=>createHash('sha256').update(value).digest('hex');
export {adjudicateCase,contracts} from '../../commerce-assistant-platform/app/commerce_language_engine/src/generation/corpus-adjudication.ts';
import {adjudicateCase,contracts} from '../../commerce-assistant-platform/app/commerce_language_engine/src/generation/corpus-adjudication.ts';

export function retainedRationale(input){
 const family=input.templateFamily??'',source=input.source??'';
 if(family==='conditional-feasibility')return {group:'parser_courtesy',rationale:'If possible is a courtesy envelope in this authored frame. Preserve the underlying requested meaning; it is not a product evidence constraint.'};
 if(source==='contrastive-coverage-v6'||source==='contrastive-v2'&&family==='never-action')return {group:'parser_polarity',rationale:'The explicit command is negated. Preserve UNKNOWN and no positive operation; do not reinterpret negation as a product exclusion.'};
 if(source==='fragment-coverage-v6')return {group:'parser_incomplete_fragment',rationale:'A bare verb or dangling determiner lacks an object and destination; retain UNKNOWN. My/the are not product names, and track alone cannot authorize an order lookup.'};
 if(source==='informal-coverage-v6'||family==='informal-and-typo-requests')return {group:'parser_courtesy_typos',rationale:'The bounded authored typos preserve an explicit order/cart target; courtesy punctuation must not prevent the safe declared read/reorder interpretation.'};
 if(source==='transition-v2')return {group:'parser_context_transition',rationale:'The supplied context and literal noun define the intended transition. Preserve the authored intent unless a separately listed fixture rule applies; do not infer identity or cross target types.'};
 if(source==='product-search-requests-v2')return {group:'parser_product_representation',rationale:'The generator uniformly expects normalized productText across conversational search heads. Keep exact entity assertions and fix inconsistent extraction instead of copying the output into labels.'};
 if(source==='compositional-structure-v4'||source==='linguistic-coverage-v6')return {group:'parser_action_arguments',rationale:'Explicit products, quantities and destinations define the write request. Preserve original intent and entity assertions; missing product categories are separately adjudicated.'};
 if(['intent-command-v2','syntax-composition-v6'].includes(source))return {group:'parser_dictionary_action_object',rationale:'The original action and object vocabulary define a meaningful commerce request. Courtesy should preserve it, dictionary read objects must outrank generic shopping interpretations, and write polarity must remain intact.'};
 return {group:'retain_original_semantics',rationale:'Original semantic expectation retained; no prediction-derived correction is authorized by this review.'};
}

export async function buildRevision(out){
 const bytes=await readFile(original);assert.equal(sha(bytes),originalSha256,'Frozen original corpus was modified');
 const sourceCases=bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);assert.equal(sourceCases.length,136368);
 const oldFailures=await readFile(new URL('output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/all-failures.jsonl',root),'utf8');
 // Deliberately select only case identifiers and original expectations; observed outputs are not inputs to adjudicateCase.
 const failedIndexes=new Set(oldFailures.trimEnd().split('\n').map(row=>JSON.parse(row).caseIndex));
 const patches=[],review=[],nextCases=sourceCases.map((input,caseIndex)=>{
  const {next,rules,changed}=adjudicateCase(input);
  if(changed)patches.push({caseIndex,caseNumber:caseIndex+1,source:input.source,templateFamily:input.templateFamily,text:input.text,originalSha256:sha(JSON.stringify(input)),correctedSha256:sha(JSON.stringify(next)),rules,before:input,after:next});
  if(failedIndexes.has(caseIndex))review.push({caseIndex,caseNumber:caseIndex+1,text:input.text,source:input.source,templateFamily:input.templateFamily,disposition:changed?'benchmark_correction':'parser_repair_required',rules,...(changed?{group:'benchmark_correction',rationale:rules.map(rule=>contracts[rule].rationale).join(' ')}:retainedRationale(input)),expectation:next});
  assert.equal(input.text,next.text);assert.equal(input.source,next.source);assert.equal(input.split,next.split);assert.equal(input.difficulty,next.difficulty);assert.equal(input.templateFamily,next.templateFamily);
  for(const [key,value] of Object.entries(input.entities??{})){
   assert.ok(key in (next.entities??{}),'Existing entity assertions cannot be removed');
   if(key==='productText'&&rules.includes('literal_question_product'))assert.equal(String(next.entities[key]).toLowerCase(),value,'Literal case repair cannot change product meaning');
   else assert.ok(isDeepStrictEqual(value,next.entities[key]),'Existing entity assertions cannot be weakened');
  }
  return next;
 });
 assert.equal(review.length,2253);
 const corpusBytes=Buffer.from(nextCases.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const byRule={};for(const patch of patches)for(const rule of patch.rules)byRule[rule]=(byRule[rule]??0)+1;
 const byDisposition={};for(const row of review)byDisposition[row.disposition]=(byDisposition[row.disposition]??0)+1;
 const summary={schemaVersion:1,revision:'enterprise-release-corpus-'+sha(corpusBytes).slice(0,12),originalSha256,corpusSha256:sha(corpusBytes),caseCount:sourceCases.length,changedCases:patches.length,unchangedCases:sourceCases.length-patches.length,originalFailuresReviewed:review.length,byDisposition,byRule,reviewKind:'AI-assisted semantic family adjudication, requested by user; no claim of independent human per-case approval',constraints:['Every original case retained in its original position; no text/split/source/family/difficulty changed.','No entity assertion removed or weakened; two literal case representations corrected and explicit discount-ranking assertions added.','Only authoring-provenance industry context restored; no product/order identity invented.','Rules apply to all matching original cases, not only failed cases.','No runtime imports or predictions used to derive replacement expectations.','This corpus is synthetic regression evidence, not independent held-out shopper accuracy.'],contracts};
 await mkdir(out,{recursive:true});
 await writeFile(new URL('reviewed-corpus.jsonl',out),corpusBytes,{flag:'wx'});
 await writeFile(new URL('benchmark-patches.jsonl',out),patches.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
 await writeFile(new URL('benchmark-review.jsonl',out),review.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
 await writeFile(new URL('benchmark-adjudication.json',out),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 const samples=Object.fromEntries(Object.keys(contracts).map(rule=>[rule,patches.filter(p=>p.rules.includes(rule)).slice(0,3)]));
 await writeFile(new URL('benchmark-review-samples.json',out),JSON.stringify(samples,null,2)+'\n',{flag:'wx'});
 return summary;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const output=process.argv[2]?new URL('file://'+process.argv[2].replace(/\/$/,'')+'/'):new URL('output/enterprise-knowledge-release-repair-20261010/benchmark-v1/',root);
 console.log(JSON.stringify(await buildRevision(output),null,2));
}
