import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {shoppingUtterance,type SentenceRole} from './utterance-language.ts';
import type {ResponsePreference} from './language-knowledge.ts';
import {priceAmount} from './price-language.ts';
import {budgetSuffix} from './budget-rules.ts';
import {comparisonPhrasePattern} from './comparison-operators.ts';
import {evidenceRequirements} from './evidence-requirements.ts';
import {knowledgeTokenSpans as tokens,knowledgeTokens} from './language-knowledge.ts';
import type {KnowledgeIndex,KnowledgeRule} from './language-knowledge.ts';
import {acceptsConcept as allowed,tokenSequence as sequence,relationshipMarkers,relationshipSuffix,type RelationshipHit as Hit} from './relationship-grammar.ts';

export type ShoppingRelation = {
 relation:KnowledgeRule['relation'];value:string;text:string;start:number;end:number;
 negated:boolean;conceptId:string;ruleId:string;
};
export type UnresolvedShoppingPhrase = {text:string;start:number;end:number;reason:'unknown_phrase'|'ambiguous_meaning'};
export type ShoppingContext = {version:1;relations:ShoppingRelation[];coreText:string;unresolved?:UnresolvedShoppingPhrase[];sentenceRoles?:SentenceRole[];responsePreferences?:ResponsePreference[]};
export type ContextualShoppingSearch = ShoppingContext & {productText:string;question?:string;recommendation:boolean;color?:string;clarificationEvidence?:{ruleId:string;text:string;start:number;end:number};budgetEvidence?:{ruleId:string;text:string;start:number;end:number}};
type Token={value:string;start:number;end:number};

function coordinate(text:string,index:number):number {return [...text.slice(0,index)].length;}
function phrase(text:string,start:number,end:number) {return {text:text.slice(start,end),start:coordinate(text,start),end:coordinate(text,end)};}
const searchHead=()=>recognitionMemo('contextual-language.searchHead',()=>(languagePattern('contextual-language.searchHead.pattern.1')));
const otherAction=()=>recognitionMemo('contextual-language.otherAction',()=>(languagePattern('contextual-language.otherAction.pattern.1')));
// These verbs also occur in ordinary nouns ("place mats", "pop filters").
// Reserve their complete collection-write frame, not the vocabulary itself.
const collectionWrite=()=>recognitionMemo('contextual-language.collectionWrite',()=>(languagePattern('contextual-language.collectionWrite.pattern.1')));
const unsafeScope=()=>recognitionMemo('contextual-language.unsafeScope',()=>(languagePattern('contextual-language.unsafeScope.pattern.1')));
// The established broad-value read owns this complete idiom. Match before
// stripping any suffix so prices, product relations and extra actions retain
// their existing parsing; this exception never supplies an intent itself.
const broadValueRequest=()=>recognitionMemo('contextual-language.broadValueRequest',()=>(languagePattern('contextual-language.broadValueRequest.pattern.1')));

/** Remove only a complete price suffix; unknown words never disappear with it. */
export function priceTail(text:string,index?:KnowledgeIndex):{body:string;tail:string;budgetEvidence?:{ruleId:string;text:string;start:number;end:number};invalidBudget?:{text:string;start:number;end:number}} {
 if(index?.budgetRules){const match=budgetSuffix(index.budgetRules,text);if(match){const {body,tail,invalid,...budgetEvidence}=match;return {body,tail,...(invalid?{invalidBudget:budgetEvidence}:{budgetEvidence})};}}
 // Compatibility for immutable pre-governance releases only. Even an empty
 // published budget rule list disables this legacy code-owned pattern.
 const budget=index?.budgetRules?null:new RegExp(languageValue<string>('contextual-language.budget.value.1')+priceAmount()+')$','i').exec(text);
 if(budget)return {body:text.slice(0,budget.index).trimEnd(),tail:languageValue<string>('contextual-language.priceTail.value.1')+budget[1]};
 const price=new RegExp(languageValue<string>('contextual-language.price.value.1')+comparisonPhrasePattern()+languageValue<string>('contextual-language.price.value.2')+priceAmount()+languageValue<string>('contextual-language.price.value.3')+priceAmount()+languageValue<string>('contextual-language.price.value.4')+priceAmount()+')$','i').exec(text);
 if(price)return {body:text.slice(0,price.index).trimEnd(),tail:price[0]};
 // Exact money phrasing stays with the established price parser, not "for" rules.
 const exact=languagePattern('contextual-language.exact.pattern.1').exec(text);
 return exact?{body:text.slice(0,exact.index).trimEnd(),tail:exact[0]}:{body:text,tail:''};
}

