import type {Dictionary,CorpusCase} from '../src/types.ts';
import {withDb,closeDb} from '../src/database.ts';
import {stageRelease,loadRelease} from '../src/release-lifecycle.ts';
import {rocentoDictionary,rocentoIntentCodes,compatibleCase} from '../src/rocento-capabilities.ts';

// Work from an immutable baseline. Shared authoring tables are not a draft.
try{
 const result=await withDb(async c=>{
  const active=(await c.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0]?.release_id;
  if(!active)throw new Error('Pruning requires an active immutable baseline. Bootstrap an initial release first.');
  const baseline=await loadRelease(c,active);
  const removed=baseline.dictionary.intents.filter((i:Dictionary['intents'][number])=>!rocentoIntentCodes.has(i.code)).map((i:Dictionary['intents'][number])=>i.code);
  if(!process.argv.includes('--apply'))return {apply:false,baseReleaseId:active,removed};
  const dictionary=rocentoDictionary(baseline.dictionary),codes=new Set(dictionary.intents.map((i:Dictionary['intents'][number])=>i.code));
  const corpus=baseline.dictionary.corpus.filter((row:CorpusCase)=>compatibleCase(row,codes));
  const candidate=await stageRelease(c,{dictionary,corpus,baseReleaseId:active,source:'prune-unsupported',change:{kind:'capability-prune',key:'rocento',payload:{removed}}});
  return {apply:true,activated:false,removed,...candidate};
 });
 console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
