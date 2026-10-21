import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compareRequest,requestMeaning,requestMetrics,type RequestMeaning,type RequestScore} from '../src/evaluation/requests.ts';
import type {Context} from '../src/types.ts';

const {values}=parseArgs({options:{dataset:{type:'string'},output:{type:'string'},dictionary:{type:'string'}}});
const path=values.dataset??new URL('../tests/fixtures/full-request-v1/cases.json',import.meta.url);
const contents=await readFile(path,'utf8');
const corpus=JSON.parse(contents) as {language:string;provenance:string;cases:{id:string;family:string;messages:string[];expected:RequestMeaning}[]};
if(corpus.language!=='en'||!corpus.provenance||!Array.isArray(corpus.cases)||!corpus.cases.length)throw new Error('Expected a labelled English corpus with provenance');
const runtime=values.dictionary?compile(JSON.parse(await readFile(values.dictionary,'utf8'))):await loadRuntime();
const rows:RequestScore[]=[];
for(const test of corpus.cases){
 if(!test.id||!test.family||rows.some(r=>r.id===test.id)||!Array.isArray(test.messages)||!test.messages.length||test.messages.some(t=>typeof t!=='string'||!t||t.length>4000))throw new Error('Invalid or duplicate request case');
 let context:Context={};let result:ReturnType<typeof resolve>|undefined;
 for(const message of test.messages){result=resolve(runtime,message,context);context=result.context.next;}
 rows.push({id:test.id,family:test.family,...compareRequest(requestMeaning(result!),test.expected),status:result!.status,expectedStatus:test.expected.status,confidence:result!.confidence});
}
const sourceRoot=new URL('../src/',import.meta.url),sourceHash=createHash('sha256');
for(const file of (await readdir(sourceRoot,{recursive:true})).filter(f=>f.endsWith('.ts')).sort()){
 sourceHash.update(file+'\0');sourceHash.update(await readFile(new URL(file,sourceRoot)));sourceHash.update('\0');
}
const report={schemaVersion:1,language:'en',provenance:corpus.provenance,
 limitations:['Authored contract regressions, not independent customer accuracy. No commerce execution is measured.', 'Full request means the exact labelled semantic projection; confidence, prose and debug fields are excluded. Routing thresholds are unchanged.'],
 corpusSha256:createHash('sha256').update(contents).digest('hex'),sourceSha256:sourceHash.digest('hex'),
 dictionaryVersion:runtime.dictionary.version,generationFingerprint:runtime.dictionary.generationFingerprint,
 summary:requestMetrics(rows),byFamily:Object.fromEntries([...new Set(rows.map(r=>r.family))].sort().map(f=>[f,requestMetrics(rows.filter(r=>r.family===f))])),cases:rows};
if(values.output)await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary:report.summary,failures:rows.filter(r=>!r.passed)},null,2));
if(report.summary.failed)process.exitCode=1;