/**
 * Interpret published vocabulary in a bounded product search. A relationship
 * supplies context, never intent evidence or proof of a merchant product fact.
 * Every suffix must be consumed, so "mother's iPhone" cannot become "mother".
 */
export function contextualShoppingSearch(index:KnowledgeIndex|undefined,text:string):ContextualShoppingSearch|undefined {
 if(!index||!index.rules.length||text.length>1500)return;
 const utterance=shoppingUtterance(index,text);if(!utterance)return;
 const trimmed=utterance.search.text;
 const requirements=evidenceRequirements(trimmed);
 if(languagePattern('contextual-language.contextualShoppingSearch.pattern.1').test(trimmed)||languagePattern('contextual-language.contextualShoppingSearch.pattern.2').test(trimmed)||requirements.some(row=>!['device_compatibility','named_device_compatibility'].includes(row.kind)))return;
 if(broadValueRequest().test(text))return;
 const clean=trimmed.replace(languagePattern('contextual-language.clean.pattern.1'),'').replace(languagePattern('contextual-language.clean.pattern.2'),'');
 const head=searchHead().exec(clean);
 const explicit=!!head;
 // This layer supplies relationships, never a missing action. Bare product
 // fragments and other domain questions remain owned by established routes.
 if(!explicit)return;
 const bodyStart=utterance.search.start+(head?.[0].length??0);
 const price=priceTail(clean.slice(head?.[0].length??0),index);
 // Two separately stated limits need their own intersection/correction logic;
 // neither can silently replace the other in a contextual rewrite.
 if(utterance.budget&&price.tail)return;
 if(utterance.budget)price.tail=' '+utterance.budget.price;
 const body=price.body;
 if(collectionWrite().test(body))return;
 // Published relationship markers may contain otherwise reserved words (for
 // example 'compatible with'); their complete literal spans own those words.
 const scopeTokens=tokens(body),scopeChars=body.split('');
 for(let at=0;at<scopeTokens.length;at++)for(const rule of relationshipMarkers(index,scopeTokens,at)){
  const markerEnd=scopeTokens[at+knowledgeTokens(rule.marker).length-1].end;
  for(let offset=scopeTokens[at].start;offset<markerEnd;offset++)scopeChars[offset]=' ';
 }
 const scopeBody=scopeChars.join('');
 const newComposition=scopeTokens.some((_,at)=>relationshipMarkers(index,scopeTokens,at).some(r=>r.targetKind==='material'||r.negated||r.requiresClarification));
 const personAlternatives=scopeTokens.some(t=>t.value===languageValue<string>('contextual-language.personAlternatives.value.1'))&&scopeTokens.some((_,at)=>relationshipMarkers(index,scopeTokens,at).some(r=>r.clarifyAlternatives));
 if(!body||!newComposition&&(otherAction().test(scopeBody)||unsafeScope().test(personAlternatives?scopeBody.replace(languagePattern('contextual-language.contextualShoppingSearch.pattern.3'),' '):scopeBody))||languagePattern('contextual-language.contextualShoppingSearch.pattern.4').test(body))return;
 // No inferred search may turn another sentence, a pronoun, or a negated
 // command into a product request. A bare entity is never a command either.
 if(!explicit&&languagePattern('contextual-language.contextualShoppingSearch.pattern.5').test(body))return;
 const all=tokens(body);if(!all.length||[...body.matchAll(languagePattern('contextual-language.contextualShoppingSearch.pattern.6'))].some(match=>!knowledgeTokens(match[0]).length))return;
 const markerAt=(at:number)=>relationshipMarkers(index,all,at);
 // A multiword marker owns its complete phrase before a shorter overlapping one.
 let boundary=-1;
 for(let at=1;at<all.length;at++)if(markerAt(at).length){boundary=at;break;}
 const relations:ShoppingRelation[]=[];
 const unresolved:UnresolvedShoppingPhrase[]=[];
 let clarificationEvidence:ContextualShoppingSearch['clarificationEvidence'];
 if(price.invalidBudget)unresolved.push({...phrase(text,bodyStart+price.invalidBudget.start,bodyStart+price.invalidBudget.end),reason:'ambiguous_meaning'});
 const sourceHit=(hit:Hit)=>{
  const start=bodyStart+all[hit.start].start,end=bodyStart+all[hit.end-1].end;
  relations.push({relation:hit.rule.relation,value:hit.concept.canonical,...phrase(text,start,end),negated:hit.negated,conceptId:hit.concept.id,ruleId:hit.rule.id});
 };
 let productEnd=boundary<0?body.length:all[boundary].start;
 if(boundary>0&&all[boundary-1].value===languageValue<string>('contextual-language.contextualShoppingSearch.value.1'))productEnd=all[boundary-1].start;
 const unknown=(start:number,end:number,reason:UnresolvedShoppingPhrase['reason'])=>unresolved.push({...phrase(text,bodyStart+all[start].start,bodyStart+all[end-1].end),reason});
 if(boundary>=0){
  const suffix=relationshipSuffix(index,body,all,boundary);
  for(const hit of suffix.hits)sourceHit(hit);
  for(const row of suffix.unresolved){unknown(row.start,row.end,row.reason);if(row.recipientAlternative&&row.ruleId)clarificationEvidence={ruleId:row.ruleId,...phrase(text,bodyStart+all[row.start].start,bodyStart+all[row.end-1].end)};}
 }
 let product=body.slice(0,productEnd).trim().replace(languagePattern('contextual-language.product.pattern.1'),'');
 let productOffset=body.indexOf(product);
 // Prefix modifiers are restricted to an explicit read command and a remaining
 // product noun. Ambiguous dictionary terms require an explicit relation phrase.
 if(explicit){
  let prefix=tokens(product),consumed=0;
  while(prefix.length>consumed+1){
   const choices:Hit[]=[];
   for(const rule of index.rules.filter(rule=>rule.marker==='modifier'&&rule.scope==='product')){
    for(const entry of index.byFirstToken.get(prefix[consumed].value)??[]){
     if(!allowed(rule,entry.concept)||entry.concept.metadata?.ambiguous===true||entry.concept.metadata?.requiresContext===true||!sequence(prefix,consumed,entry.tokens))continue;
     if(consumed+entry.tokens.length>=prefix.length)continue;
     choices.push({concept:entry.concept,rule,start:consumed,end:consumed+entry.tokens.length,negated:false});
    }
   }
   if(!choices.length)break;
   const highest=Math.max(...choices.map(hit=>hit.rule.priority));
   const candidates=choices.filter(hit=>hit.rule.priority===highest);
   if(new Set(candidates.map(hit=>`${hit.rule.relation}:${hit.concept.id}`)).size!==1)break;
   const hit=candidates.sort((a,b)=>b.end-a.end)[0];
   const start=bodyStart+productOffset+prefix[hit.start].start,end=bodyStart+productOffset+prefix[hit.end-1].end;
   relations.unshift({relation:hit.rule.relation,value:hit.concept.canonical,...phrase(text,start,end),negated:false,conceptId:hit.concept.id,ruleId:hit.rule.id});
   consumed=hit.end;
  }
  if(consumed)product=product.slice(prefix[consumed].start);
 }
 if(!product||languagePattern('contextual-language.contextualShoppingSearch.pattern.7').test(product)||languagePattern('contextual-language.contextualShoppingSearch.pattern.8').test(product)||languagePattern('contextual-language.contextualShoppingSearch.pattern.9').test(product))return;
 if(!relations.length&&!unresolved.length&&!utterance.sentenceRoles.length&&!utterance.budget)return;
 // A rejected device cannot become a positive compatibility requirement. Keep
 // the original exclusion literal and ask which target was actually intended.
 const rejectedDevice=relations.find(relation=>relation.relation==='compatibility_target'&&relation.negated);
 if(rejectedDevice&&!unresolved.length)unresolved.push({text:rejectedDevice.text,start:rejectedDevice.start,end:rejectedDevice.end,reason:'ambiguous_meaning'});
 // Existing generic compatibility evidence owns unreviewed device names. Only
 // a complete published device match may replace that established fallback.
 const deviceClarification=relations.find(r=>r.relation==='compatibility_target'&&!r.negated&&index.rules.some(rule=>rule.id===r.ruleId&&rule.requiresClarification&&rule.marker!==languageValue<string>('contextual-language.lexical.value.2')));
 const deviceNeedsModel=deviceClarification&&(index.byFirstToken.get(knowledgeTokens(deviceClarification.value)[0])??[]).some(({concept})=>concept.id===deviceClarification.conceptId&&concept.metadata?.requiresExactModel===true);
 if(requirements.length&&(unresolved.length&&!rejectedDevice&&!deviceClarification||!relations.some(relation=>relation.relation==='compatibility_target')))return;
 const coreText=(languageValue<string>('contextual-language.coreText.value.1')+product+price.tail).trim();
 const colorValues=new Set(relations.filter(r=>r.relation==='color'&&!r.negated).map(r=>r.value));
 const materialValues=new Set(relations.filter(r=>r.relation==='material'&&!r.negated).map(r=>r.value));
 const contradiction=relations.find(relation=>relations.some(other=>other.relation===relation.relation&&other.conceptId===relation.conceptId&&other.negated!==relation.negated));
 if((colorValues.size>1||materialValues.size>1||contradiction)&&!unresolved.length){
  const conflict=contradiction??relations.find(r=>r.relation===(colorValues.size>1?'color':'material'))!;
  unresolved.push({text:conflict.text,start:conflict.start,end:conflict.end,reason:'ambiguous_meaning'});
 }
 const question=rejectedDevice?languageTemplate('contextual-language.question.template.1', [rejectedDevice.text.slice(0,160)]):clarificationEvidence?languageTemplate('contextual-language.question.template.2', [clarificationEvidence.text.slice(0,160)]):deviceClarification?deviceNeedsModel?languageTemplate('contextual-language.question.template.3', [deviceClarification.value]):languageTemplate('contextual-language.question.template.4', [deviceClarification.value]):unresolved.length?languageTemplate('contextual-language.question.template.5', [unresolved[0].text.slice(0,160)]):undefined;
 return {version:1,coreText,productText:product,...(clarificationEvidence?{clarificationEvidence}:{}),...(price.budgetEvidence?{budgetEvidence:{ruleId:price.budgetEvidence.ruleId,...phrase(text,bodyStart+price.budgetEvidence.start,bodyStart+price.budgetEvidence.end)}}:{}),...(utterance.sentenceRoles.length?{sentenceRoles:utterance.sentenceRoles,responsePreferences:utterance.responsePreferences}:{}),relations:relations.sort((a,b)=>a.start-b.start),...(unresolved.length?{unresolved,question}:{}),recommendation:languagePattern('contextual-language.contextualShoppingSearch.pattern.10').test(head?.[0]??'')||utterance.sentenceRoles.some(role=>role.role==='search_prompt'&&languagePattern('contextual-language.contextualShoppingSearch.pattern.11').test(role.text)),...(colorValues.size===1?{color:[...colorValues][0]}:{})};
}
