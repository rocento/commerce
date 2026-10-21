import {readFile} from 'node:fs/promises';
import {traceDiagnostics} from './public/trace-diagnostics.js';
const rulebook=await readFile(new URL('./rulebook.json',import.meta.url),'utf8').then(JSON.parse).catch(()=>null);

/** Join only immutable generation identities. Never substitute today's rules for an old request. */
export function ruleEvidence(envelope, catalog=rulebook) {
  const candidates=envelope?.diagnostics?.debug?.candidates??[];
  const fingerprint=envelope?.provenance?.generationFingerprint;
  const matched=!!fingerprint&&fingerprint===catalog?.generationFingerprint;
  return {
    provenance:envelope?.provenance??null,
    definitionStatus:matched?'matched-generation':'unavailable',
    note:'Database-backed language rules are compiled and evaluated in memory. These are recorded candidates, not evidence of a database query per message.',
    candidates:candidates.slice(0,40).map((candidate,index)=>{
      const intent=matched?catalog.intents.find(item=>item.code===candidate.intent):null;
      const rule=intent?(candidate.rule==='primary'?{code:'primary',conditions:intent.conditions,states:[]}:intent.alternativeRules?.find(item=>item.code===candidate.rule)):null;
      return {observed:candidate,selected:index===0&&envelope.result?.intent===candidate.intent,
        definition:rule?{intent:intent.code,...rule,description:intent.description,intentStates:intent.states,previousIntents:intent.previousIntents,requiresConfirmation:intent.requiresConfirmation,riskLevel:intent.riskLevel,provenance:intent.provenance}:null};
    }),
  };
}

export function customerJourney(report, catalog=rulebook) {
  const sources=new Map();
  for(const event of report.events??[]){const source=event.data?._journey?.function;if(source?.id)sources.set(source.id,source);}
  const recorded=(report.events??[]).map((event,index)=>{
    const data=event.data??{},meta=data._journey??{},evidence={...data};delete evidence._journey;
    const kind=['python_function','python_function_start'].includes(event.stage)?'python':event.stage==='language_rule_evidence'?'rules':event.stage==='customer_request'?'customer':event.stage==='final_result'?'response':event.stage.includes('model')||event.stage.includes('provider')?'model':'decision';
    const spanEvent=['python_function','python_function_start','provider_attempt','http_boundary','service_span'].includes(event.stage);
    return {id:spanEvent&&meta.spanId?`span:${meta.spanId}`:meta.eventId?`event:${meta.eventId}`:`step-${index}`,eventId:meta.eventId??null,eventIndex:index,callId:data.callId??null,spanId:meta.spanId??null,parentSpanId:meta.parentSpanId??null,parentService:meta.parentService??null,clockId:meta.clockId??null,clockDomain:meta.clockDomain??null,service:meta.service??null,stage:event.stage,kind,title:['python_function','python_function_start'].includes(event.stage)?String(data.function):event.stage.replaceAll('_',' '),
      atMs:meta.atMs??null,startMs:meta.startMs??meta.atMs??null,durationMs:meta.durationMs??null,
      sourceId:meta.sourceId??null,evidence,...(kind==='rules'?{rules:ruleEvidence(data,catalog)}:{})};
  });
  // Live start and durable completion share an explicit span identity. Prefer the
  // completed record even if a late start arrives; unrelated events stay separate.
  const spans=new Map();
  for(const step of recorded){const prior=spans.get(step.id);if(prior&&step.stage==='python_function_start'&&prior.stage==='python_function')continue;spans.set(step.id,step);}
  const steps=[...spans.values()];
  const refKey=ref=>ref&&['source_id','chunk_id','example_id'].every(key=>typeof ref[key]==='string'&&ref[key].length>0)&&Number.isSafeInteger(ref.revision)&&ref.revision>0?JSON.stringify([ref.source_id,ref.revision,ref.chunk_id,ref.example_id]):null;
  const inputs=steps.filter(step=>step.stage==='language_model_request'&&Array.isArray(step.evidence.included_example_refs));
  for(const step of steps){if(step.stage!=='intent_retrieval'||!Array.isArray(step.evidence.example_refs))continue;
    const refs=new Set(step.evidence.example_refs.map(refKey).filter(Boolean));
    const matched=inputs.filter(input=>input.eventIndex>step.eventIndex&&input.evidence.included_example_refs.some(ref=>ref&&refs.has(refKey(ref))));
    if(matched.length)step.modelInputEvidence={count:new Set(matched.flatMap(input=>input.evidence.included_example_refs.filter(ref=>ref&&refs.has(refKey(ref))).map(refKey))).size,steps:matched.map(input=>input.id)};
  }
  // Nested function spans are placed by start time; recorded decision events keep their observed order.
  if(steps.every(step=>step.startMs!==null&&step.clockDomain===steps[0]?.clockDomain))steps.sort((a,b)=>a.startMs-b.startMs);
  const journey={requestId:report.request_id,capture:{version:report.version??null,redacted:report.redacted??null},truncated:!!report.truncated,instrumented:steps.some(step=>step.atMs!==null),
    sources:Object.fromEntries(sources),steps};
  journey.diagnostics=traceDiagnostics(journey);
  return journey;
}
