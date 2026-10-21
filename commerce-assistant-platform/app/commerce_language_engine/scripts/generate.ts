import {enterRecognitionRules} from '../src/recognition-rules.ts';
import {writeFile,mkdir,rename} from 'node:fs/promises';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {collectCorpus} from '../src/generation/corpus.ts';
import {manifest} from '../src/generation/manifest.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {loadRelease} from '../src/release-lifecycle.ts';
import {saveDictionary,closeDb,withDb} from '../src/database.ts';
const start=performance.now();let d=buildExpandedDictionary();const compiled=compile(d);enterRecognitionRules(compiled.recognition);
const failures=d.corpus.filter(t=>{
 const r=resolve(compiled,t.text,t.context);
 // Phase 6 references can make the action known while its commerce target is
 // still missing. Preserve those examples as context-required instead of
 // forcing the old UNKNOWN/null-intent expectation.
 const contextRequired=t.difficulty==='CONTEXT_REQUIRED'&&r.status==='NEEDS_CONTEXT'&&!!r.primaryIntent;
 const intentMatches=r.intent===t.intent||(contextRequired&&t.intent===null);
 const statusMatches=r.status===(t.status??'RESOLVED')||contextRequired;
 return !intentMatches||!statusMatches;
});
if(failures.length)throw new Error('Canonical validation failed; database unchanged: '+JSON.stringify(failures));
const {cases,duplicates}=collectCorpus(d);const report={...manifest(d,cases,duplicates),canonicalChecks:d.corpus.length,generationMs:performance.now()-start};
d.generationFingerprint=report.fingerprint;
await mkdir('data',{recursive:true});
// Publish artifacts only after successful validation and, in online mode, DB commit.
let candidate:Awaited<ReturnType<typeof saveDictionary>>|undefined;
if(!process.argv.includes('--offline')){try{const staged=await saveDictionary(d,cases,report);candidate=staged;d=(await withDb(c=>loadRelease(c,staged.releaseId))).dictionary;report.fingerprint=staged.fingerprint;}finally{await closeDb();}}
for(const [path,content] of [['generated.json',JSON.stringify(d)],['corpus.jsonl',cases.map(c=>JSON.stringify(c)).join('\n')+'\n'],['generation-report.json',JSON.stringify(report,null,2)]]){await writeFile('data/'+path+'.tmp',content);await rename('data/'+path+'.tmp','data/'+path);}
console.log(JSON.stringify({candidate,activated:false,source:process.argv.includes('--offline')?'offline generation':'PostgreSQL',...report.counts,duplicatesRemoved:duplicates,bySplit:report.bySplit,generationMs:report.generationMs,totalMs:performance.now()-start},null,2));
