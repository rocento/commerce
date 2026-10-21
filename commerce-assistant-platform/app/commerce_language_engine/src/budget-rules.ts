import {recognitionMemo} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Literal templates and one bounded MONEY slot. Data never becomes executable regex. */
import {priceAmount,capturedPriceAmount,priceCurrency} from './price-language.ts';

export type BudgetRule={id:string;templates:string[];priority:number;output:'maximum_price'|'price_range';scope:'product'};
export type BudgetMatch={body:string;tail:string;ruleId:string;text:string;start:number;end:number;invalid?:true};
const escape=(text:string)=>text.replace(languagePattern('budget-rules.escape.pattern.1'),'\\$&').replace(languagePattern('budget-rules.escape.pattern.2'),languageValue<string>('budget-rules.escape.value.1'));
const compiled=()=>recognitionMemo('budget-rules.compiled',()=>new WeakMap<BudgetRule[],{rule:BudgetRule;pattern:RegExp}[]>());
export function validateBudgetRules(input:unknown):asserts input is BudgetRule[]{
 if(!Array.isArray(input)||input.length>32)throw new Error('Invalid budget rules: maximum 32');
 const ids=new Set<string>(),templates=new Set<string>();let count=0;
 for(const r of input){
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='id,output,priority,scope,templates'||typeof r.id!=='string'||!languagePattern('budget-rules.validateBudgetRules.pattern.1').test(r.id)||ids.has(r.id)||!['maximum_price','price_range'].includes(r.output)||r.scope!=='product'||!Number.isInteger(r.priority)||r.priority<0||r.priority>10000||!Array.isArray(r.templates)||!r.templates.length||r.templates.length>100)throw new Error('Invalid budget rule');
  ids.add(r.id);
  for(const template of r.templates){
   // Deliberately narrow first migration: budget/limit noun, optional owner and copula.
   // Arbitrary verbs, slot names, quantifiers, captures and optional syntax are rejected.
   const syntax=r.output==='price_range'?languagePattern('budget-rules.syntax.pattern.1'):languagePattern('budget-rules.syntax.pattern.2');
   if(typeof template!=='string'||template.length>100||!syntax.test(template))throw new Error(languageValue<string>('budget-rules.validateBudgetRules.value.1')+template);
   if(templates.has(template))throw new Error(languageValue<string>('budget-rules.validateBudgetRules.value.2')+template);
   templates.add(template);if(++count>100)throw new Error('Too many budget templates');
  }
 }
}
export function budgetSuffix(rules:BudgetRule[],text:string):BudgetMatch|undefined{
 if(text.length>1500)return;
 let frames=compiled().get(rules);
 if(!frames){frames=rules.flatMap(rule=>rule.templates.map(template=>({rule,pattern:new RegExp(languageValue<string>('budget-rules.budgetSuffix.value.1')+template.split(languagePattern('budget-rules.budgetSuffix.pattern.1')).map(escape).join('('+priceAmount()+')')+'$','i')})));compiled().set(rules,frames);}
 const matches=frames.flatMap(({rule,pattern})=>{const hit=pattern.exec(text);return hit?[{rule,hit}]:[];});
 if(!matches.length)return;
 // Overlapping literal suffixes ("limit" / "my limit") prefer the longest span.
 // Equal-ranked conflicting interpretations are rejected, never chosen by storage order.
 matches.sort((a,b)=>a.hit.index-b.hit.index||b.rule.priority-a.rule.priority||a.rule.id.localeCompare(b.rule.id));
 const best=matches[0],body=text.slice(0,best.hit.index).trimEnd();
 if(!body||languagePattern('budget-rules.budgetSuffix.pattern.2').test(body))return;
 if(matches.some(other=>other.hit.index===best.hit.index&&other.rule.priority===best.rule.priority&&other.rule.id!==best.rule.id))return;
 const start=best.hit.index+best.hit[0].search(languagePattern('budget-rules.start.pattern.1')),end=text.length;
 if(best.rule.output==='price_range'){
  const parse=(s:string)=>{const m=new RegExp('^'+capturedPriceAmount()+'$','i').exec(s.trim());if(!m)return;const a=priceCurrency(m[1]),b=priceCurrency(m[3]);if(a&&b&&a!==b)return;return {value:Number(m[2].replaceAll(',','')),currency:a??b};};
  const low=parse(best.hit[1]),high=parse(best.hit[2]);
  if(!low||!high||low.value>high.value||low.currency&&high.currency&&low.currency!==high.currency)return {body,tail:'',ruleId:best.rule.id,text:text.slice(start,end),start,end,invalid:true};
 }
 const tail=best.rule.output==='price_range'?languageValue<string>('budget-rules.tail.value.1')+best.hit[1]+languageValue<string>('budget-rules.tail.value.2')+best.hit[2]:languageValue<string>('budget-rules.tail.value.3')+best.hit[1];
 return {body,tail,ruleId:best.rule.id,text:text.slice(start,end),start,end};
}
