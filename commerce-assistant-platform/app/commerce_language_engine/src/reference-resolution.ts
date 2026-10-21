import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import type {Alias,ReferenceRule,SemanticAmbiguity,SemanticIndexes} from './types.ts';
import type {AmbiguityCandidate,ResolvedAmbiguity,SemanticContext} from './semantic-types.ts';

export type MatchedReferenceRule={rule:ReferenceRule;surface:string};

export function findReferenceRule(text:string,index:Map<string,ReferenceRule[]>,targetKind?:string):MatchedReferenceRule|undefined {
 const normalized=normalize(text),padded=` ${normalized} `;
 let best:MatchedReferenceRule|undefined;
 for(const [surface,rules] of index){
  if(!padded.includes(` ${surface} `))continue;
  const rule=rules.find(candidate=>!targetKind||candidate.targetKind===targetKind);
  if(rule&&(!best||surface.length>best.surface.length||surface.length===best.surface.length&&rule.precedence<best.rule.precedence))best={rule,surface};
 }
 return best;
}

function inText(text:string,term:string):boolean{return (` ${normalize(text)} `).includes(` ${normalize(term)} `);}

function inferredIndustry(dictionary:{entity_terms:Alias[]},term:string,text:string,context:SemanticContext):{industry?:string;local:boolean} {
 // A product category can disambiguate its modifier; a shared color or
 // material cannot establish the customer's requested industry. Explicit
 // category wording also owns a request made in a different store.
 const phrases=text.split(languagePattern('reference-resolution.phrases.pattern.1')).filter(phrase=>inText(phrase,term));
 const candidates=new Set(dictionary.entity_terms.filter(entity=>entity.type==='CATEGORY'&&entity.industry!=='CORE'&&normalize(entity.alias)!==term&&phrases.some(phrase=>inText(phrase,entity.alias))).map(entity=>entity.industry));
 if(candidates.size)return {industry:candidates.size===1?[...candidates][0]:undefined,local:true};
 if(context.industry)return {industry:context.industry,local:true};
 // A shared industry in an item list may select a specifically declared
 // sense (apples beside bananas), but cannot turn an independent noun into
 // a generic brand modifier (apple beside phones).
 const shared=new Set(dictionary.entity_terms.filter(entity=>entity.type==='CATEGORY'&&entity.industry!=='CORE'&&normalize(entity.alias)!==term&&inText(text,entity.alias)).map(entity=>entity.industry));
 return {industry:shared.size===1?[...shared][0]:undefined,local:false};
}

/** Resolve only lexical ambiguity. A single candidate never grants commerce authority. */
export function resolveAmbiguities(dictionary:{entity_terms:Alias[];semanticModel?:{ambiguities:SemanticAmbiguity[]}},text:string,context:SemanticContext,index?:Map<string,SemanticAmbiguity[]>):ResolvedAmbiguity[] {
 const terms=index??new Map<string,SemanticAmbiguity[]>();
 if(!index)for(const entry of dictionary.semanticModel?.ambiguities??[]){const term=normalize(entry.term),bucket=terms.get(term)??[];bucket.push(entry);terms.set(term,bucket);}
 const output:ResolvedAmbiguity[]=[];
 for(const [term,entries] of terms){
  if(!inText(text,term))continue;
  const {industry,local}=inferredIndustry(dictionary,term,text,context);
  let candidates:AmbiguityCandidate[]=entries.map(entry=>{
   const separator=entry.candidateRef.indexOf(':');
   const kind=separator<0?entry.candidateKind:entry.candidateRef.slice(0,separator);
   const value=separator<0?entry.candidateRef:entry.candidateRef.slice(separator+1);
   return {kind,value,...(entry.industry?{industry:entry.industry}:{}),score:Number(entry.priorWeight)};
  });
  if(industry){
   const scoped=candidates.filter(candidate=>candidate.industry===industry),generic=candidates.filter(candidate=>candidate.industry==='CORE');
   if(scoped.length)candidates=[...scoped,...generic.map(candidate=>({...candidate,score:candidate.score*0.15}))];
   else if(local&&generic.length&&generic.every(candidate=>candidate.kind==='BRAND'))candidates=generic;
  }
  // Repeated industry declarations support a sense; they are not independent
  // votes that make the same sense win an otherwise ambiguous bare request.
  const senses=new Map<string,AmbiguityCandidate>();
  for(const candidate of candidates){const key=candidate.kind+':'+candidate.value,prior=senses.get(key);if(!prior||candidate.score>prior.score)senses.set(key,candidate);}
  candidates=[...senses.values()];
  const total=candidates.reduce((sum,candidate)=>sum+candidate.score,0)||1;
  candidates=candidates.map(candidate=>({...candidate,score:Number((candidate.score/total).toFixed(3))})).sort((a,b)=>b.score-a.score||a.kind.localeCompare(b.kind)||a.value.localeCompare(b.value));
  if(!candidates.length)continue;
  const clarificationRequired=candidates.length>1&&(candidates[0]!.score-candidates[1]!.score)<0.2;
  output.push({span:term,candidates,clarificationRequired});
 }
 return output.sort((a,b)=>a.span.localeCompare(b.span));
}

/** Keep extracted hints consistent with the chosen lexical interpretation.
 * The original product text remains intact for merchant catalog grounding.
 */
export function scopedEntityAliases(dictionary:{entity_terms:Alias[];semanticModel?:{ambiguities:SemanticAmbiguity[]}},text:string,context:SemanticContext,index?:Map<string,SemanticAmbiguity[]>):Alias[] {
 const resolved=resolveAmbiguities(dictionary,text,context,index).filter(ambiguity=>!ambiguity.clarificationRequired);
 if(!resolved.length)return dictionary.entity_terms;
 return dictionary.entity_terms.filter(alias=>{
  const ambiguity=resolved.find(candidate=>candidate.span===normalize(alias.alias));
  return !ambiguity||alias.type===ambiguity.candidates[0]!.kind&&alias.value===ambiguity.candidates[0]!.value;
 });
}

export function referenceIndexFor(dictionary:{groups:Array<{code:string;terms:string[]}>;semanticModel?:{referenceRules:ReferenceRule[]}},indexes?:Pick<SemanticIndexes,'referenceByExpression'>):Map<string,ReferenceRule[]> {
 if(indexes?.referenceByExpression.size)return indexes.referenceByExpression;
 const groups=new Map(dictionary.groups.map(group=>[group.code,group.terms]));const result=new Map<string,ReferenceRule[]>();
 for(const rule of dictionary.semanticModel?.referenceRules??[])for(const phrase of groups.get(rule.referenceGroup)??[]){const key=normalize(phrase),bucket=result.get(key)??[];bucket.push(rule);result.set(key,bucket);}
 for(const bucket of result.values())bucket.sort((a,b)=>a.precedence-b.precedence||a.code.localeCompare(b.code));
 return result;
}
