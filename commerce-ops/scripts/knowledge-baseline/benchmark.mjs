// Local in-process parser baseline. Never calls HTTP or commerce services.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {sha256,percentile} from './lib.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-phase0-20261010'));
const engine=join(out,'engine');
const {parseCsv,selectCases}=await import(pathToFileURL(join(engine,'scripts/shopper-csv-evaluation.ts')));
const csv=readFileSync(join(root,'output/live-shopper-eval-20261008/live-shopping-assistant-4000-english.csv'));
const cases=selectCases(parseCsv(csv.toString()),JSON.parse(readFileSync(join(root,'output/live-shopper-eval-20261008/cases.json'))));
const memoryBefore=process.memoryUsage();
const loadStart=performance.now();
const [{loadRuntime},{resolve:interpret},{runtimeSha256}]=await Promise.all(['runtime.ts','engine.ts','runtime-identity.ts'].map(p=>import(pathToFileURL(join(engine,'src',p)))));
const runtime=await loadRuntime();
const loadAndCompileMs=performance.now()-loadStart;
const memoryLoaded=process.memoryUsage();
for(const item of cases.filter((_,i)=>i%16===0)){interpret(runtime,item.turns[0],{industry:item.store});}
const samples=[],byStore={};const start=performance.now();
for(const item of cases){
 let context={industry:item.store};
 for(const text of item.turns){
  const t=performance.now();const result=interpret(runtime,text,context);const elapsed=performance.now()-t;
  samples.push(elapsed);(byStore[item.store]??=[]).push(elapsed);context=result.context?.next??context;
 }
}
const durationMs=performance.now()-start;
const summarize=xs=>({count:xs.length,p50Ms:percentile(xs,.5),p95Ms:percentile(xs,.95),p99Ms:percentile(xs,.99),maxMs:Math.max(...xs)});
const report={createdAt:new Date().toISOString(),scope:'Single-process, sequential local parser calls. No HTTP, database query per turn, catalog retrieval, response generation, or production load test.',environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},identity:{runtimeSha256:await runtimeSha256(pathToFileURL(engine+'/')),fingerprint:runtime.dictionary.generationFingerprint,csvSha256:sha256(csv)},warmupFirstTurns:cases.filter((_,i)=>i%16===0).length,loadAndCompileMs,durationMs,throughputTurnsPerSecond:samples.length/(durationMs/1000),latency:summarize(samples),byStore:Object.fromEntries(Object.entries(byStore).map(([k,v])=>[k,summarize(v)])),memory:{before:memoryBefore,loaded:memoryLoaded,after:process.memoryUsage(),processMaxRssKiB:process.resourceUsage().maxRSS},limitations:['Development host and Node version differ from production.','One sequential sample; not a concurrency, capacity, or SLA certification.','GC and JIT affect timings; compare candidates under the same harness and environment.']};
writeFileSync(join(out,'local-performance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({latency:report.latency,loadAndCompileMs,memory:report.memory},null,2));
