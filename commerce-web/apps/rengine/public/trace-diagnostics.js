// Presentation contract v2. Pure projections of the authorized, redacted report.
// Evidence IDs refer to journey steps, never another request or a current release.
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const text=value=>typeof value==='string'&&value.trim()?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const fact=(step,key,label,value,note=null)=>({key,label,value:value??null,state:value===null||value===undefined?'not_recorded':'recorded',note,evidence:[step.id]});
const metric=(value,evidence=[],note=null)=>({value,state:value===null?'not_recorded':'derived',evidence,note});
const clarificationRoutes=new Set(['language_engine_clarify','language_engine_context','product_action_choice','delivery_location_required','reorder_review']);

export function filterChecks(e){
 if(!Array.isArray(e.check_steps)||!e.check_steps.length||e.check_steps.length>32)return null;
 let before=count(e.products_before);if(before===null)return null;
 for(const check of e.check_steps){if(!check||!text(check.check)||count(check.before)!==before||count(check.after)===null||check.after>before)return null;before=check.after;}
 return before===count(e.products_after)?e.check_steps:null;
}

/** @typedef {{key:string,label:string,value:unknown,state:'recorded'|'not_recorded',note:string|null,evidence:string[]}} EvidenceFact */
/** @typedef {{id:string,priority:number,title:string,description:string,evidence:string[]}} DiagnosticFinding */

