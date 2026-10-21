import {describeStep, describeExecutionRoute} from './journey-presentation.js';
import {navigationModel} from './trace-navigation.js';
import {stepFacts,traceDiagnostics} from './trace-diagnostics.js';
const node=(tag,text,style)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(style)value.className=style;return value;};
const json=value=>JSON.stringify(value,null,2);
const resultTone=info=>['error','failed','denied'].includes(info.status)?'error':['unavailable','disconnected','completion not captured','unconfigured'].includes(info.status)?'warning':info.type==='response'&&info.status==='completed'?'success':'neutral';
const ms=value=>typeof value==='number'?value.toFixed(1)+' ms':'Not captured';
function revealSelected(timeline){const chosen=timeline.querySelector('.selected'),viewport=timeline.closest('.timeline-viewport');if(!chosen||!viewport)return;const area=viewport.getBoundingClientRect(),rect=chosen.getBoundingClientRect();if(rect.left<area.left+4||rect.right>area.right-4)viewport.scrollLeft+=rect.left-area.left-8;}
function resizeTimelines(){document.querySelectorAll('.journey-timeline').forEach(timeline=>timeline.refreshViewport?.());}
window.addEventListener('resize',()=>requestAnimationFrame(resizeTimelines));
document.fonts?.addEventListener('loadingdone',resizeTimelines);
let playback;
export function clearJourney(){clearInterval(playback);playback=null;}
export function renderJourney(root,journey,options={}){
 const retained=root.journeyState?.requestId===journey.requestId?root.journeyState:{};
 options={...retained,...options};clearJourney();root.replaceChildren();
 root.journeyState={...options,requestId:journey.requestId};
 const customer=journey.steps.find(step=>step.kind==='customer');
 const header=node('div',undefined,'journey-summary');
 header.append(node('span','CUSTOMER MESSAGE','tiny-label'),node('h2',customer?.evidence?.message??'Message not captured'),...(options.sections?[]:[node('code',journey.requestId)]));
 root.append(header);
 renderDiagnosticSummary(root,journey,id=>{const index=journey.steps.findIndex(step=>step.id===id);if(index<0)return;stop();select(index);detail.tabIndex=-1;detail.focus({preventScroll:true});detail.scrollIntoView({block:'nearest',behavior:'instant'});});
 const note=node('p',options.live?'Live capture: new steps appear as they arrive. Running functions update when they return.':journey.instrumented?'Measured spans may overlap; durations include nested work. Each card shows its recorded timing when available.':'This older trace contains decision evidence. Function source and timing were not captured.','help');root.append(note);
 const captureNotice=journey.truncated?node('p','Capture limit reached. Some steps may be missing from this timeline.','notice'):null;if(captureNotice)root.append(captureNotice);
 const path=node('section',undefined,'journey-path');
 path.append(node('h3','Execution cards'),node('p','Read left to right across each of the three rows. Scroll horizontally to see more steps, or select a card for full-width details below.','timeline-guide'));
 const legend=node('div',undefined,'timeline-legend');legend.setAttribute('role','list');legend.setAttribute('aria-label','Step color meanings');
 const meanings=[['service','Services','Connected boundaries'],['customer','Message','Shopper input'],['python','Processing','Internal function'],['language','Language','Message interpretation'],['retrieval','Retrieval','Example lookup'],['rules','Rules','Match message meaning'],['decision','Decisions','Choose what happens next'],['model','AI model','Model input or response'],['response','Outcome','Final request result']];
 const present=new Set(journey.steps.map(step=>describeStep(step).type));
 for(const [kind,label,meaning] of meanings){if(!present.has(kind))continue;const item=node('span',undefined,'timeline-legend-item');item.dataset.kind=kind;item.setAttribute('role','listitem');item.append(node('span',label,'timeline-legend-label'),node('span',meaning));legend.append(item);}
 const legendDetails=node('details',undefined,'timeline-legend-details');legendDetails.append(node('summary','Step color guide'));legendDetails.append(node('p','Card colors identify the kind of step. The status label shows its result. An outline marks the selected step.','timeline-color-guide'),legend);path.append(legendDetails);
 const controls=node('div',undefined,'journey-controls'),previous=node('button','← Previous','quiet'),play=node('button','Play timeline','primary'),next=node('button','Next →','quiet'),position=node('span','','timeline-position');play.hidden=!!options.live;position.setAttribute('role','status');controls.append(previous,play,next,position);path.append(controls);
 const zoomControls=node('div',undefined,'timeline-zoom'),zoomOut=node('button','−','quiet'),zoomIn=node('button','+','quiet'),fit=node('button','Fit to screen','quiet'),actual=node('button','100%','quiet'),zoomLabel=node('output','','zoom-label');zoomOut.setAttribute('aria-label','Zoom out');zoomIn.setAttribute('aria-label','Zoom in');zoomLabel.setAttribute('aria-label','Timeline zoom');zoomLabel.setAttribute('aria-live','polite');zoomControls.setAttribute('role','group');zoomControls.setAttribute('aria-label','Timeline zoom controls');actual.setAttribute('aria-label','Actual size');actual.title='Show cards at full size';zoomControls.append(zoomOut,zoomLabel,zoomIn,actual,fit);path.append(zoomControls);
 const viewport=node('div',undefined,'timeline-viewport'),canvas=node('div',undefined,'timeline-canvas'),timeline=node('ol',undefined,'journey-timeline');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','Zoomable request timeline');timeline.setAttribute('aria-label','Request execution timeline');canvas.append(timeline);viewport.append(canvas);path.append(viewport);root.append(path);
 const detail=node('section',undefined,'journey-detail');detail.setAttribute('aria-label','Selected step details');root.append(detail);
 const workspace=node('div',undefined,'trace-workspace'),navigation=node('section',undefined,'trace-navigation');
 const choose=(id,focus=true)=>{const index=journey.steps.findIndex(s=>s.id===id);if(index<0)return;stop();select(index);if(focus){detail.tabIndex=-1;detail.focus({preventScroll:true});detail.scrollIntoView({block:'nearest',behavior:'instant'});}};
 root.journeyState.navigationView='cards';options.onNavigationView?.('cards');
 navigation.append(controls,path);workspace.append(navigation,detail);root.append(workspace);
 let selected=0;
 const rowCount=Math.min(3,journey.steps.length),columns=Math.max(1,Math.ceil(journey.steps.length/3));
 timeline.style.gridTemplateColumns=`repeat(${columns}, 248px)`;
 const rowLengths=Array.from({length:rowCount},(_,row)=>Math.floor(journey.steps.length/rowCount)+(row<journey.steps.length%rowCount?1:0));
 let row=0,column=0;
 const buttons=journey.steps.map((step,index)=>{
  const info=describeStep(step),item=node('li',undefined,'journey-step'),button=node('button',undefined,'journey-node '+step.kind);button.type='button';button.dataset.kind=info.type;button.dataset.important=String(info.important);button.dataset.status=info.status??'';
  item.style.gridRow=String(row+1);item.style.gridColumn=String(column+1);
  if(column===rowLengths[row]-1){if(index<journey.steps.length-1)item.classList.add('row-end');row++;column=0;}else column++;
  const top=node('span',undefined,'step-card-top');top.append(node('span',info.badgeLabel,'step-icon'),node('span',`STEP ${String(index+1).padStart(2,'0')}`,'step-number'));button.append(top,node('small',info.category??info.type),node('strong',info.title));
  const facts=node('span',undefined,'step-card-facts');const status=node('span',info.stateLabel,'step-state');status.dataset.result=resultTone(info);facts.append(status,node('span',typeof step.durationMs==='number'?`Took ${ms(step.durationMs)}`:typeof step.atMs==='number'?`${ms(step.atMs)} after start`:'Time not captured','step-time'));button.append(facts);
  button.onclick=()=>choose(step.id);
  button.onkeydown=event=>{let target=index;if(event.key==='ArrowRight')target=Math.min(index+1,journey.steps.length-1);else if(event.key==='ArrowLeft')target=Math.max(0,index-1);else if(event.key==='Home')target=0;else if(event.key==='End')target=journey.steps.length-1;else return;event.preventDefault();stop();select(target);buttons[target].focus({preventScroll:true});};
  item.append(button);timeline.append(item);return button;
 });
 // Scale a clipped canvas so the unscaled track cannot create phantom scroll space.
 let manualZoom=typeof options.zoom==='number'&&Number.isFinite(options.zoom)&&options.zoom>0?options.zoom:options.zoom===null?null:1,currentScale=1,fitScale=1;
 function layoutTimeline(){
  const width=Math.max(1,timeline.offsetWidth),height=timeline.offsetHeight,available=Math.max(1,viewport.clientWidth-2);
  fitScale=Math.min(1,available/width);currentScale=manualZoom===null?fitScale:Math.max(Math.min(.1,fitScale/2),Math.min(2.5,manualZoom));
  timeline.style.transform=`scale(${currentScale})`;canvas.style.width=`${width*currentScale}px`;canvas.style.height=`${height*currentScale}px`;viewport.style.height=`${Math.max(90,height*currentScale+16)}px`;
  zoomLabel.textContent=`${manualZoom===null?'Fit · ':''}${Math.round(currentScale*1000)/10}%`;fit.setAttribute('aria-pressed',String(manualZoom===null));zoomIn.disabled=currentScale>=2.5;zoomOut.disabled=currentScale<=Math.min(.1,fitScale/2)+.00001;
  if(manualZoom===null)viewport.scrollLeft=0;else revealSelected(timeline);
 }
 function changeZoom(value){manualZoom=value;options.onZoom?.(value);layoutTimeline();}
 zoomIn.onclick=()=>changeZoom(Math.min(2.5,currentScale*1.25));zoomOut.onclick=()=>changeZoom(Math.max(Math.min(.1,fitScale/2),currentScale/1.25));fit.onclick=()=>changeZoom(null);actual.onclick=()=>changeZoom(1);
 timeline.refreshViewport=layoutTimeline;layoutTimeline();
 function stop(){clearJourney();play.textContent='Play timeline';}
 function select(index,reveal=true){
  if(options.sections&&reveal)inspectorOpen=true;
  selected=index;const step=journey.steps[index];if(!step)return;
  root.journeyState.selectedId=step.id;if(reveal||!options.sections)options.onSelect?.(step.id);
  buttons.forEach((button,i)=>{button.classList.toggle('selected',i===index);button.setAttribute('aria-pressed',String(i===index));button.tabIndex=i===index?0:-1;});
  if(manualZoom!==null)revealSelected(timeline);
  previous.disabled=index===0;next.disabled=index===journey.steps.length-1;position.textContent=`Step ${index+1} of ${journey.steps.length}`;
  const info=describeStep(step);detail.dataset.kind=info.type;detail.replaceChildren(node('span',`STEP ${index+1} OF ${journey.steps.length} · ${(info.category??info.type).toUpperCase()}`,'tiny-label'),node('h2',info.title),node('p',info.description,'step-explanation'));
  const status=node('p',info.stateLabel,'step-readable-state');status.dataset.result=resultTone(info);detail.append(status);if(info.resultExplanation)detail.append(node('p',info.resultExplanation,'help'));if(info.type==='python')detail.append(node('p','Function: '+step.title,'source-location'));
  renderStepSummary(detail,step);
  const tabs=node('div',undefined,'result-tabs'),content=node('div',undefined,'journey-content');
  const views=[['Evidence',()=>{content.append(node('p',step.stage==='service_span'?(step.durationMs!==null?`Remote handler duration: ${ms(step.durationMs)}. Its start is not aligned to the Python clock.`:'Remote dispatch recorded; timing and completion were not captured.'):step.evidence?.outcome==='running'?'Function is running; no return duration has been captured.':step.durationMs!==null?`Started at ${ms(step.startMs)}; ${step.evidence?.outcome==='error'?'failed':'finished'} after ${ms(step.durationMs)}.`:`Recorded at ${ms(step.atMs)} from Python capture start.`,'help'),node('pre',json(step.evidence)));}]];
  const identity=node('p', [step.service,step.spanId&&'Span '+step.spanId,step.parentSpanId&&'Parent '+step.parentSpanId].filter(Boolean).join(' · '),'help');detail.append(identity);
  if(step.parentSpanId){const parent=journey.steps.find(s=>s.service===(step.parentService??step.service)&&s.spanId===step.parentSpanId&&['python_function','python_function_start','provider_attempt','http_boundary','service_span'].includes(s.stage));if(parent&&parent.id!==step.id){const link=node('button','Inspect parent span','quiet');link.onclick=()=>choose(parent.id);detail.append(link);}}
  const source=journey.sources[step.sourceId];
  if(source)views.push(['View function',()=>{content.append(node('h3',source.name),node('p',`${source.file}:${source.line}`,'source-location'),node('p',source.truncated?'Source excerpt captured from the running Python service; the function exceeded the source display limit.':'Function source captured from the running Python service for this request.','help'));const pre=node('pre',undefined,'source-code');pre.append(node('code',source.source));content.append(pre,node('p','SHA-256 · '+source.sha256,'source-hash'));}]);
  if(step.rules)views.push(['View rules',()=>renderRules(content,step.rules)]);
  const activeView=views.some(([label])=>label===options.view)?options.view:'Evidence';
  views.forEach(([label,show],i)=>{const button=node('button',label);button.onclick=event=>{if(event.isTrusted){root.journeyState.view=label;options.onView?.(label,step.id);}for(const child of tabs.children)child.classList.toggle('selected',child===button);content.replaceChildren();show();};tabs.append(button);if(label===activeView)button.click();});
  if(options.sections){const close=node('button','Close inspector','quiet inspector-close');close.onclick=()=>{inspectorOpen=false;applySection();root.closest('#trace-report')?.querySelector('[data-section][aria-current]')?.focus();};detail.prepend(close);}
  detail.append(tabs,content);detail.scrollTop=0;if(options.sections)applySection();
  if(!source&&info.type==='python')detail.append(node('p','Python function source was not captured at this boundary.','help'));
 }
 previous.onclick=()=>{stop();const index=Math.max(0,selected-1);select(index);};next.onclick=()=>{stop();const index=Math.min(journey.steps.length-1,selected+1);select(index);};
 play.onclick=()=>{if(playback){stop();return;}select(0);play.textContent='Pause';playback=setInterval(()=>{if(selected>=journey.steps.length-1){stop();return;}select(selected+1);},1500);};
 let section=['overview','timeline','ai','catalog','issues','raw'].includes(options.section)?options.section:'timeline',inspectorOpen=!!options.selectedId;
 const sectionBody=node('section',undefined,'trace-category');sectionBody.setAttribute('aria-label','Section evidence');navigation.after(sectionBody);
 function applySection(){
  if(!options.sections)return;
  header.hidden=!['overview','timeline'].includes(section);if(captureNotice)captureNotice.hidden=section!=='timeline';
  root.querySelector('.trace-diagnostics').hidden=section!=='overview';note.hidden=section!=='timeline';
  navigation.hidden=section!=='timeline';sectionBody.hidden=!['ai','catalog','issues'].includes(section);
  for(const b of sectionBody.querySelectorAll('[data-step-id]')){b.classList.toggle('selected',b.dataset.stepId===journey.steps[selected]?.id);b.setAttribute('aria-pressed',String(b.dataset.stepId===journey.steps[selected]?.id));}
  detail.hidden=!inspectorOpen;workspace.hidden=section==='overview'&&!inspectorOpen;
  workspace.classList.toggle('has-inspector',inspectorOpen);requestAnimationFrame(resizeTimelines);workspace.classList.toggle('overview-inspector',section==='overview');
 }
 function showSection(value){
  stop();section=value;inspectorOpen=false;sectionBody.replaceChildren();
  const labels={ai:'AI & reasoning',catalog:'Catalog & evidence',issues:'Issues'};
  if(labels[section])sectionBody.append(node('h2',labels[section]));
  const addStep=step=>{const info=describeStep(step),b=node('button',undefined,'trace-event');b.dataset.stepId=step.id;b.append(node('strong',info.title),node('span',info.stateLabel,'help'));b.onclick=()=>choose(step.id);sectionBody.append(b);};
  if(section==='issues'){
   const label=node('label','Duration threshold (ms) ','issue-threshold'),input=node('input');input.type='number';input.min='0';input.step='100';input.value=String(root.journeyState.threshold??1000);label.append(input);sectionBody.append(label);input.onchange=()=>{const value=Number(input.value);if(input.value&&Number.isFinite(value)&&value>=0){root.journeyState.threshold=value;showSection('issues');sectionBody.querySelector('input')?.focus();}};
   const problems=navigationModel(journey,root.journeyState.threshold??1000).problems;
   if(!problems.length)sectionBody.append(node('p','No issues identified in the captured evidence. This does not establish that every step was captured.','help'));
   for(const issue of problems){const card=node('article',undefined,'trace-problem');card.append(node('h3',issue.title),node('p',issue.description,'help'));for(const id of issue.evidence){const step=journey.steps.find(s=>s.id===id);if(step){const b=node('button','Inspect evidence','quiet');b.onclick=()=>choose(id);card.append(b);}}sectionBody.append(card);}
  }else if(section==='ai'||section==='catalog'){
   const steps=journey.steps.filter(step=>{const type=describeStep(step).type;return section==='ai'?['model','language','rules','decision'].includes(type):type==='retrieval'||step.title==='ShoppingCatalog.call'||step.stage==='catalog_filter'||step.evidence?.peer_service==='api-gateway'&&step.stage==='http_boundary';});
   sectionBody.append(node('p',section==='ai'?'Recorded interpretation, routing and model evidence. Deterministic steps do not imply a model call.':'Recorded retrieval, catalog calls and filtering evidence.','help'));
   if(!steps.length)sectionBody.append(node('p','No evidence captured for this section. Capture may have been disabled, unavailable or truncated.','trace-section-empty'));
   steps.forEach(addStep);
  }
  applySection();requestAnimationFrame(resizeTimelines);
 }
 if(options.sections){root.showSection=showSection;showSection(section);inspectorOpen=!!options.selectedId;}
 if(!journey.steps.length)path.append(node('p','No execution steps were captured for this request. Refresh to check for new evidence.','trace-section-empty'));
 if(journey.steps.length)select(options.follow?journey.steps.length-1:Math.max(0,journey.steps.findIndex(step=>step.id===options.selectedId)),false);else{play.disabled=true;previous.disabled=true;next.disabled=true;detail.append(node('p','No stages were captured.'));}
 if(options.sections)applySection();
}
export function renderRules(root,rules){
 root.append(node('p',rules.note,'help'));
 if(rules.definitionStatus!=='matched-generation')root.append(node('p','The matching rule artifact is unavailable. Observed scores remain visible; definitions are not substituted from another release.','notice'));
 if(rules.provenance)root.append(node('p','Release · '+rules.provenance.releaseId,'source-location'));
 if(!rules.candidates.length)root.append(node('p','No scored intent-rule candidates were captured for this resolution. Other semantic paths may have handled this message.','help'));
 for(const item of rules.candidates){const box=node('details',undefined,'rule-detail');box.open=item.selected;box.append(node('summary',`${item.observed.intent} / ${item.observed.rule??'unspecified'} · score ${item.observed.score}${item.selected?' · selected candidate':''}`),node('h3','Observed evaluation'),node('pre',json(item.observed)),node('h3','Rule definition'),node('pre',item.definition?json(item.definition):'Definition unavailable for this generation.'));root.append(box);}
}

