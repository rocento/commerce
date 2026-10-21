import {withDictionaryRecognition} from './recognition-rules.ts';
/** Append reviewed meanings to existing groups. No new intents or execution rights. */
import {createHash} from 'node:crypto';
import {compile} from './compiler.ts';
import {normalize} from './normalize.ts';
import type {Dictionary} from './types.ts';

export type VocabularyTerm = {group:string; surface:string; sense:string; sharedWith:string[]};
export type VocabularyPack = {
  schemaVersion:1; id:string; revision:number; language:'en'; scope:'global';
  source:string; reviewState:'approved'; reviewedBy:string; terms:VocabularyTerm[];
};
function record(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==='object' && !Array.isArray(value);
}
function exact(value:Record<string,unknown>, keys:string[]) {
  if(Object.keys(value).sort().join('|')!==keys.sort().join('|'))throw new Error('Unexpected vocabulary record fields');
}
export function parseVocabularyPack(value:unknown):VocabularyPack {
  if(!record(value))throw new Error('Invalid vocabulary pack');
  exact(value,['schemaVersion','id','revision','language','scope','source','reviewState','reviewedBy','terms']);
  if(value.schemaVersion!==1 || value.language!=='en' || value.scope!=='global' || value.reviewState!=='approved' ||
    typeof value.id!=='string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision)<1 ||
    typeof value.source!=='string' || !value.source.trim() || value.source.length>200 ||
    typeof value.reviewedBy!=='string' || !value.reviewedBy.trim() || value.reviewedBy.length>200 ||
    !Array.isArray(value.terms) || !value.terms.length || value.terms.length>500)throw new Error('Unapproved or invalid English vocabulary pack');
  const seen=new Set<string>();
  for(const term of value.terms){
    if(!record(term))throw new Error('Invalid vocabulary term');
    exact(term,['group','surface','sense','sharedWith']);
    if(typeof term.group!=='string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(term.group) || term.sense!==term.group ||
      typeof term.surface!=='string' || !/^[a-z]+(?:[ '-][a-z]+)*$/.test(term.surface) || term.surface.length>120 || normalize(term.surface)!==term.surface ||
      !Array.isArray(term.sharedWith) || term.sharedWith.some(g=>typeof g!=='string'||! /^[A-Z][A-Z0-9_]{0,99}$/.test(g)||g===term.group) || new Set(term.sharedWith).size!==term.sharedWith.length)
      throw new Error('Invalid normalized surface, sense or shared-group review');
    const key=term.group+'|'+term.surface;
    if(seen.has(key))throw new Error('Duplicate vocabulary meaning: '+key);
    seen.add(key);
  }
  return value as VocabularyPack;
}
export function vocabularyHash(value:unknown):string {
  const canonical=(item:unknown):unknown=>Array.isArray(item)?item.map(canonical):record(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function vocabularyDigest(pack:VocabularyPack):string {
  // The parser enforces fields; stable sorting also binds order-independent reviewed data.
  return vocabularyHash({...pack,terms:[...pack.terms].sort((a,b)=>(a.group+'|'+a.surface).localeCompare(b.group+'|'+b.surface)).map(t=>({...t,sharedWith:[...t.sharedWith].sort()}))});
}
export function projectVocabulary(base:Dictionary, input:unknown) {
 return withDictionaryRecognition(base,()=>{
  const pack=parseVocabularyPack(input), dictionary=structuredClone(base);
  const byGroup:Record<string,{proposed:number;added:number;existing:number}>={};
  const added:VocabularyTerm[]=[];
  // Match the order-independent pack digest: input row order cannot change a release.
  const terms=[...pack.terms].sort((a,b)=>(a.group+'|'+a.surface).localeCompare(b.group+'|'+b.surface));
  for(const term of terms){
    const group=dictionary.groups.find(g=>g.code===term.group);
    if(!group || group.category==='CATEGORY')throw new Error('Unknown or catalog-only semantic group: '+term.group);
    for(const shared of term.sharedWith)if(!dictionary.groups.some(g=>g.code===shared))throw new Error('Unknown shared group: '+shared);
    const owners=[...new Set([...dictionary.groups.filter(g=>g.code!==term.group&&g.terms.some(t=>normalize(t)===term.surface)).map(g=>g.code),...terms.filter(t=>t.surface===term.surface&&t.group!==term.group).map(t=>t.group)])];
    // Review every new competing sense; do not collapse legitimate existing senses.
    if(owners.some(g=>!term.sharedWith.includes(g)))throw new Error('Unreviewed ambiguous surface: '+term.surface);
    if(dictionary.entity_terms.some(t=>normalize(t.alias)===term.surface))throw new Error('Catalog/entity alias needs separate sense review: '+term.surface);
    const counts=byGroup[term.group]??={proposed:0,added:0,existing:0};counts.proposed++;
    if(group.terms.some(t=>normalize(t)===term.surface)){counts.existing++;continue;}
    group.terms.push(term.surface);
    (group.termMetadata??={})[term.surface]={source:pack.source,derivedFrom:term.group,enrichment:{schemaVersion:1,packId:pack.id,revision:pack.revision,language:'en',scope:'global',sense:term.sense,reviewState:'approved',reviewedBy:pack.reviewedBy}};
    counts.added++;added.push(term);
  }
  compile(dictionary);
  return {dictionary,pack,packSha256:vocabularyDigest(pack),added,byGroup};

 });
}