/** Selected facts only: unknown/missing fields remain missing, including zero usage. */
export function stepFacts(step){
 const e=object(step.evidence),rows=[];
 const add=(key,label,value,note)=>rows.push(fact(step,key,label,value,note));
 if(['http_boundary','service_span'].includes(step.stage)){add('operation','Operation',text(e.operation));if(step.stage==='http_boundary')add('peer','Peer service',text(e.peer_service));else add('service','Recording service',text(step.service));add('http-status','HTTP status',count(e.http_status));if(step.stage==='http_boundary')add('remote','Remote evidence',text(e.remote_evidence));if(step.stage==='service_span')add('clock-alignment','Cross-service clock alignment',null,'Remote elapsed time does not establish a start offset on the Python clock.');}
 if(['initial_language_result','interpretation_before_fallback'].includes(step.stage)){
  add('intent','Interpreted intent',text(e.intent));add('status','Resolution status',text(e.status));
  add('actions','Requested actions',e.requested_actions);add('release','Language release',e.language_release);
 }
 if(step.stage==='language_rule_evidence'){
  const result=object(e.result),diagnostics=object(e.diagnostics);
  add('original','Original text',text(diagnostics.text));add('normalized','Normalized text',text(diagnostics.normalizedText));
  add('entities','Interpreted entities and constraints',result.entities);
  const candidates=Array.isArray(step.rules?.candidates)?step.rules.candidates:[];
  const selected=candidates.find(candidate=>candidate.selected),runner=selected===candidates[0]?candidates[1]:null;
  add('winner','Selected rule',selected?`${selected.observed.intent} / ${selected.observed.rule??'unspecified'}`:null);
  add('runner','Next ranked candidate',runner?`${runner.observed.intent} / ${runner.observed.rule??'unspecified'}`:null);
  const a=number(selected?.observed?.score),b=number(runner?.observed?.score);
  add('margin','Recorded score margin',a!==null&&b!==null&&a>=b?a-b:null,'Difference within this recorded ranking; not a probability.');
  add('matched','Selected candidate evidence',selected?.observed?.evidence);
  add('missing','Selected candidate missing conditions',selected?.observed?.missing);
 }
 if(step.stage==='language_model_request'){
  add('limit','Output token limit',count(e.max_output_tokens),'This is a limit, not actual usage.');
  add('messages','Prepared messages',Array.isArray(e.messages)?e.messages.length:null);
  add('schema','Output schema',text(e.output_schema?.title));
  add('prompt-version','Prompt version',null);
 }
 if(step.stage==='provider_wire_payload'){
  add('model','Requested model',text(e.model));
  add('attempt','Provider execution',null,'Prepared payload alone does not establish a provider attempt or response.');
 }
 if(step.stage==='language_model_response'){
  add('model','Returned model',text(e.model));add('finish','Finish reason',text(e.finish_reason));
  add('input','Input tokens for this response',count(e.input_tokens));add('output','Output tokens for this response',count(e.output_tokens));
  add('tools','Tool calls proposed',count(e.tool_call_count));
  add('validation','Downstream validation',null,'A response record alone does not establish validation success.');
 }
 if(step.stage==='provider_invalid_response'){
  add('phase','Validation phase',text(e.phase));add('schema','Output schema',text(e.output_schema));
  add('issues','Validation issues',e.validation_issues);
 }
 if(step.stage==='provider_attempt'){
  add('attempt','Dispatch attempt ID',text(e.attempt_id));add('model','Requested model',text(e.requested_model));
  add('returned-model','Returned model',text(e.model));add('mode','Provider mode',text(e.mode));
  add('dispatch-duration','Dispatch through adapter result (ms)',number(e.dispatch_duration_ms),'The span includes preparation; this measurement starts at transport dispatch and includes response validation.');
  add('prompt','Prompt/schema fingerprint',text(e.prompt_fingerprint),'Content fingerprint of instructions and schemas, not a deployed prompt version.');
  add('validation','Adapter validation',text(e.adapter_validation),'Adapter acceptance does not establish downstream task success.');
  add('code','Provider error code',text(e.error_code));
  add('input','Input tokens for this attempt',count(e.input_tokens));add('output','Output tokens for this attempt',count(e.output_tokens));
 }
 if(step.stage==='intent_retrieval'){
  add('inclusion','Examples linked to prepared model input',step.modelInputEvidence?.count??null,'Explicit example identities establish inclusion in a prepared input, not provider execution or completion.');
  if(step.modelInputEvidence)rows.at(-1).evidence.push(...step.modelInputEvidence.steps);
 }
 if(step.stage==='catalog_filter'){
  const checks=filterChecks(e);
  if(checks)for(const [i,check] of checks.entries())add(`check-${i}`,check.check,`${check.before} → ${check.after} products`,`${check.before-check.after} removed · ${check.rejection_reason??'reason not recorded'}. ${check.effect==='ordered_verification_results'?'Ordered effect of recorded verification results':'Sequential filter effect'}; not an independent test.`);
  else add('per-check','Counts per individual check',null,'This capture supplies aggregate counts; individual check effects were not recorded or are inconsistent.');
 }
 if(step.stage==='final_result'){
  add('intent','Final interpreted intent',text(e.language_gate?.intent)??text(e.intent));
  add('completion','Handler completion marker',text(e.completion_evidence),e.completion?.version===1?'The application completion record below determines task status.':'A marker is not the full task-completion record; unresolved constraints may be missing.');
  if(e.completion?.version===1){add('task-status','Application task status',text(e.completion.status));add('task-evidence','Task completion evidence',text(e.completion.evidence));}
  if(e.language_fallback)add('fallback','Language fallback result',text(e.language_fallback?.outcome),'An unconfigured fallback does not establish a provider attempt.');
  add('constraints','Verified constraint fulfillment',null);
 }
 return rows;
}

export function stepInsight(step){
 const e=object(step.evidence);
 if(step.stage==='initial_language_result'&&text(e.intent))return `Interpreted as ${e.intent}${text(e.status)?` · ${e.status}`:''}.`;
 if(step.stage==='execution_route'&&text(e.path))return `Selected ${e.path}${text(e.reason)?` · ${e.reason}`:''}.`;
 if(step.stage==='provider_attempt')return `${e.requested_model??'Model not recorded'} · ${e.outcome??'outcome not recorded'} · ${e.adapter_validation??'validation not recorded'}.`;
 if(step.stage==='language_model_response')return [text(e.model)?`Model: ${e.model}.`:null,count(e.input_tokens)!==null?`${e.input_tokens} input tokens.`:null,count(e.output_tokens)!==null?`${e.output_tokens} output tokens.`:null].filter(Boolean).join(' ')||null;
 if(step.stage==='language_rule_evidence'){
  const selected=step.rules?.candidates?.find(candidate=>candidate.selected);
  if(selected)return `Selected ${selected.observed.intent} / ${selected.observed.rule??'unspecified'}${number(selected.observed.score)!==null?` · score ${selected.observed.score}`:''}.`;
 }
 return null;
}

