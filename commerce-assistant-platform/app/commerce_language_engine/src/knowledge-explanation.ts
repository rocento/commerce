/** Operator diagnostics; leaves the public action/entity contract unchanged. */
import type {Compiled} from './compiler.ts';
import {resolve} from './engine.ts';
import {contextualShoppingSearch} from './contextual-language.ts';
import {questionRead} from './question-language.ts';
import {knowledgeHash} from './language-knowledge.ts';
import type {RuleFamily} from './rule-governance.ts';

export function explainKnowledge(compiled:Compiled,text:string){
 const pack=compiled.dictionary.languageKnowledge,result=resolve(compiled,text);
 const evidence:{family:RuleFamily;ruleId:string;text:string;start:number;end:number}[]=[];
 const shopping=result.entities.shoppingContext;
 for(const relation of shopping?.relations??[])evidence.push({family:'relationship',ruleId:relation.ruleId,text:relation.text,start:relation.start,end:relation.end});
 for(const role of shopping?.sentenceRoles??[])evidence.push({family:'utterance',ruleId:role.ruleId,text:role.text,start:role.start,end:role.end});
 const contextual=contextualShoppingSearch(compiled.languageKnowledge,text);
 if(result.status==='NEEDS_CONTEXT'&&shopping?.coreText===contextual?.coreText){
  if(contextual?.clarificationEvidence)evidence.push({family:'relationship',...contextual.clarificationEvidence});
  for(const relation of contextual?.relations??[])if(relation.relation==='compatibility_target')evidence.push({family:'relationship',ruleId:relation.ruleId,text:relation.text,start:relation.start,end:relation.end});
 }
 if(contextual?.budgetEvidence&&shopping?.coreText===contextual.coreText&&['<=','BETWEEN'].includes(result.entities.price?.operator??''))evidence.push({family:'budget',...contextual.budgetEvidence});
 const question=questionRead(pack,text);
 if(question?.intent===result.intent&&JSON.stringify(question.entities.productText)===JSON.stringify(result.entities.productText))evidence.push({family:'question',ruleId:question.ruleId,text,start:0,end:[...text].length});
 return {fingerprint:compiled.dictionary.generationFingerprint,pack:pack?{id:pack.id,revision:pack.revision,sha256:knowledgeHash(pack)}:null,text,result:{status:result.status,intent:result.intent,productText:result.entities.productText,price:result.entities.price},evidence:evidence.map(hit=>{
  const governance=pack?.ruleGovernance?.find(row=>row.family===hit.family&&row.ruleId===hit.ruleId);
  return {...hit,...(governance?{version:governance.version,source:governance.source,reviewStatus:governance.status,reviewMethod:governance.review?.method}:{} )};
 }),scope:'Matched knowledge-rule evidence only; does not prove catalog facts or recommendation suitability.'};
}
