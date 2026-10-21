import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {writeFile} from 'node:fs/promises';
import {withDb,closeDb} from '../src/database.ts';
import {currentReleaseId,loadRelease,stageRelease} from '../src/release-lifecycle.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {expansionCases,expansionSource} from '../src/generation/data-expansion.ts';
import {caseKey} from '../src/generation/corpus.ts';
import {compile} from '../src/compiler.ts';
import type {Dictionary,CorpusCase} from '../src/types.ts';

// Curated existing definitions win; changed definitions need an explicit draft.
// Evaluation of the complete frozen result is a separate release:evaluate step.
try{
 const source=buildExpandedDictionary();
 const result=await withDb(async c=>{
  const baseReleaseId=await currentReleaseId(c);
  if(!baseReleaseId)throw new Error('An active immutable baseline is required. Bootstrap an initial reviewed release first.');
  const baseline=await loadRelease(c,baseReleaseId),dictionary:Dictionary=structuredClone(baseline.dictionary);
  return withDictionaryRecognition(dictionary,async()=>{
  const additions=source.intents.filter(intent=>intent.provenance===expansionSource&&!dictionary.intents.some(prior=>prior.code===intent.code));
  const neededGroups=new Set(additions.flatMap(intent=>[...intent.conditions,...(intent.alternativeRules??[]).flatMap(rule=>rule.conditions)].flatMap(condition=>[condition.group,condition.after,condition.near].filter((code):code is string=>!!code))));
  for(const group of source.groups.filter(group=>neededGroups.has(group.code))){
   const prior=dictionary.groups.find(row=>row.code===group.code);
   if(prior)prior.terms=[...new Set([...prior.terms,...group.terms])];else dictionary.groups.push(structuredClone(group));
  }
  dictionary.intents.push(...structuredClone(additions));
  const codes=new Set(dictionary.intents.map(intent=>intent.code));
  for(const pattern of source.patterns.filter(row=>additions.some(intent=>intent.code===row.intent)))dictionary.patterns.push(structuredClone(pattern));
  dictionary.requestPrefixes=[...new Set([...(dictionary.requestPrefixes??[]),...(source.requestPrefixes??[])])];
  dictionary.actionFrames??=[];
  for(const frame of source.actionFrames??[])if(codes.has(frame.intent)&&!dictionary.actionFrames.some(row=>row.code===frame.code))dictionary.actionFrames.push(structuredClone(frame));
  const cases:CorpusCase[]=[...baseline.dictionary.corpus,...expansionCases(),...source.corpus.filter(row=>row.source===expansionSource)];
  const corpus=[...new Map(cases.filter(row=>!row.intent||codes.has(row.intent)).map(row=>[caseKey(row),row])).values()];
  compile(dictionary);
  const report={source:expansionSource,addedIntents:additions.map(row=>row.code),corpusCases:corpus.length,baseReleaseId};
  if(!process.argv.includes('--apply'))return {apply:false,...report};
  return {apply:true,activated:false,...report,...await stageRelease(c,{dictionary,corpus,baseReleaseId,source:expansionSource,change:{kind:'data-expansion',key:expansionSource,payload:report}})};
  });
 });
 await writeFile(process.env.CLE_EXPANSION_REPORT??'data/expansion-sync-report.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
