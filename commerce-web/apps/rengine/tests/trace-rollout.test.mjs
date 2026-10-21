import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkTraceRollout} from '../../scripts/check-trace-rollout.mjs';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/trace-services.json',import.meta.url),'utf8'));
test('read-only rollout check requires complete linked evidence from each supported boundary',()=>{const report=fixture();assert.equal(checkTraceRollout(report).ok,true);for(const service of ['language-engine','api-gateway']){const partial=fixture();partial.events=partial.events.filter(e=>!(e.stage==='service_span'&&e.data._journey.service===service));assert.equal(checkTraceRollout(partial).ok,false);}});
test('rollout check rejects truncation, unredacted exports, wrong trace, broken parents and invalid clocks',()=>{for(const mutate of [r=>r.truncated=true,r=>r.redacted=false,r=>r.events.at(-1).data._journey.traceId='wrong',r=>r.events.at(-1).data._journey.parentSpanId='missing',r=>r.events.at(-1).data._journey.durationMs=-1]){const r=fixture();mutate(r);assert.equal(checkTraceRollout(r).ok,false);}assert.equal(checkTraceRollout(null).ok,false);});
