import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationModel} from '../public/trace-navigation.js';
import {customerJourney} from '../journey.mjs';
const event=(id,start,duration,parent=null,extra={})=>({stage:'python_function',data:{function:'Repeated.call',outcome:'returned',_journey:{eventId:'e'+id,spanId:id,parentSpanId:parent,service:'assistant-python',clockDomain:'python-perf-counter',startMs:start,atMs:start,durationMs:duration},...extra}});
const report=events=>customerJourney({request_id:'test',version:2,events});
test('nested concurrent spans have shared offsets, distinct IDs, and only explicit parents',()=>{
 const j=report([event('root',0,100),event('a',10,70,'root'),event('b',20,60,'root'),event('c',25,10,'b')]);
 const m=navigationModel(j,50);assert.equal(m.end,100);assert.deepEqual(m.timed.map(r=>[r.step.id,r.start,r.duration,r.depth]),[['span:root',0,100,0],['span:a',10,70,1],['span:b',20,60,1],['span:c',25,10,2]]);assert.equal(m.problems.filter(p=>p.id.startsWith('slow')).length,3);
 assert.equal(m.groups.flatMap(g=>g.steps).length,4);assert.equal(m.rows[2].parentId,'span:root');
});
test('truncation, cycles, mixed clocks and invalid timing never fabricate aligned bars',()=>{
 const a=event('a',0,10,'missing'),b=event('b',1,4,'c'),c=event('c',2,3,'b'),other=event('d',0,100);other.data._journey.clockDomain='other-clock';
 const m=navigationModel(report([a,b,c,other,event('bad',-1,4),event('overflow',Number.MAX_VALUE,Number.MAX_VALUE)]));
 assert.equal(m.rows[0].relation,'Parent not captured');assert.equal(m.rows[1].relation,'Invalid parent cycle');assert.equal(m.rows[1].depth,0);assert.equal(m.untimed.length,3);assert.equal(m.end,10);
});
test('legacy timing stays navigable without assuming a clock domain',()=>{
 const j=report([{stage:'customer_request',data:{message:'hello'}},{stage:'python_function',data:{function:'Old.call',_journey:{startMs:0,durationMs:5}}}]);const m=navigationModel(j);assert.equal(m.timed.length,0);assert.equal(m.untimed.length,2);assert.equal(m.groups.flatMap(g=>g.steps).length,2);
});
test('live completion coalesces by span and preserves selection identity and repeated calls',()=>{
 const start=event('a',1,null,null,{outcome:'running'});start.stage='python_function_start';const running=report([start]);assert.equal(navigationModel(running).rows[0].running,true);assert.equal(navigationModel(running).rows[0].duration,null);
 const done=report([start,event('a',1,9),event('b',2,3),start]);assert.equal(done.steps.length,2);assert.equal(done.steps[0].id,running.steps[0].id);assert.equal(navigationModel(done).rows[0].duration,9);
});
test('instantaneous events are markers; non-span metadata cannot impersonate a parent',()=>{
 const marker={stage:'provider_wire_payload',data:{_journey:{eventId:'wire',spanId:'a',parentSpanId:null,startMs:5,service:'assistant-python',clockDomain:'python-perf-counter'}}};const m=navigationModel(report([marker,event('child',6,2,'a')]));assert.equal(m.rows[0].duration,null);assert.equal(m.rows[1].relation,'Parent not captured');
});
test('problem navigation links explicit failure, empty results, fallback and missing evidence',()=>{
 const j=report([event('failure',0,4,null,{outcome:'error'}),{stage:'catalog_filter',data:{products_before:12,products_after:0}},{stage:'final_result',data:{outcome:'completed',language_fallback:{outcome:'recovered'}}}]);j.truncated=true;const m=navigationModel(j);for(const prefix of ['failure:','filter:','fallback','time-','capture-limit'])assert.ok(m.problems.some(p=>p.id.startsWith(prefix)));assert.ok(m.problems.every(p=>p.evidence.every(id=>j.steps.some(s=>s.id===id))));
});
test('cross-service clocks and duplicate span owners do not infer alignment or hierarchy',()=>{
 const a=event('a',0,10),other=event('other',1,10,'a');other.data._journey.service='gateway';const j=report([a,other,event('b',2,3,'a')]);j.steps.push({...j.steps[0],id:'duplicate'});const m=navigationModel(j);assert.equal(m.rows.find(r=>r.step.id==='span:other').timed,false);assert.equal(m.rows.find(r=>r.step.id==='span:b').relation,'Parent not captured');
});
test('M4 links remote services without putting their local clocks on the Python axis',()=>{
 const remote={stage:'service_span',data:{operation:'resolve',outcome:'completed',_journey:{eventId:'remote-event',spanId:'remote-1',parentSpanId:'a',parentService:'assistant-python',service:'language-engine',clockDomain:'remote-handler',clockId:'remote-1',startMs:0,durationMs:7}}};
 const gateway={stage:'service_span',data:{operation:'assistant dispatch',_journey:{eventId:'gateway-event',spanId:'gateway',service:'api-gateway',startMs:null,atMs:null}}};
 const python=event('a',10,20,'gateway');python.data._journey.parentService='api-gateway';
 const j=report([gateway,python,remote]);const m=navigationModel(j);
 assert.equal(m.timed.length,1);assert.equal(m.end,30);assert.equal(m.remote.length,2);
 assert.equal(m.rows[2].parentId,'span:a');assert.equal(m.rows[2].depth,0);assert.equal(m.rows[1].parentId,'span:gateway');assert.equal(m.rows[1].depth,0);assert.equal(m.rows[2].duration,7);
 assert.ok(!m.problems.some(p=>p.id==='time-span:remote-1'));assert.equal(m.untimed.length,0);
 remote.data._journey.clockId='wrong';assert.equal(navigationModel(report([remote])).untimed.length,1);
});
