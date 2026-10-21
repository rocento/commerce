import {knowledgeHash} from './language-knowledge.ts';
import type {Dictionary} from './types.ts';
/** Explicit authoring/bootstrap data. Production resolution never calls this loader. */
import {readFileSync} from 'node:fs';
import {compileRecognitionRules,withRecognitionRules,type RecognitionRules} from './recognition-rules.ts';
const seed=JSON.parse(readFileSync(new URL('../seeds/recognition-rules.en.json',import.meta.url),'utf8')) as RecognitionRules;
export function recognitionSeed():RecognitionRules{return structuredClone(seed);}
export function withRecognitionSeed<T>(run:()=>T):T{return withRecognitionRules(compileRecognitionRules(seed),run);}

export function withSeedDictionary(base:Dictionary):Dictionary {
 const {generationFingerprint:_old,corpus,...content}=structuredClone(base);
 const artifact={...content,recognitionRules:recognitionSeed()};
 return {...artifact,corpus,generationFingerprint:knowledgeHash(artifact)};
}
