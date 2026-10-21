import {describeStep} from './journey-presentation.js';
import {traceDiagnostics} from './trace-diagnostics.js';
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const span=s=>['python_function','python_function_start','provider_attempt','http_boundary','service_span'].includes(s.stage);
const group=s=>['http_boundary','service_span'].includes(s.stage)?(s.evidence?.operation==='assistant dispatch'?'Input':(s.service==='language-engine'||s.evidence?.peer_service==='language-engine')?'Interpretation':'Retrieval/tools'):s.kind==='python'?(s.title==='ShoppingCatalog.call'?'Retrieval/tools':'Decision'):({customer:'Input',language:'Interpretation',rules:'Interpretation',decision:'Decision',retrieval:'Retrieval/tools',model:'Model',response:'Outcome',python:'Retrieval/tools'})[describeStep(s).type]??'Decision';

// No clock alignment, inferred parents, exclusive time, or inferred retry links.
export function navigationModel(journey,threshold=1000){
 const steps=journey.steps,groups=[];
 for(const step of steps){const name=group(step);let entry=groups.find(g=>g.name===name);if(!entry){entry={name,steps:[]};groups.push(entry);}entry.steps.push(step);}
 const owners=new Map();for(const s of steps)if(span(s)&&s.spanId){const key=JSON.stringify([s.service,s.spanId]);owners.set(key,owners.has(key)?null:s);}
 const domain=steps.find(s=>s.service==='assistant-python'&&s.clockDomain==='python-perf-counter')?.clockDomain;
 const rows=steps.map(step=>{
  let relation=null,parent=null;
  if(step.parentSpanId){parent=owners.get(JSON.stringify([step.parentService??step.service,step.parentSpanId]));if(!parent)relation='Parent not captured';}
  const seen=new Set([step.id]);let depth=0,cursor=parent;
  while(cursor&&cursor.service===step.service){if(seen.has(cursor.id)){relation='Invalid parent cycle';depth=0;parent=null;break;}seen.add(cursor.id);depth++;cursor=cursor.parentSpanId?owners.get(JSON.stringify([cursor.parentService??cursor.service,cursor.parentSpanId])):null;}
  const timed=!!domain&&step.clockDomain===domain&&step.service==='assistant-python'&&valid(step.startMs)&&(step.durationMs==null||valid(step.durationMs))&&Number.isFinite(step.startMs+(step.durationMs??0));
  const remote=step.stage==='service_span'&&['language-engine','api-gateway'].includes(step.service)&&step.clockDomain==='remote-handler'&&typeof step.spanId==='string'&&step.spanId.length>0&&step.clockId===step.spanId&&valid(step.durationMs);
  const running=step.evidence?.outcome==='running';
  return {step,parentId:parent?.id??null,depth,relation,timed,remote,start:timed?step.startMs:null,duration:(timed||remote)&&valid(step.durationMs)?step.durationMs:null,running};
 });
 const timed=rows.filter(r=>r.timed).sort((a,b)=>a.start-b.start||a.step.eventIndex-b.step.eventIndex);
 const end=Math.max(1,...timed.map(r=>r.start+(r.duration??0)));
 const diagnostics=journey.diagnostics??traceDiagnostics(journey);
 const problems=diagnostics.findings.map(f=>({...f,evidence:f.evidence.filter(id=>steps.some(s=>s.id===id))}));
 if(steps.length&&journey.truncated)problems.push({id:'capture-limit',title:'Capture is incomplete',description:'Some stages or details were omitted by the capture limit.',evidence:[steps[0].id]});
 if(steps.length&&!steps.some(s=>s.stage==='final_result'))problems.push({id:'terminal-missing',title:'Terminal evidence not captured',description:'The recorded events do not establish a final outcome.',evidence:[steps.at(-1).id]});
 for(const row of rows){if(row.relation)problems.push({id:'parent-'+row.step.id,title:row.relation,description:'The recorded relationship is incomplete.',evidence:[row.step.id]});if(!row.timed&&!row.remote)problems.push({id:'time-'+row.step.id,title:'Compatible timing not recorded',description:row.step.stage==='service_span'&&row.step.service==='api-gateway'?'Dispatch evidence is available in the gateway lane without a timing bar.':'This event is available in the untimed section.',evidence:[row.step.id]});if(row.duration!==null&&row.duration>threshold)problems.push({id:'slow-'+row.step.id,title:`Span exceeds ${threshold} ms`,description:`${row.duration} ms inclusive duration; this is not a root-cause claim.`,evidence:[row.step.id]});}
 return {groups,rows,timed,remote:rows.filter(r=>r.remote||r.step.stage==='service_span'&&r.step.service==='api-gateway'),untimed:rows.filter(r=>!r.timed&&!r.remote&&!(r.step.stage==='service_span'&&r.step.service==='api-gateway')),end,problems};
}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function renderNavigation(root,journey,onSelect,{threshold=1000,onThreshold}={}){
 const model=navigationModel(journey,threshold),buttons=[],groups=new Map();
 const overview=el('section',undefined,'trace-overview'),waterfall=el('section',undefined,'trace-waterfall');overview.setAttribute('aria-label','Execution overview');waterfall.setAttribute('aria-label','Measured Python waterfall');
 const makeButton=(step,cls='trace-event')=>{const info=describeStep(step),b=el('button',undefined,cls);b.type='button';b.dataset.stepId=step.id;b.append(el('strong',info.title),el('span',info.stateLabel,'help'),el('small',span(step)&&step.spanId?'Span '+step.spanId:step.eventId?'Event '+step.eventId:'Event '+((step.eventIndex??journey.steps.indexOf(step))+1)));b.onclick=()=>onSelect(step.id);buttons.push(b);return b;};
 overview.append(el('p','Groups help navigate recorded events. They do not represent additional execution stages.','help'));
 for(const group of model.groups){const box=el('details');box.append(el('summary',`${group.name} · ${group.steps.length}`));for(const step of group.steps)box.append(makeButton(step));overview.append(box);for(const step of group.steps)groups.set(step.id,box);}
 waterfall.append(el('p','Python capture clock · milliseconds. Durations are inclusive. Other clocks are not aligned. Running spans have a start marker until a duration is captured.','help'));
 if(model.timed.length){const axis=el('div',undefined,'waterfall-axis');axis.append(el('span','0 ms'),el('span',`${model.end.toFixed(1)} ms`));waterfall.append(axis);}
 for(const row of model.timed){const {step}=row,b=makeButton(step,'trace-event waterfall-row');b.dataset.depth=String(row.depth);b.style.setProperty('--depth',Math.min(row.depth,6));b.append(el('span',`${step.service} · ${step.title}`,'help'));if(row.parentId){const parent=journey.steps.find(s=>s.id===row.parentId);b.append(el('span',`Parent: ${parent.title} (${parent.spanId})`,'help'));}if(row.relation)b.append(el('span',row.relation,'notice'));
  const track=el('span',undefined,'waterfall-track'),bar=el('span',undefined,row.duration>0?'waterfall-bar':'waterfall-marker');bar.style.left=`${row.start/model.end*100}%`;if(row.duration>0)bar.style.width=`${row.duration/model.end*100}%`;track.append(bar);b.append(track,el('span',`${row.start.toFixed(1)} ms · ${row.duration!==null?row.duration.toFixed(1)+' ms inclusive':row.running?'Running — duration not captured':span(step)?'Duration not captured':'Event marker'}`,'waterfall-time'));waterfall.append(b);}
 for(const service of [...new Set(model.remote.map(r=>r.step.service))]){const lane=el('section',undefined,'service-lane');lane.dataset.service=service;lane.append(el('h3',service),el('p','Linked service lane · each duration has its own local clock. No cross-service start alignment is available.','help'));for(const row of model.remote.filter(r=>r.step.service===service)){const b=makeButton(row.step);b.append(el('span',row.step.evidence?.operation??row.step.title,'help'),el('span',row.remote?`${row.duration.toFixed(3)} ms · remote handler duration`:'Dispatch recorded · duration and completion not captured','help'));if(row.parentId){const parent=journey.steps.find(s=>s.id===row.parentId);b.append(el('span',`Linked from ${parent.service} / ${parent.spanId}`,'help'));}if(row.relation)b.append(el('span',row.relation,'notice'));lane.append(b);}waterfall.append(lane);}
 if(model.remote.length)waterfall.append(el('p','Provider server internals, gateway stream completion, other tools, and cross-service critical path are not captured.','help'));
 if(model.untimed.length){waterfall.append(el('h3','Untimed / incompatible clock'),el('p','No bar is drawn for these events. Their original recorded order is preserved.','help'));for(const row of [...model.untimed].sort((a,b)=>(a.step.eventIndex??0)-(b.step.eventIndex??0))){const button=makeButton(row.step);if(row.relation)button.append(el('span',row.relation,'notice'));waterfall.append(button);}}
 if(!journey.steps.length)overview.append(el('p','No events were captured.'));
 const problems=el('details',undefined,'trace-problems');problems.append(el('summary',`Problem navigation · ${model.problems.length}`));const label=el('label','Duration threshold (ms) '),input=el('input');input.type='number';input.min='0';input.step='100';input.value=String(threshold);label.append(input);problems.append(label);input.onchange=()=>{const value=Number(input.value);if(input.value&&valid(value))onThreshold?.(value);};
 for(const problem of model.problems){const box=el('div',undefined,'trace-problem');box.append(el('strong',problem.title),el('p',problem.description,'help'));for(const id of problem.evidence){const s=journey.steps.find(s=>s.id===id);if(s)box.append(makeButton(s));}problems.append(box);}
 root.append(problems,overview,waterfall);
 // Arrow navigation stays inside its visible surface; native Enter/Space activate.
 for(const surface of [overview,waterfall,problems])surface.onkeydown=event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target.tagName!=='BUTTON')return;const items=[...surface.querySelectorAll('button')].filter(b=>b.getClientRects().length);const i=items.indexOf(event.target);if(i<0)return;event.preventDefault();const next=items[event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,i+(event.key==='ArrowDown'?1:-1)))];if(next){onSelect(next.dataset.stepId,false);next.focus();}};
 return {overview,waterfall,select(id){for(const b of buttons){b.classList.toggle('selected',b.dataset.stepId===id);b.setAttribute('aria-pressed',String(b.dataset.stepId===id));}const box=groups.get(id);if(box)box.open=true;}};
}
