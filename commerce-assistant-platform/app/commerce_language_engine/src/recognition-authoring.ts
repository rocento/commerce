import {isDeepStrictEqual} from 'node:util';
import {compileRecognitionRules,type RecognitionRules} from './recognition-rules.ts';
import {recognitionSeed} from './recognition-seed.ts';
import {currentReleaseId,loadRelease,stageRelease,type ReleaseClient} from './release-lifecycle.ts';
import type {Dictionary} from './types.ts';
/** Explicit migration: existing archives and their fingerprints remain untouched. */
export function upgradeRecognitionDictionary(base:Dictionary,rules:RecognitionRules=recognitionSeed()):Dictionary {
 compileRecognitionRules(rules);
 if(base.recognitionRules&&!isDeepStrictEqual(base.recognitionRules,rules)&&rules.revision<=base.recognitionRules.revision)throw new Error('Changed recognition data requires a higher revision');
 const dictionary=structuredClone(base);dictionary.recognitionRules=structuredClone(rules);
 delete dictionary.generationFingerprint;
 return dictionary;
}
/** Stage a normal immutable candidate; existing evaluation/promotion gates still apply. */
export async function stageRecognitionRules(client:ReleaseClient,input:{baseReleaseId:string;expectedActiveReleaseId:string|null;rules?:RecognitionRules}){
 if(await currentReleaseId(client)!==input.expectedActiveReleaseId)throw new Error('Active release changed; reload the base before staging recognition rules');
 const base=await loadRelease(client,input.baseReleaseId),dictionary=upgradeRecognitionDictionary(base.dictionary,input.rules);
 return stageRelease(client,{dictionary,corpus:base.dictionary.corpus,corpusArchive:base.corpus_gzip,baseReleaseId:base.releaseId,source:'recognition-rule-authoring',change:{kind:'recognition-rules',key:'recognitionRules',payload:{revision:dictionary.recognitionRules!.revision}}});
}
