/** Release-time matching checks, separate from catalog/answer-quality evaluation. */
import type {KnowledgeIndex,LanguageKnowledgePack} from './language-knowledge.ts';
import {contextualShoppingSearch} from './contextual-language.ts';
import {questionRead,questionLeadIn} from './question-language.ts';
import {budgetSentence,recommendationReferenceFollowup,shoppingDiscourse} from './utterance-language.ts';

export function validateRuleExamples(pack:LanguageKnowledgePack,index:KnowledgeIndex){
 for(const row of pack.ruleGovernance??[]){
  const utterance=index.utteranceRules.find(rule=>rule.id===row.ruleId);
  const matches=(text:string):boolean=>{
   if(row.family==='relationship'){const meaning=contextualShoppingSearch(index,text);return !!meaning?.relations.some(hit=>hit.ruleId===row.ruleId)||meaning?.clarificationEvidence?.ruleId===row.ruleId;}
   if(row.family==='budget')return contextualShoppingSearch(index,text)?.budgetEvidence?.ruleId===row.ruleId;
   if(row.family==='question')return questionRead(pack,text)?.ruleId===row.ruleId;
   const isolated={...index,utteranceRules:utterance?[utterance]:[]};
   if(utterance?.role==='budget_update')return !!budgetSentence(isolated,text);
   if(utterance?.role==='recommendation_followup')return !!recommendationReferenceFollowup(isolated,text);
   if(utterance?.role==='lead_in')return !!questionLeadIn({...pack,utteranceRules:[utterance]},text);
   return !!shoppingDiscourse(index,text)?.sentenceRoles.some(hit=>hit.ruleId===row.ruleId);
  };
  for(const text of row.examples)if(!matches(text))throw new Error('Positive rule example failed: '+row.ruleId+' / '+text);
  for(const text of row.counterexamples)if(matches(text))throw new Error('Rule counterexample matched: '+row.ruleId+' / '+text);
 }
}
