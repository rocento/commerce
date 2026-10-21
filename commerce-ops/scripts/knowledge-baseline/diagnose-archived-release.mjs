/** Full diagnostics only; immutable labels are not rewritten and this records no passing release evidence. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url),out=new URL('output/enterprise-knowledge-release-prep-20261010/',root);
const candidateRoot=new URL('engine/',out),baselineRoot=new URL('output/enterprise-knowledge-phase0-20261010/engine/',root);
const diagnostics=new URL('archived-diagnostics/',out),count=4;
const {runtimeSha256}=await import(new URL('src/runtime-identity.ts',candidateRoot));
const production=JSON.parse(await readFile(new URL('production-baseline.json',out),'utf8'));
const expected=JSON.parse(await readFile(new URL('initial-archived-corpus.json',out),'utf8'));
const [candidateHash,baselineHash]=await Promise.all([runtimeSha256(candidateRoot),runtimeSha256(baselineRoot)]);
assert.equal(baselineHash,production.runtimeSha256);
const candidate=JSON.parse(await readFile(new URL('candidate-data/compiled.json',out),'utf8'));
const baseline=JSON.parse(await readFile(new URL('output/enterprise-knowledge-phase0-20261010/production-active-artifact.json',root),'utf8'));
assert.equal(baseline.generationFingerprint,production.release.fingerprint);
const corpusBytes=await readFile(new URL('production-corpus.jsonl',out));
assert.equal(createHash('sha256').update(corpusBytes).digest('hex'),production.release.corpusSha256);
const cases=corpusBytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
assert.equal(cases.length,expected.count);
function evaluate(runtime,resolve,envelope,test,identity){
 const actual=resolve(runtime,test.text,test.context);
 let wireError;
 try{envelope({...actual},identity);}catch(error){wireError=error instanceof Error?error.message:String(error);}
 const entityErrors=Object.entries(test.entities??{}).filter(([key,value])=>!isDeepStrictEqual(actual.entities[key],value)).map(([key])=>key);
 const reasons=[...(actual.intent!==test.intent?['intent']:[]),...(actual.status!==(test.status??'RESOLVED')?['status']:[]),...entityErrors.map(key=>'entity:'+key),...(wireError?['wire']:[])];
 return {passed:reasons.length===0,reasons,wireError,actual:{intent:actual.intent,status:actual.status,entities:actual.entities,message:actual.message,missing:actual.missing,actions:actual.actions,fulfillment:actual.fulfillment,references:actual.references,ambiguities:actual.ambiguities}};
}
if(process.argv[2]==='--worker'){
 const partition=Number(process.argv[3]);assert.ok(Number.isInteger(partition)&&partition>=0&&partition<count);
 const [nextCompiler,nextEngine,nextWire,oldCompiler,oldEngine,oldWire]=await Promise.all([
  import(new URL('src/compiler.ts',candidateRoot)),import(new URL('src/engine.ts',candidateRoot)),import(new URL('src/resolution-wire.ts',candidateRoot)),
  import(new URL('src/compiler.ts',baselineRoot)),import(new URL('src/engine.ts',baselineRoot)),import(new URL('src/resolution-wire.ts',baselineRoot)),
 ]);
 const next=nextCompiler.compile(candidate),old=oldCompiler.compile({...baseline,corpus:[]});
 const common={normalizationVersion:'english-v1',clauseSpanEncoding:'utf-16-code-units',evidenceSpanEncoding:'unicode-code-points'};
 const nextIdentity={...common,releaseId:null,generationFingerprint:candidate.generationFingerprint,runtimeVersion:candidateHash};
 const oldIdentity={...common,releaseId:production.release.id,generationFingerprint:baseline.generationFingerprint,runtimeVersion:baselineHash};
 const failures=[];let processed=0,wireFailureCount=0;
 for(let index=partition;index<cases.length;index+=count){
  const test=cases[index],actual=evaluate(next,nextEngine.resolve,nextWire.resolutionEnvelope,test,nextIdentity);processed++;if(actual.wireError)wireFailureCount++;
  if(!actual.passed){
   const prior=evaluate(old,oldEngine.resolve,oldWire.resolutionEnvelope,test,oldIdentity);
   failures.push({caseIndex:index,caseNumber:index+1,expected:test,candidate:actual,productionBaseline:prior,classification:prior.passed?'regression_against_archived_expectation':'preexisting_archived_expectation_failure',behaviorChanged:!isDeepStrictEqual(actual.actual,prior.actual)});
  }
 }
 await writeFile(new URL(`worker-${partition}.json`,diagnostics),JSON.stringify({partition,processed,wireFailureCount,candidateHash,baselineHash,failures})+'\n',{flag:'wx'});
 console.log(JSON.stringify({partition,processed,failures:failures.length,wireFailureCount}));
}else{
 await mkdir(diagnostics);
 const startedAt=new Date().toISOString();
 await Promise.all(Array.from({length:count},(_,partition)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',String(partition)],{cwd:fileURLToPath(root),stdio:['ignore','inherit','inherit']});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Diagnostic worker failed: '+partition+' exit '+code)));
 })));
 const shards=await Promise.all(Array.from({length:count},(_,n)=>readFile(new URL(`worker-${n}.json`,diagnostics),'utf8').then(JSON.parse)));
 const failures=shards.flatMap(s=>s.failures).sort((a,b)=>a.caseIndex-b.caseIndex);
 assert.equal(failures.length,expected.failureCount);assert.equal(shards.reduce((n,s)=>n+s.processed,0),cases.length);
 const group=fn=>{const groups=new Map();for(const f of failures){const key=fn(f);groups.set(key,(groups.get(key)??0)+1);}return Object.fromEntries([...groups].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));};
 const summary={startedAt,completedAt:new Date().toISOString(),purpose:'Complete diagnostic, not passing release evidence',labelsChanged:false,rubricVersion:expected.rubricVersion,count:cases.length,failureCount:failures.length,wireFailureCount:shards.reduce((n,s)=>n+s.wireFailureCount,0),candidateRuntimeSha256:candidateHash,productionRuntimeSha256:baselineHash,corpusSha256:production.release.corpusSha256,classification:group(f=>f.classification),byTemplateFamily:group(f=>f.expected.templateFamily??'<none>'),bySource:group(f=>f.expected.source??'<none>'),byExpectedActual:group(f=>`${f.expected.intent??'null'}/${f.expected.status??'RESOLVED'} -> ${f.candidate.actual.intent??'null'}/${f.candidate.actual.status}`),byReasons:group(f=>f.candidate.reasons.join(',')),byGroupAndClass:group(f=>`${f.classification}: ${f.expected.templateFamily??'<none>'}: ${f.candidate.reasons.join(',')}`),limits:['Production comparison executes frozen sources with the exact captured runtime hash and dictionary, not live user traffic.','Regression classification follows unchanged archived expectations; it is separate from semantic correctness.','The old engine is run only on candidate failures, so this diagnostic does not count candidate improvements.']};
 await writeFile(new URL('all-failures.jsonl',diagnostics),failures.map(f=>JSON.stringify(f)).join('\n')+'\n',{flag:'wx'});
 await writeFile(new URL('summary.json',diagnostics),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(summary,null,2));
}
