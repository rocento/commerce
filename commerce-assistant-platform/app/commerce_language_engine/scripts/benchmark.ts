import {writeFile} from 'node:fs/promises';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const start=performance.now();const c=await loadRuntime();const startupMs=performance.now()-start;const iterations=Number(process.argv[2]??10000);if(!Number.isInteger(iterations)||iterations<1||iterations>1000000)throw new Error('Iterations must be 1–1,000,000');const queries=c.dictionary.corpus;
for(let i=0;i<1000;i++)resolve(c,queries[i%queries.length].text);
const times:number[]=[];for(let i=0;i<iterations;i++){const t=performance.now();resolve(c,queries[i%queries.length].text);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
const report={iterations,startupMs,averageMs:times.reduce((a,b)=>a+b,0)/iterations,p50Ms:times[Math.floor(iterations*.5)],p95Ms:times[Math.floor(iterations*.95)],p99Ms:times[Math.floor(iterations*.99)],memory:process.memoryUsage(),node:process.version,platform:process.platform,warning:'Warm-process synthetic corpus, current small dictionary only; not production qualification.'};await writeFile(`data/benchmark-${iterations}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
