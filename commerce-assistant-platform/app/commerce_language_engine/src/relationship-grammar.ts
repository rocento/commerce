import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Bounded noun-phrase relationships; meanings and markers come from the release. */
import {knowledgeTokens,type KnowledgeConcept,type KnowledgeIndex,type KnowledgeRule,type KnowledgeToken} from './language-knowledge.ts';

export type RelationshipHit={concept:KnowledgeConcept;rule:KnowledgeRule;start:number;end:number;negated:boolean};
export type UnresolvedRelationship={start:number;end:number;reason:'unknown_phrase'|'ambiguous_meaning';recipientAlternative?:true;ruleId?:string};
export const tokenSequence=(all:KnowledgeToken[],at:number,words:string[])=>words.every((word,i)=>all[at+i]?.value===word);
export const acceptsConcept=(rule:KnowledgeRule,concept:KnowledgeConcept)=>concept.kind===rule.targetKind&&Object.entries(rule.targetMetadata??{}).every(([key,value])=>concept.metadata?.[key]===value);
const markerIndexes=()=>recognitionMemo('relationship-grammar.markerIndexes',()=>new WeakMap<KnowledgeIndex,Map<string,{rule:KnowledgeRule;tokens:string[]}[]>>());
export function relationshipMarkers(index:KnowledgeIndex,all:KnowledgeToken[],at:number):KnowledgeRule[]{
 let markers=markerIndexes().get(index);
 if(!markers){
  markers=new Map();
  for(const rule of index.rules.filter(rule=>rule.marker!=='modifier')){
   const words=knowledgeTokens(rule.marker),bucket=markers.get(words[0])??[];
   bucket.push({rule,tokens:words});markers.set(words[0],bucket);
  }
  markerIndexes().set(index,markers);
 }
 return (markers.get(all[at]?.value)??[]).filter(entry=>tokenSequence(all,at,entry.tokens)).map(entry=>entry.rule);
}
const determiners=()=>recognitionMemo('relationship-grammar.determiners',()=>(new Set(languageValue<string[]>('relationship-grammar.determiners.value.1'))));
const possessiveDeterminers=()=>recognitionMemo('relationship-grammar.possessiveDeterminers',()=>(new Set(languageValue<string[]>('relationship-grammar.possessiveDeterminers.value.1'))));

/** A known possessive person owns an occasion/device, not necessarily the gift. */
function ownedTarget(index:KnowledgeIndex,all:KnowledgeToken[],at:number):number|undefined{
 const token=all[at]?.value;if(!token)return;
 for(const first of new Set([token,token.replace(languagePattern('relationship-grammar.ownedTarget.pattern.1'),'')]))for(const entry of index.byFirstToken.get(first)??[]){
  if(entry.concept.kind!=='person')continue;
  const last=entry.tokens.length-1;
  if(entry.tokens.every((word,i)=>all[at+i]?.value===(i===last?word+languageValue<string>('relationship-grammar.ownedTarget.value.1'):word)))return at+entry.tokens.length;
 }
}
function targets(index:KnowledgeIndex,all:KnowledgeToken[],rule:KnowledgeRule,at:number,inheritedPossessive=false):{concept:KnowledgeConcept;end:number}[]{
 if(determiners().has(all[at]?.value))at++;
 if(rule.targetPossessive&&!possessiveDeterminers().has(all[at]?.value)&&!inheritedPossessive)return [];
 if(possessiveDeterminers().has(all[at]?.value)){
  // Possessives describe people/devices and named occasions ("my birthday").
  if(!languageValue<string[]>('relationship-grammar.targets.value.1').includes(rule.targetKind))return [];
  at++;
 }
 const positions=[at];
 if(languageValue<string[]>('relationship-grammar.targets.value.2').includes(rule.targetKind)){
  const owned=ownedTarget(index,all,at);if(owned!==undefined)positions.push(owned);
 }
 return positions.flatMap(position=>(index.byFirstToken.get(all[position]?.value)??[])
  .filter(entry=>acceptsConcept(rule,entry.concept)&&tokenSequence(all,position,entry.tokens))
  .map(entry=>({concept:entry.concept,end:position+entry.tokens.length})));
}

/**
 * Parse every remaining token. Conjunctions inherit a published preposition,
 * never its guessed meaning: "for mother and gaming" has two different roles.
 * An unrecognized or ambiguous tail stays literal and stops the parse.
 */
