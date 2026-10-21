import {withDictionaryRecognition} from './recognition-rules.ts';
/** Operator-reviewed regression cases. Customer feedback never changes runtime rules. */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {compile} from './compiler.ts';
import {resolve} from './engine.ts';
import {resolutionEnvelope} from './resolution-wire.ts';
import type {Context,Dictionary} from './types.ts';
import type {ReleaseClient} from './release-lifecycle.ts';
export type ReviewedCase={key:string;text:string;language:string;industry:string;context?:Context;expected:{intent:string|null;status:string;entities?:Record<string,unknown>;actions?:unknown[];missing?:string[]};sourceFeedbackId?:string};
export type DatasetInput={code:string;revision:number;reviewedBy:string;cases:ReviewedCase[]};
export type ReviewedEvaluation={datasetId:string;datasetSha256:string;count:number;failureCount:number;passed:boolean;results:{key:string;passed:boolean;actual:Record<string,unknown>;mismatches:string[]}[]};
function object(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function keys(v:Record<string,unknown>,allowed:string[]){for(const k of Object.keys(v))if(!allowed.includes(k))throw new Error('Unknown field: '+k);}
function nonempty(v:unknown,name:string):asserts v is string {if(typeof v!=='string'||!v.trim())throw new Error(name+' must be nonempty');}
function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export function validateCase(value:unknown):ReviewedCase {
 if(!object(value))throw new Error('Case must be an object');
 keys(value,['key','text','language','industry','context','expected','sourceFeedbackId']);
 for(const k of ['key','text','language','industry'])nonempty(value[k],k);
 if((value.text as string).length>4000)throw new Error('Case text exceeds 4000 characters');
 if(value.language!=='en')throw new Error('Reviewed evaluator currently supports en only');
 if(value.context!==undefined&&!object(value.context))throw new Error('Context must be an object');
 if(value.sourceFeedbackId!==undefined&&!(typeof value.sourceFeedbackId==='string'&&/^[1-9][0-9]*$/.test(value.sourceFeedbackId)))throw new Error('sourceFeedbackId must be a positive integer string');
 const e=value.expected;if(!object(e))throw new Error('Expected result must be an object');
 keys(e,['intent','status','entities','actions','missing']);
 if(e.intent!==null)nonempty(e.intent,'expected.intent');
 if(!['RESOLVED','NEEDS_CONTEXT','AMBIGUOUS','UNKNOWN','UNSUPPORTED','DENIED'].includes(String(e.status)))throw new Error('Invalid expected.status');
 if(e.entities!==undefined&&!object(e.entities))throw new Error('Expected entities must be an object');
 if(e.actions!==undefined&&(!Array.isArray(e.actions)||!e.actions.every(object)))throw new Error('Expected actions must be an array of objects');
 if(e.missing!==undefined&&(!Array.isArray(e.missing)||!e.missing.every(v=>typeof v==='string')))throw new Error('Expected missing slots must be strings');
 return value as ReviewedCase;
}
export function validateDataset(value:unknown):DatasetInput {
 if(!object(value))throw new Error('Dataset must be an object');keys(value,['code','revision','reviewedBy','cases']);
 nonempty(value.code,'code');nonempty(value.reviewedBy,'reviewedBy');
 if(!Number.isSafeInteger(value.revision)||Number(value.revision)<1)throw new Error('revision must be a positive integer');
 if(!Array.isArray(value.cases)||!value.cases.length||value.cases.length>10000)throw new Error('Dataset requires 1–10000 cases');
 const cases=value.cases.map(validateCase);if(new Set(cases.map(c=>c.key)).size!==cases.length)throw new Error('Duplicate case key');
 return {...value,cases:cases.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)} as DatasetInput;
}
async function transaction<T>(c:ReleaseClient,work:()=>Promise<T>){await c.query('BEGIN');try{const result=await work();await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}}
export async function importDataset(c:ReleaseClient,value:unknown){
 const input=validateDataset(value),sha256=hash(input),id=randomUUID();
 return transaction(c,async()=>{
  // Serialize repeat imports by logical version; differing content cannot replace a review.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[input.code+':'+input.revision]);
  const existing=(await c.query('SELECT id,sha256 FROM evaluation.datasets WHERE code=$1 AND revision=$2',[input.code,input.revision])).rows[0];
  if(existing){if(existing.sha256!==sha256)throw new Error('Dataset revision already exists with different content');return {datasetId:existing.id,sha256,imported:false};}
  await c.query('INSERT INTO evaluation.datasets(id,code,revision,sha256,reviewed_by) VALUES($1,$2,$3,$4,$5)',[id,input.code,input.revision,sha256,input.reviewedBy]);
  for(const row of input.cases){const {sourceFeedbackId,...definition}=row;await c.query('INSERT INTO evaluation.cases(dataset_id,case_key,definition,source_feedback_id) VALUES($1,$2,$3,$4)',[id,row.key,definition,sourceFeedbackId??null]);}
  return {datasetId:id,sha256,imported:true};
 });
}
export async function loadDataset(c:ReleaseClient,id:string){
 const row=(await c.query('SELECT * FROM evaluation.datasets WHERE id=$1',[id])).rows[0];if(!row)throw new Error('Dataset not found');
 const cases=(await c.query('SELECT definition,source_feedback_id FROM evaluation.cases WHERE dataset_id=$1 ORDER BY case_key',[id])).rows.map(r=>({...r.definition,...(r.source_feedback_id?{sourceFeedbackId:String(r.source_feedback_id)}:{})}));
 // Hash cases in a stable order on both import and load.
 const input=validateDataset({code:row.code,revision:row.revision,reviewedBy:row.reviewed_by,cases});
 if(hash(input)!==row.sha256)throw new Error('Dataset content hash mismatch');
 return {id,sha256:row.sha256 as string,...input};
}
export function evaluateReviewedDataset(dictionary:Dictionary,dataset:Awaited<ReturnType<typeof loadDataset>>,identity:{releaseId:string;runtimeSha256:string}):ReviewedEvaluation {
 return withDictionaryRecognition(dictionary,()=>{
 const runtime=compile({...dictionary,corpus:[]});
 const results=dataset.cases.map(test=>{
  const mismatches:string[]=[];let actual:Record<string,unknown>={};
  try{
   const result=resolve(runtime,test.text,test.context);
   resolutionEnvelope({...result},{releaseId:identity.releaseId,generationFingerprint:dictionary.generationFingerprint!,runtimeVersion:identity.runtimeSha256,normalizationVersion:'english-v1',clauseSpanEncoding:'utf-16-code-units',evidenceSpanEncoding:'unicode-code-points'});
   actual={intent:result.intent??null,status:result.status,entities:result.entities??{},actions:result.actions??[],missing:result.missing??[]};
   for(const [key,expected] of Object.entries(test.expected)){
    if(key==='entities'){for(const [entity,value] of Object.entries(expected as Record<string,unknown>))if(!isDeepStrictEqual((actual.entities as Record<string,unknown>)[entity],value))mismatches.push('entities.'+entity);}
    else if(!isDeepStrictEqual(actual[key],expected))mismatches.push(key);
   }
  }catch(error){actual={error:error instanceof Error?error.message:String(error)};mismatches.push('resolution_or_contract_error');}
  return {key:test.key,passed:mismatches.length===0,actual,mismatches};
 });
 const failureCount=results.filter(r=>!r.passed).length;
 return {datasetId:dataset.id,datasetSha256:dataset.sha256,count:results.length,failureCount,passed:failureCount===0,results};

 });
}
/** Called inside the transaction that inserts the parent release evaluation. */
export async function saveReviewedResults(c:ReleaseClient,evaluationId:string,result:ReviewedEvaluation){
 const dataset=await loadDataset(c,result.datasetId);
 if(dataset.sha256!==result.datasetSha256||dataset.cases.length!==result.count||result.results.length!==result.count||new Set(result.results.map(r=>r.key)).size!==result.count||dataset.cases.some(c=>!result.results.some(r=>r.key===c.key))||result.results.filter(r=>!r.passed).length!==result.failureCount||result.passed!==(result.failureCount===0))throw new Error('Reviewed result membership or summary mismatch');
 await c.query('INSERT INTO evaluation.dataset_runs(evaluation_id,dataset_id,dataset_sha256,case_count,failure_count) VALUES($1,$2,$3,$4,$5)',[evaluationId,result.datasetId,result.datasetSha256,result.count,result.failureCount]);
 for(const row of result.results){if(row.passed!==(row.mismatches.length===0))throw new Error('Result mismatch status is inconsistent');await c.query('INSERT INTO evaluation.case_results(evaluation_id,dataset_id,case_key,passed,actual,mismatches) VALUES($1,$2,$3,$4,$5,$6)',[evaluationId,result.datasetId,row.key,row.passed,row.actual,JSON.stringify(row.mismatches)]);}
}
export async function captureFeedback(c:ReleaseClient,input:{tenantId:string;requestId:string;releaseId:string;engineVersion:string;observedCase:ReviewedCase;predictedIntent:string|null;status:string}){
 const observed=validateCase(input.observedCase);if(observed.sourceFeedbackId)throw new Error('Captured feedback cannot reference another feedback record');
 nonempty(input.engineVersion,'engineVersion');nonempty(input.status,'status');
 const result=await c.query(`INSERT INTO resolution.feedback(tenant_id,request_id,release_id,utterance_hash,dictionary_version,engine_version,predicted_intent,status,source,input)
 SELECT $1,$2,d.id,$4,d.dictionary_version,$5,$6,$7,'operator-import',$8 FROM release.dictionaries d WHERE d.id=$3 RETURNING id`,[input.tenantId,input.requestId,input.releaseId,hash(observed.text),input.engineVersion,input.predictedIntent,input.status,observed]);
 if(!result.rowCount)throw new Error('Feedback release not found');return {feedbackId:String(result.rows[0].id)};
}
export async function reviewFeedback(c:ReleaseClient,input:{feedbackId:string;decision:'approved'|'rejected';reviewer:string;reason:string;correctedCase?:ReviewedCase}){
 nonempty(input.reviewer,'reviewer');nonempty(input.reason,'reason');
 if(!['approved','rejected'].includes(input.decision))throw new Error('Invalid review decision');
 const correction=input.decision==='approved'?validateCase(input.correctedCase):null;
 if(correction?.sourceFeedbackId)throw new Error('Correction must not contain sourceFeedbackId');
 if(input.decision==='rejected'&&input.correctedCase)throw new Error('Rejected feedback cannot supply a correction');
 await c.query('INSERT INTO resolution.feedback_reviews(feedback_id,decision,reviewer,reason,corrected_case) VALUES($1,$2,$3,$4,$5)',[input.feedbackId,input.decision,input.reviewer,input.reason,correction]);
 return {feedbackId:input.feedbackId,decision:input.decision};
}
