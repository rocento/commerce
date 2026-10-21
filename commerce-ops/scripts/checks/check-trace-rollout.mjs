// Read-only canary check for an authorized, redacted JSON export. Never contacts a service.
import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function checkTraceRollout(report){
 const errors=[];
 if(report?.version!==2||report?.redacted!==true||!uuid(report?.request_id))errors.push('Expected a redacted v2 request export.');
 const events=Array.isArray(report?.events)?report.events:[];
 if(!events.length||events.length>96)errors.push('Event count is outside the capture contract.');
 if(events.some(e=>!e||typeof e.stage!=='string'||!e.data||typeof e.data!=='object'||Array.isArray(e.data)))return {ok:false,eventCount:events.length,remoteHandlerCount:0,errors:[...errors,'Malformed capture event.']};
 if(report?.truncated)errors.push('Canary capture is truncated; use a complete representative request.');
 const terminal=events.findLast(e=>e?.stage==='final_result');
 if(!terminal||terminal.data?.terminal_details_truncated||terminal.data?.outcome!=='completed')errors.push('A complete successful terminal lifecycle is required.');
 const remotes=events.filter(e=>e?.stage==='service_span');
 const gateway=remotes.find(e=>e.data?._journey?.service==='api-gateway'&&e.data?.operation==='assistant dispatch');
 if(!gateway||!uuid(gateway.data?._journey?.spanId))errors.push('Gateway dispatch identity is missing.');
 const handlers=remotes.filter(e=>e.data?._journey?.clockDomain==='remote-handler');
 for(const service of ['language-engine','api-gateway'])if(!handlers.some(e=>e.data?._journey?.service===service))errors.push(`Missing ${service} handler evidence in this canary.`);
 for(const remote of remotes){const m=remote.data?._journey??{};
  if(m.traceId!==report.request_id)errors.push('Remote trace identity does not match the request.');
  if(m.clockDomain==='remote-handler'){
   if(!uuid(m.spanId)||m.clockId!==m.spanId||m.startMs!==0||typeof m.durationMs!=='number'||!Number.isFinite(m.durationMs)||m.durationMs<0||m.durationMs>300000)errors.push('Remote clock evidence is invalid.');
   const parents=events.filter(e=>e.stage==='http_boundary'&&e.data?._journey?.spanId===m.parentSpanId&&e.data?._journey?.service===m.parentService);
   if(parents.length!==1||m.parentService!=='assistant-python'||parents[0]?.data?.peer_service!==m.service)errors.push('Remote handler is not linked to exactly one matching Python transport call.');
  }
 }
 if(gateway&&!events.some(e=>e.data?._journey?.service==='assistant-python'&&e.data?._journey?.parentService==='api-gateway'&&e.data?._journey?.parentSpanId===gateway.data._journey.spanId))errors.push('Python has no captured link to gateway dispatch.');
 return {ok:errors.length===0,eventCount:events.length,remoteHandlerCount:handlers.length,errors};
}
export async function main(){
 try{const file=process.argv[2];if(!file)throw new Error('Usage: node commerce-ops/scripts/checks/check-trace-rollout.mjs <redacted-export.json>');if((await stat(file)).size>1400000)throw new Error('Export exceeds the stored-report limit.');const result=checkTraceRollout(JSON.parse(await readFile(file,'utf8')));console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;}catch(error){console.error(error instanceof SyntaxError?'Invalid JSON export.':error.message);process.exitCode=1;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
