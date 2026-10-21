/** Snapshot-based diagnostic only. It does not record or approve a release evaluation. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url),engine=new URL('commerce-assistant-platform/app/commerce_language_engine/',root);
const worker=process.argv[2]==='--worker';
const out=new URL('file://'+(worker?process.argv[3]:process.argv[2]).replace(/\/$/,'')+'/');
const corpusPath=worker?process.argv[4]:process.argv[3];
const dictionaryPath=worker?process.argv[5]:process.argv[4];
const corpusBytes=await readFile(corpusPath),corpus=corpusBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
const sha=b=>createHash('sha256').update(b).digest('hex');
if(worker){
 const partition=Number(process.argv[6]);const frozen=new URL('engine/',out);
 const [{compile},{resolve},{resolutionEnvelope},{runtimeSha256}]=await Promise.all(['compiler','engine','resolution-wire','runtime-identity'].map(name=>import(new URL('src/'+name+'.ts',frozen))));
 const dictionary=JSON.parse(await readFile(dictionaryPath,'utf8'));const compiled=compile({...dictionary,corpus:[]});
 const runtime=await runtimeSha256(frozen),identity={releaseId:null,generationFingerprint:dictionary.generationFingerprint,runtimeVersion:runtime,normalizationVersion:'english-v1',clauseSpanEncoding:'utf-16-code-units',evidenceSpanEncoding:'unicode-code-points'};
 const failures=[];let processed=0,wireFailureCount=0;
 for(let index=partition;index<corpus.length;index+=4){
  const expected=corpus[index],actual=resolve(compiled,expected.text,expected.context);processed++;
  const reasons=[...(actual.intent!==expected.intent?['intent']:[]),...(actual.status!==(expected.status??'RESOLVED')?['status']:[]),...Object.entries(expected.entities??{}).filter(([key,value])=>!isDeepStrictEqual(actual.entities[key],value)).map(([key])=>'entity:'+key)];
  let wireError;try{resolutionEnvelope({...actual},identity);}catch(e){wireFailureCount++;wireError=String(e);reasons.push('wire');}
  if(reasons.length)failures.push({caseIndex:index,expected,reasons,actual:{intent:actual.intent,status:actual.status,entities:actual.entities,missing:actual.missing,message:actual.message},wireError});
 }
 await writeFile(new URL('worker-'+partition+'.json',out),JSON.stringify({processed,wireFailureCount,runtime,failures})+'\n',{flag:'wx'});
}else{
 await mkdir(out);await mkdir(new URL('engine/',out));
 await cp(new URL('src/',engine),new URL('engine/src/',out),{recursive:true});
 for(const file of ['package.json','package-lock.json'])await cp(new URL(file,engine),new URL('engine/'+file,out));
 await cp(new URL('migrations/',engine),new URL('engine/migrations/',out),{recursive:true});
 await Promise.all(Array.from({length:4},(_,n)=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',fileURLToPath(out),corpusPath,dictionaryPath,String(n)],{stdio:['ignore','inherit','inherit']});
  p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error('Worker '+n+' failed: '+code)));
 })));
 const shards=await Promise.all(Array.from({length:4},(_,n)=>readFile(new URL('worker-'+n+'.json',out),'utf8').then(JSON.parse)));
 const failures=shards.flatMap(s=>s.failures).sort((a,b)=>a.caseIndex-b.caseIndex);const byFamily={},byReason={};
 for(const f of failures){const key=f.expected.templateFamily??'<none>';byFamily[key]=(byFamily[key]??0)+1;const why=f.reasons.join(',');byReason[why]=(byReason[why]??0)+1;}
 assert.equal(shards.reduce((sum,s)=>sum+s.processed,0),corpus.length);assert.equal(new Set(shards.map(s=>s.runtime)).size,1);
 const summary={purpose:'Diagnostic of reviewed corpus against a copied runtime; no release evaluation recorded',corpusSha256:sha(corpusBytes),dictionarySha256:sha(await readFile(dictionaryPath)),runtimeSha256:shards[0].runtime,count:corpus.length,failureCount:failures.length,wireFailureCount:shards.reduce((sum,s)=>sum+s.wireFailureCount,0),byFamily,byReason};
 await writeFile(new URL('all-failures.jsonl',out),failures.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
 await writeFile(new URL('summary.json',out),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary,null,2));
}
