import {writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {expansionCases} from '../src/generation/data-expansion.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const c=compile(buildExpandedDictionary());let total=0,passed=0;const failures:unknown[]=[];
for(const t of expansionCases()){total++;const r=resolve(c,t.text,t.context);const errors=Object.entries(t.entities??{}).filter(([k,v])=>!isDeepStrictEqual(r.entities[k],v)).map(([k])=>k);if(r.intent===t.intent&&r.status===(t.status??'RESOLVED')&&!errors.length)passed++;else if(failures.length<35)failures.push({text:t.text,expected:t.intent,actual:r.intent,status:r.status,errors});}
const report={total,passed,failed:total-passed,warning:'Authored synthetic regression cases, not real-user data or neural training.',failures};await writeFile('data/expansion-evaluation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(passed!==total)process.exitCode=1;
