import {withDictionaryRecognition} from '../recognition-rules.ts';
import {createHash} from 'node:crypto';
import {normalize} from '../normalize.ts';
import type {Dictionary,CorpusCase} from '../types.ts';
export function manifest(d:Dictionary,cases:CorpusCase[],duplicates:number) {
 return withDictionaryRecognition(d,()=>{
 const counts=(values:string[])=>{const result:Record<string,number>={};for(const value of values)result[value]=(result[value]??0)+1;return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));};
 const fingerprint=createHash('sha256').update(JSON.stringify(d)).update(JSON.stringify(cases)).digest('hex');
 const vocabulary=(predicate:(code:string)=>boolean)=>new Set(d.groups.filter(g=>predicate(g.code)).flatMap(g=>g.terms)).size;
 const actionTerms=vocabulary(code=>code.startsWith('ACTION_'));
 const referenceTerms=vocabulary(code=>code.startsWith('REFERENCE_')||code.startsWith('ORDINAL_')||code==='ORDER_RECENCY');
 const objectTerms=vocabulary(code=>code.startsWith('OBJECT_'));
 const training=cases.filter(c=>c.split==='train');
 return {
  version:d.version,fingerprint,
  counts:{requestPrefixes:d.requestPrefixes?.length??0,actionFrames:d.actionFrames?.length??0,intents:d.intents.length,intentRules:d.intents.reduce((n,i)=>n+1+(i.alternativeRules?.length??0),0),families:new Set(d.intents.map(i=>i.family)).size,semanticGroups:d.groups.length,semanticTerms:d.groups.reduce((n,g)=>n+g.terms.length,0),distinctNormalizedTerms:new Set(d.groups.flatMap(g=>g.terms)).size,actionTerms,referenceTerms,objectTerms,entityTerms:d.entity_terms.length,phrasePatterns:d.patterns.length,transitions:d.transitions.length,conflicts:d.conflicts.length,evaluationUtterances:cases.length},
  duplicatesRemoved:duplicates,
  coverage:{nonCatalogCases:cases.filter(c=>c.source!=='constrained-catalog-v2').length,templateFamilies:new Set(cases.map(c=>c.templateFamily)).size,distinctNormalizedTexts:new Set(cases.map(c=>normalize(c.text))).size,trainingCases:training.length,trainingByIntent:counts(training.map(c=>c.intent??'<ABSTAIN>')),authoredLinguisticCases:cases.filter(c=>c.source==='linguistic-coverage-v6').length,linguisticExpansionCases:cases.filter(c=>c.source?.endsWith('-v6')).length},
  bySplit:counts(cases.map(c=>c.split??'train')),byDifficulty:counts(cases.map(c=>c.difficulty)),bySource:counts(cases.map(c=>c.source??'unknown')),byIntent:counts(cases.map(c=>c.intent??'<ABSTAIN>')),byTemplateFamily:counts(cases.map(c=>c.templateFamily??'unknown')),
  limits:['Labels are authored targets, never generated from engine predictions.','The engine is rule-based; adding corpus rows does not train model weights.','Template families are split; lexical atoms and category values are shared. Development inspected generated failures, including test-family examples; these are not a blind holdout or real-user validation.','Catalog search combinations are reported separately from linguistic expansion. Use macro and per-structure metrics rather than raw corpus size.','Failed target cases remain in evaluation data; they are not relabeled to inflate accuracy.'],
 };
 });
}