function renderStepSummary(root,step){
 const evidence=step.evidence??{},box=node('div',undefined,'step-summary');
 const fact=(label,value)=>{if(value===null||value===undefined||value==='')return;const row=node('div');row.append(node('span',label),node('strong',typeof value==='object'?JSON.stringify(value):String(value)));box.append(row);};
 if(step.title==='ShoppingCatalog.call'){
  const details=evidence.details;
  if(!details?.operation)box.append(node('p','This older capture does not include the catalog operation or search criteria. New requests show those details.','help'));
  else{
   fact('Catalog operation',details.operation);
   const criteria=details.criteria??{};
   fact('Search query',criteria.query);fact('Category',criteria.category_id);fact('Currency',criteria.currency);
   fact(criteria.exclusive_min?'Price greater than':'Minimum price',criteria.min_price);
   fact(criteria.exclusive_max?'Price below':'Maximum price',criteria.max_price);
   if(criteria.in_stock)fact('Stock filter','In stock only');
   if(criteria.attributes?.length)fact('Attributes',criteria.attributes);
   if(criteria.predicates?.length)fact('Other filters',criteria.predicates);
   if(details.operation==='get_catalog_schema')fact('Catalog structure returned',details.schema_returned);
   else fact('Products returned by this call',details.products_returned);
  }
 }
 if(step.stage==='catalog_filter'){fact('Where it runs','Inside the assistant — no catalog request');fact('Products before checks',evidence.products_before);fact('Products kept',evidence.products_after);fact('Checks applied',Array.isArray(evidence.checks)?evidence.checks.join(', '):null);}
 if(step.stage==='intent_retrieval'){
  fact('Retrieval status',evidence.status);fact('Search query',evidence.query);fact('Examples returned',Array.isArray(evidence.examples)?evidence.examples.length:null);
  if(evidence.status==='unconfigured')box.append(node('p','No retriever was configured for this request.','help'));
  if(evidence.status==='unavailable')box.append(node('p','Retrieval was unavailable. This capture does not establish a specific failure cause.','help'));
  for(const [i,example] of (Array.isArray(evidence.examples)?evidence.examples:[]).entries()){const details=node('details',undefined,'retrieved-example');details.append(node('summary',`Retrieved example ${i+1}`),node('pre',json(example)));box.append(details);}
 }
 if(step.stage==='execution_route'){
  const route=describeExecutionRoute(evidence);fact('Selected path',route.title);fact('Why this path',route.reason);fact('Task type',evidence.journey);
  box.append(node('h3','Available execution paths'),node('p','These explanations follow the routing policy and recorded reason. Unselected paths were not executed; this is not a record of trying each option.','help'));
  for(const option of route.options){const card=node('article',undefined,'route-option');card.dataset.selected=String(option.selected);card.append(node('h4',option.title),node('span',option.selected?'Selected':'Not selected','route-option-state'),node('p',option.purpose),node('p',option.explanation));box.append(card);}
 }
 if(step.stage==='handler_dispatch'){fact('Task handler',evidence.handler);fact('Shopping task',evidence.journey);fact('Interpreted intent',evidence.intent);}
 if(step.stage==='final_result'){fact('Outcome',evidence.outcome);fact('Routing reason',evidence.route_reason);if(typeof evidence.answer==='string'&&evidence.answer){box.append(node('span','Assistant response','tiny-label'),node('p',evidence.answer,'recorded-answer'));}}
 if(step.stage==='model_proposal'){fact('Proposed intent',evidence.intent);fact('Confidence',evidence.confidence);}
 if(step.stage==='language_rule_evidence'){fact('Selected intent',evidence.result?.intent);fact('Resolution status',evidence.result?.status);fact('Confidence',evidence.result?.confidence);fact('Candidates recorded',step.rules?.candidates?.length);}
 for(const item of stepFacts(step)){
  fact(item.label,item.state==='not_recorded'?'Not recorded':item.value);
  if(item.note)box.append(node('p',item.note,'help'));
 }
 if(box.childNodes.length)root.append(box);
}

