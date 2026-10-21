import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isDeepStrictEqual} from 'node:util';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {authoredCoverageCases} from '../src/generation/coverage-cases.ts';
import type {CorpusCase} from '../src/types.ts';
const runtime=await loadRuntime();
const generation=JSON.parse(await readFile('data/generation-report.json','utf8'));
if(generation.fingerprint!==runtime.dictionary.generationFingerprint)throw new Error('Regenerate and compile matching dictionary/corpus artifacts first.');
type Totals={count:number;intentCorrect:number;statusCorrect:number;exactCorrect:number;falseActions:number};
const empty=():Totals=>({count:0,intentCorrect:0,statusCorrect:0,exactCorrect:0,falseActions:0});
const buckets=new Map<string,Totals>();const failures:unknown[]=[];let failureCount=0;
function check(t:CorpusCase,keys:string[]){
 const r=resolve(runtime,t.text,t.context),status=t.status??'RESOLVED';
 const intentCorrect=r.intent===t.intent,statusCorrect=r.status===status;
 const entityCorrect=Object.entries(t.entities??{}).every(([key,value])=>isDeepStrictEqual(r.entities[key],value));
 for(const key of keys){const b=buckets.get(key)??empty();b.count++;b.intentCorrect+=Number(intentCorrect);b.statusCorrect+=Number(statusCorrect);b.exactCorrect+=Number(intentCorrect&&statusCorrect&&entityCorrect);b.falseActions+=Number(t.intent===null&&r.intent!==null);buckets.set(key,b);}
 if(!intentCorrect||!statusCorrect||!entityCorrect){failureCount++;if(failures.length<5000)failures.push({text:t.text,context:t.context,source:t.source,structure:t.templateFamily,expected:{intent:t.intent,status},actual:{intent:r.intent,status:r.status}});}
}
for(const t of authoredCoverageCases())check(t,['authored']);
for await(const line of createInterface({input:createReadStream('data/corpus.jsonl'),crlfDelay:Infinity})){
 if(!line.trim())continue;const t=JSON.parse(line) as CorpusCase;
 if(!t.source?.endsWith('-v6'))continue;
 check(t,['expanded','source:'+t.source,'split:'+t.split,'difficulty:'+t.difficulty,'structure:'+t.templateFamily]);
}
const metrics=(t:Totals)=>({...t,exactAccuracy:t.exactCorrect/t.count,intentAccuracy:t.intentCorrect/t.count,statusAccuracy:t.statusCorrect/t.count});
const select=(prefix:string)=>Object.fromEntries([...buckets].filter(([key])=>key.startsWith(prefix)).map(([key,t])=>[key.slice(prefix.length),metrics(t)]));
const report={dictionaryVersion:runtime.dictionary.version,fingerprint:generation.fingerprint,authored:metrics(buckets.get('authored')!),expanded:metrics(buckets.get('expanded')!),bySource:select('source:'),bySplit:select('split:'),byDifficulty:select('difficulty:'),byStructure:select('structure:'),failureCount,failures,failuresTruncated:failureCount>failures.length,limitations:generation.limits};
await writeFile('data/coverage-evaluation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({authored:report.authored,expanded:report.expanded,bySource:report.bySource},null,2));
if(report.authored.exactCorrect!==report.authored.count)process.exitCode=1;