export function relationshipSuffix(index:KnowledgeIndex,source:string,all:KnowledgeToken[],start:number):{hits:RelationshipHit[];unresolved:UnresolvedRelationship[]}{
 const hits:RelationshipHit[]=[],unresolved:UnresolvedRelationship[]=[];
 const markerAt=(at:number)=>relationshipMarkers(index,all,at);
 let at=start,previous:RelationshipHit|undefined;
 const fail=(from:number,reason:UnresolvedRelationship['reason'])=>unresolved.push({start:from,end:all.length,reason});
 while(at<all.length){
  if(hits.length>=20){fail(at,'ambiguous_meaning');break;}
  const beforeNot=at>0&&all[at-1].value===languageValue<string>('relationship-grammar.beforeNot.value.1');
  const clauseStart=beforeNot?at-1:at;
  const coordinated=all[at]?.value===languageValue<string>('relationship-grammar.coordinated.value.1');
  if(coordinated)at++;
  let negated=beforeNot;
  if(all[at]?.value===languageValue<string>('relationship-grammar.relationshipSuffix.value.1')){negated=true;at++;}
  const explicit=markerAt(at);
  // A relative clause has a person antecedent, never an arbitrary product or
  // earlier person hidden inside a possessive device/occasion noun phrase.
  if(explicit.some(rule=>knowledgeTokens(rule.marker)[0]===languageValue<string>('relationship-grammar.relationshipSuffix.value.2'))&&(!previous||!languageValue<string[]>('relationship-grammar.relationshipSuffix.value.3').includes(previous.rule.relation)||previous.negated)){
   fail(clauseStart,'ambiguous_meaning');break;
  }
  const inherited=coordinated&&!explicit.length&&previous&&(!previous.negated||previous.rule.negated)&&!negated;
  const rules=inherited?index.rules.filter(rule=>rule.marker===previous!.rule.marker):explicit;
  const choices:RelationshipHit[]=[];
  for(const rule of rules){
   if(negated&&rule.negated)continue; // "not without" has unresolved scope.
   const target=at+(inherited?0:knowledgeTokens(rule.marker).length);
   for(const candidate of targets(index,all,rule,target,!!inherited&&previous?.rule.targetPossessive===true)){
    const end=candidate.end;
    const next=all[end]?.value===languageValue<string>('relationship-grammar.next.value.1')?end+1:end;
    if(end<all.length&&!markerAt(next).length&&all[end]?.value!==languageValue<string>('relationship-grammar.relationshipSuffix.value.4')&&!(rule.clarifyAlternatives&&all[end]?.value===languageValue<string>('relationship-grammar.relationshipSuffix.value.5')))continue;
    choices.push({...candidate,rule,start:clauseStart,negated:negated||rule.negated===true});
   }
  }
  const longest=choices.length?Math.max(...choices.map(hit=>hit.end)):0;
  const complete=choices.filter(hit=>hit.end===longest);
  const highest=complete.length?Math.max(...complete.map(hit=>hit.rule.priority)):0;
  const candidates=complete.filter(hit=>hit.rule.priority===highest);
  if(new Set(candidates.map(hit=>`${hit.rule.relation}:${hit.concept.id}`)).size!==1){
   fail(clauseStart,candidates.length?'ambiguous_meaning':'unknown_phrase');break;
  }
  const best=candidates.sort((a,b)=>a.rule.id.localeCompare(b.rule.id))[0];
  if(best.rule.clarifyAlternatives&&all[best.end]?.value===languageValue<string>('relationship-grammar.relationshipSuffix.value.6')){
   unresolved.push({start:clauseStart,end:all.length,reason:'ambiguous_meaning',recipientAlternative:true,ruleId:best.rule.id});break;
  }
  const targetText=source.slice(all[best.end-1].start,all[best.end-1].end);
  const ambiguousShort=best.concept.kind==='country'&&best.concept.metadata?.requiresContext===true&&languagePattern('relationship-grammar.ambiguousShort.pattern.1').test(targetText)&&targetText!==targetText.toUpperCase();
  const ambiguousCountry=best.concept.kind==='country'&&best.concept.metadata?.ambiguous===true&&languageValue<string[]>('relationship-grammar.ambiguousCountry.value.1').includes(best.rule.marker);
  if(ambiguousShort||ambiguousCountry){fail(clauseStart,'ambiguous_meaning');break;}
  hits.push(best);previous=best;at=best.end;
  if(best.rule.requiresClarification){fail(best.start,'ambiguous_meaning');break;}
 }
 return {hits,unresolved};
}