export function traceDiagnostics(journey){
 const steps=journey.steps??[],original=[...steps].sort((a,b)=>(a.eventIndex??0)-(b.eventIndex??0));
 const terminal=original.filter(step=>step.stage==='final_result').at(-1),e=object(terminal?.evidence);
 const ref=terminal?[terminal.id]:[];
 const outcome=text(e.outcome);
 const execution={value:({completed:'completed',failed:'failed',error:'failed',unavailable:'unavailable',denied:'denied',disconnected:'disconnected'})[outcome]??'completion_not_captured',evidence:ref};
 // Legacy success markers alone cannot prove fulfillment. New reports carry the
 // application-owned completion policy result; never reconstruct it from text.
 let business='unknown',reason='The report does not establish verified task fulfillment.';
 if(outcome==='denied'||['access_denied','login_required'].includes(e.route_reason)){business='blocked';reason='The terminal evidence records an access restriction.';}
 else if(['failed','error','unavailable'].includes(outcome)){business='failed';reason='The terminal evidence records failure or unavailability.';}
 else if(outcome==='completed'&&(['NEEDS_CONTEXT','AMBIGUOUS'].includes(e.language_gate?.status)||clarificationRoutes.has(e.route_reason))){business='clarification_needed';reason='The terminal interpretation or route requires clarification.';}
 const completion=object(e.completion);
 if(business==='unknown'&&outcome==='completed'&&completion.version===1&&completion.request_completed===true){
  if(completion.status==='completed'&&completion.task_completed===true&&['read_result','action_receipt','policy_answer','conversation_reply'].includes(completion.evidence)){business='fulfilled';reason=`The application completion policy verified ${completion.evidence.replaceAll('_',' ')}.`;}
  else if(completion.status==='clarification'){business='clarification_needed';reason='The application completion policy records pending clarification.';}
  else if(['denied','unsupported'].includes(completion.status)){business='blocked';reason='The application completion policy records a restriction or unsupported task.';}
  else if(completion.status==='unavailable'){business='failed';reason='The application completion policy records task unavailability.';}
 }
 const businessOutcome={value:business,note:reason,evidence:ref};
 const finalIntent=text(e.language_gate?.intent)??text(e.intent);
 const interpretation=original.filter(step=>step.stage==='initial_language_result'&&text(step.evidence?.intent)).at(-1);
 const rule=original.filter(step=>step.stage==='language_rule_evidence'&&text(step.evidence?.result?.intent)).at(-1);
 const goalStep=finalIntent?terminal:interpretation??rule;
 const goal={value:finalIntent??text(interpretation?.evidence?.intent)??text(rule?.evidence?.result?.intent),evidence:goalStep?[goalStep.id]:[],note:finalIntent?'Final recorded interpretation; not verified customer intent.':'Earlier recorded interpretation; the final interpretation may differ.'};
 const responses=original.filter(step=>step.stage==='language_model_response');
 const usage=key=>{
  const recorded=responses.filter(step=>count(step.evidence?.[key])!==null);
  return metric(recorded.length?recorded.reduce((sum,step)=>sum+step.evidence[key],0):null,recorded.map(step=>step.id),'Only captured language-model responses; not total request usage.');
 };
 const measured=steps.filter(step=>number(step.durationMs)!==null).sort((a,b)=>b.durationMs-a.durationMs);
 const longest=measured[0];
 const findings=[];
 const finding=(id,priority,title,description,refs)=>findings.push({id,priority,title,description,evidence:refs});
 for(const step of original){
  const data=object(step.evidence);
  if(['error','failed'].includes(data.outcome)||step.stage==='provider_invalid_response')finding(`failure:${step.id}`,0,step.stage==='provider_invalid_response'?'AI response failed validation':'An error was recorded','Inspect the terminal outcome to see whether the request recovered.',[step.id]);
 }
 if(['failed','unavailable'].includes(execution.value)&&!findings.some(item=>item.evidence.includes(terminal.id)))finding('terminal-failure',0,'Request did not complete successfully','The final event records failure or unavailability.',ref);
 if(['blocked','clarification_needed'].includes(business))finding('business',1,business==='blocked'?'Access restriction recorded':'Clarification required',reason,ref);
 for(const step of original){
  const data=object(step.evidence);
  if(step.stage==='catalog_filter'&&data.products_after===0&&count(data.products_before)!==null){const checks=filterChecks(data),last=checks?.find(check=>check.before>0&&check.after===0);finding(`filter:${step.id}`,2,last?`No products remained after ${last.check.toLowerCase()}`:'No products remained after filtering',last?`${last.before} → 0 products at this recorded check. Earlier checks may already have narrowed the results.`:`${data.products_before} products before checks; 0 afterward.${checks?'':' Per-check effects are not captured.'}`,[step.id]);}
  else if(step.title==='ShoppingCatalog.call'&&data.outcome==='returned'&&data.details?.operation==='search_products'&&data.details?.products_returned===0)finding(`catalog:${step.id}`,2,'Catalog search returned no products','The count alone does not establish why the search was empty.',[step.id]);
  else if(step.stage==='intent_retrieval'&&['empty','unavailable','unconfigured'].includes(data.status))finding(`retrieval:${step.id}`,3,({empty:'Example lookup returned no matches',unavailable:'Example lookup was unavailable',unconfigured:'Example lookup was not configured'})[data.status],'This observation alone does not establish request failure.',[step.id]);
 }
 if(text(e.language_fallback?.outcome))finding('fallback',3,'Language fallback recorded',`Recorded fallback result: ${e.language_fallback.outcome}. This does not establish a provider attempt or request failure.`,ref);
 if(longest)finding('longest',4,'Longest recorded span',`${longest.title}: ${longest.durationMs.toFixed(1)} ms inclusive of nested work and waiting. This is not an end-to-end bottleneck diagnosis.`,[longest.id]);
 findings.sort((a,b)=>a.priority-b.priority);
 const timingCount=steps.filter(step=>number(step.atMs)!==null||number(step.startMs)!==null).length;
 const measurements=object(e.measurements),totals=object(e.provider_totals);
 const validMeasurement=measurements.version===1&&measurements.unit==='ms'&&measurements.clock_domain==='python-turn-monotonic'&&measurements.trace_id===journey.requestId&&measurements.duration_boundary==='turn_start_to_lease_closed';
 const duration=validMeasurement?number(measurements.request_duration_ms):null;
 const firstText=validMeasurement&&measurements.first_text_boundary==='server_text_event_created'&&number(measurements.first_text_ms)!==null&&duration!==null&&measurements.first_text_ms<=duration?measurements.first_text_ms:null;
 const validTotals=totals.version===1&&totals.scope==='openai_responses_dispatch'&&count(totals.attempts)!==null&&count(totals.completed)!==null&&totals.completed<=totals.attempts;
 const providerUsage=key=>{const value=validTotals&&(totals.completed>0||totals.attempts===0)?count(totals[key]):null;return metric(value,ref,totals.usage_complete===true&&totals.completed===totals.attempts?'Validated usage for all recorded OpenAI Responses dispatches; excludes embeddings.':'Validated completed dispatches only; failed or incomplete attempt usage is unknown.');};
 return {version:2,goal,execution,businessOutcome,findings,
  metrics:{requestDuration:{...metric(duration,duration===null?[]:ref,'Python turn start to lease close; excludes gateway admission, tracking writes, and browser delivery.'),unit:'ms'},firstText:{...metric(firstText,firstText===null?[]:ref,'Server text-event creation, not browser arrival or provider first token.'),unit:'ms'},modelCalls:validTotals?metric(totals.attempts,ref,'OpenAI Responses transport dispatch attempts, including failures; excludes preparation, budget rejection, and embeddings.'):metric(null,[],'Prepared inputs and response records are not a complete provider-attempt ledger.'),inputTokens:validTotals?providerUsage('input_tokens'):usage('input_tokens'),outputTokens:validTotals?providerUsage('output_tokens'):usage('output_tokens'),estimatedCost:metric(null,[],'No versioned pricing/currency record is available.')},
  capture:{version:journey.capture?.version??null,redacted:typeof journey.capture?.redacted==='boolean'?journey.capture.redacted:null,truncated:journey.truncated===true,timing:!steps.length||!timingCount?'not_recorded':timingCount===steps.length?'recorded':'partial',modelInput:steps.some(step=>['language_model_request','provider_wire_payload'].includes(step.stage))?'recorded':'not_recorded',terminal:terminal?'recorded':'not_recorded'},
 };
}