function renderDiagnosticSummary(root,journey,onEvidence){
 const summary=journey.diagnostics??traceDiagnostics(journey),section=node('section',undefined,'trace-diagnostics');
 section.setAttribute('aria-label','Trace diagnostic summary');section.append(node('h3','Trace diagnostic summary'));
 const readable=value=>String(value).replaceAll('_',' ');
 const link=(label,refs)=>{const button=node('button',label,'quiet evidence-link');button.type='button';button.onclick=()=>onEvidence(refs[0]);return button;};
 const grid=node('div',undefined,'diagnostic-grid');
 for(const [label,value,note,refs] of [
  ['Interpreted customer goal',summary.goal.value??'Not recorded',summary.goal.value?summary.goal.note:'No interpreted intent was captured.',summary.goal.evidence],
  ['Execution',readable(summary.execution.value),'Execution status is separate from task fulfillment.',summary.execution.evidence],
  ['Business outcome',readable(summary.businessOutcome.value),summary.businessOutcome.note,summary.businessOutcome.evidence],
 ]){const box=node('article');box.append(node('span',label,'tiny-label'),node('strong',value),node('p',note,'help'));if(refs.length)box.append(link('Inspect '+label.toLowerCase(),refs));grid.append(box);}
 section.append(grid);
 if(summary.capture.truncated)section.append(node('p','Capture was truncated. Findings describe only recorded evidence; missing steps may change the interpretation.','notice'));
 const main=summary.findings[0];
 const findingView=(finding,isMain=false)=>{const box=node('article',undefined,'diagnostic-finding');box.append(node('span',isMain?'MAIN FINDING':'OBSERVATION','tiny-label'),node('h4',finding.title),node('p',finding.description));for(const id of finding.evidence)box.append(link('Inspect supporting step',[id]));return box;};
 if(main)section.append(findingView(main,true));else section.append(node('p','No diagnostic finding can be established from the recorded evidence.','help'));
 if(summary.findings.length>1){const more=node('details');more.append(node('summary',`${summary.findings.length-1} more observations`));for(const finding of summary.findings.slice(1))more.append(findingView(finding));section.append(more);}
 const details=node('details',undefined,'diagnostic-measurements');details.append(node('summary','Measurements and capture completeness'));
 const metrics=node('dl',undefined,'diagnostic-metrics');
 for(const [key,label] of Object.entries({requestDuration:'Request duration',firstText:'Time to first text',modelCalls:'Total model calls',inputTokens:'Captured response input tokens',outputTokens:'Captured response output tokens',estimatedCost:'Estimated cost'})){
  const item=summary.metrics[key],value=node('dd');value.append(node('strong',item.value===null?'Not recorded':String(item.value)+(item.unit?' '+item.unit:'')),node('p',item.note,'help'));if(item.evidence.length)value.append(link('Inspect measurement evidence',item.evidence));const measuredLabel=item.value!==null?({requestDuration:'Python turn duration',firstText:'Server first text event',modelCalls:'Provider dispatch attempts'})[key]??label:label;metrics.append(node('dt',measuredLabel),value);
 }
 for(const [label,value] of [['Capture version',summary.capture.version??'Not recorded'],['Redaction',summary.capture.redacted===null?'Not recorded':summary.capture.redacted?'Applied':'Not applied'],['Capture limit',summary.capture.truncated?'Reached — partial report':'No truncation reported'],['Event timing',readable(summary.capture.timing)],['Model input',readable(summary.capture.modelInput)],['Terminal event',readable(summary.capture.terminal)]])metrics.append(node('dt',label),node('dd',value));
 details.append(metrics);section.append(details);root.append(section);
}
