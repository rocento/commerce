import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import {questionRead} from './question-language.ts';
import {compileKnowledge,type KnowledgeIndex} from './language-knowledge.ts';
import {shoppingUtterance,shoppingResponseFollowup,utteranceBudgetUpdate,type SentenceRole} from './utterance-language.ts';
import {priceTail,contextualShoppingSearch} from './contextual-language.ts';
import {purposeSearch} from './purpose-language.ts';
import {quantityPrefix} from './quantities.ts';
import {currencyCode,priceAmount} from './price-language.ts';
import {requestConstraints} from './request-constraints.ts';
import {correctionPrice,correctionQuantity} from './correction-numbers.ts';
import {comparisonDirection,comparisonPhrasePattern} from './comparison-operators.ts';
import {attributeKey,attributeNames,attributeSuffix,attributeValue,searchAttributes,type SearchAttribute,type SearchAttributes} from './search-attributes.ts';
import {lexicalConcept} from './lexical-knowledge.ts';
import type {Dictionary} from './types.ts';

type Field=string;
export type SearchUpdate={fields:Partial<Record<Field,string|number>>;price?:string;purpose?:string;explicitFields?:string[];sentenceRoles?:SentenceRole[];invalid:boolean};
const escape=(text:string)=>text.replace(languagePattern('search-updates.escape.pattern.1'),'\\$&');
const money=()=>recognitionMemo('search-updates.money',()=>(priceAmount()));
const range=()=>recognitionMemo('search-updates.range',()=>(languageValue<string>('search-updates.range.value.1')+money()+languageValue<string>('search-updates.range.value.2')+money()));
const bound=()=>recognitionMemo('search-updates.bound',()=>('(?:'+comparisonPhrasePattern()+languageValue<string>('search-updates.bound.value.1')+money()));
const pricePattern=()=>recognitionMemo('search-updates.pricePattern',()=>(new RegExp(languageValue<string>('search-updates.pricePattern.value.1')+range()+'|'+bound()+')','gi')));
const boundDirection=(text:string)=>comparisonDirection(new RegExp('^('+comparisonPhrasePattern()+languageValue<string>('search-updates.boundDirection.value.1'),'i').exec(text)?.[1]??'');

/** Consume the entire edit; never apply a recognized fragment of a longer reply. */
export function searchUpdate(dictionary:Dictionary,text:string,contextEntities:Record<string,any>={},index?:KnowledgeIndex):SearchUpdate|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 const knowledge=index??(dictionary.languageKnowledge&&compileKnowledge(dictionary.languageKnowledge));
 const responseRoles=shoppingResponseFollowup(knowledge,text);
 if(responseRoles)return {fields:{},explicitFields:[],sentenceRoles:responseRoles,invalid:false};
 const naturalBudget=utteranceBudgetUpdate(knowledge,text);
 if(naturalBudget)return {fields:{},price:naturalBudget,explicitFields:[],sentenceRoles:shoppingUtterance(knowledge,text)?.sentenceRoles,invalid:false};
 const purposeReply=languagePattern('search-updates.purposeReply.pattern.1').exec(text.trim());
 if(purposeReply){
  if(contextEntities.shoppingContext&&knowledge){
   const interpretation=contextualShoppingSearch(knowledge,languageValue<string>('search-updates.interpretation.value.1')+purposeReply[1]);
   const uses=interpretation?.relations.filter(row=>row.relation==='intended_use'&&!row.negated);
   return {fields:{},purpose:uses?.length===1?uses[0].value:undefined,invalid:!interpretation||!!interpretation.unresolved?.length||interpretation.relations.length!==1||uses?.length!==1};
  }
  const parsed=purposeSearch(dictionary,languageValue<string>('search-updates.parsed.value.1')+purposeReply[1]);
  return {fields:{},purpose:parsed?.purpose,invalid:!parsed||parsed.coreText!==languageValue<string>('search-updates.searchUpdate.value.1')};
 }
 // Bare information concepts are not correction commands (for example,
 // "material safety data sheet"). Explicit "change …" replies remain eligible.
 const phrase=normalize(text);
 if(dictionary.groups.some(group=>group.category==='OBJECT'&&group.terms.includes(phrase)))return;
 const refinement=languagePattern('search-updates.refinement.pattern.1').exec(text.trim());
 const candidate=!!refinement||new RegExp(languageValue<string>('search-updates.candidate.value.1')+attributeNames()+languageValue<string>('search-updates.candidate.value.2'),'i').test(text.trim());
 // Account, order and delivery updates never become arbitrary catalog fields.
 if(languagePattern('search-updates.searchUpdate.pattern.1').test(text.trim()))return;
 const merchantEdit=languagePattern('search-updates.merchantEdit.pattern.1').test(text.trim());
 if(!candidate&&!merchantEdit)return;
 const update:SearchUpdate={fields:Object.create(null),explicitFields:[],invalid:false};
 if(text.length>500||languagePattern('search-updates.searchUpdate.pattern.2').test(text))return {...update,invalid:true};
 let rest=(refinement?.[1]??text).toLowerCase().trim().replace(languagePattern('search-updates.rest.pattern.1'),'').replace(languagePattern('search-updates.rest.pattern.2'),'');
 rest=rest.replace(languagePattern('search-updates.searchUpdate.pattern.3'),'').replace(languagePattern('search-updates.searchUpdate.pattern.4'),'').replace(languagePattern('search-updates.searchUpdate.pattern.5'),'');
 const separator=new RegExp(languageValue<string>('search-updates.separator.value.1')+attributeNames()+languageValue<string>('search-updates.separator.value.2'),'i');
 const assign=(key:Field,value:string|number)=>{
  if(update.fields[key]!==undefined)update.invalid=true;
  update.fields[key]=value;
 };
 const setPrice=(text:string)=>{
  const price=correctionPrice(text);
  if(!price||update.price)update.invalid=true;
  else update.price=price;
 };
 for(let clause of rest.split(separator)){
  clause=clause.trim().replace(languagePattern('search-updates.searchUpdate.pattern.6'),'').replace(languagePattern('search-updates.searchUpdate.pattern.7'),'').replace(languagePattern('search-updates.searchUpdate.pattern.8'),'');
  if(!clause){update.invalid=true;continue;}
  const labeled=new RegExp('^('+attributeNames()+languageValue<string>('search-updates.labeled.value.1'),'i').exec(clause);
  if(labeled){
   const key=attributeKey(labeled[1]),value=attributeValue(dictionary,key,labeled[2]);
   if(value===undefined)update.invalid=true;
   else {assign(key,value);update.explicitFields!.push(key);}
   continue;
  }
  const merchant=merchantEdit&&languagePattern('search-updates.merchant.pattern.1').exec(clause);
  if(merchant&&!languageValue<string[]>('search-updates.searchUpdate.value.2').includes(merchant[1].trim())){
   const key=merchant[1].trim().replace(languagePattern('search-updates.key.pattern.1'),' '),value=attributeValue(dictionary,key,merchant[2]);
   if(value===undefined)update.invalid=true;
   else {assign(key,value);update.explicitFields!.push(key);}
   continue;
  }
  if(correctionPrice(clause)){setPrice(clause);continue;}
  if(languagePattern('search-updates.searchUpdate.pattern.9').test(clause)){
   const q=correctionQuantity(clause.replace(languagePattern('search-updates.q.pattern.1'),''));
   if(q===undefined)update.invalid=true;else assign('quantity',q);
   continue;
  }
  // Unlabeled values still require a known meaning. Never guess whether a new
  // merchant word denotes a color, brand, material, or the product itself.
  // A metallic value is material for a jewelry search and color elsewhere,
  // matching initial extraction. Context never adds a previously unstated value.
  const jewelry=dictionary.entity_terms.some(alias=>alias.type==='CATEGORY'&&alias.value===contextEntities.category&&alias.industry==='JEWELRY');
  const fieldOrder=jewelry?languageValue<readonly ["material", "color", "brand", "flavor"]>('search-updates.fieldOrder.value.1'):languageValue<readonly ["color", "brand", "material", "flavor"]>('search-updates.fieldOrder.value.2');
  for(const field of fieldOrder){
   const aliases=dictionary.entity_terms.filter(a=>a.type===field.toUpperCase()).sort((a,b)=>b.alias.length-a.alias.length);
   for(const alias of aliases){
    const pattern=new RegExp(languageValue<string>('search-updates.pattern.value.1')+escape(alias.alias)+languageValue<string>('search-updates.pattern.value.2'),'i');
    if(!pattern.test(clause))continue;
    assign(field,alias.value);clause=clause.replace(pattern,' ');
    if(field==='material'&&jewelry&&dictionary.entity_terms.some(other=>other.type==='COLOR'&&other.alias===alias.alias))update.explicitFields!.push(field);
   }
  }
  clause=clause.trim().replace(languagePattern('search-updates.searchUpdate.pattern.10'),'').replace(languagePattern('search-updates.searchUpdate.pattern.11'),' ');
  if(!clause)continue;
  const price=correctionPrice(clause);
  if(price){setPrice(clause);continue;}
  // Conjunctions between recognized attributes are separators, not quantities.
  if(clause===languageValue<string>('search-updates.lexical.value.1'))continue;
  const quantity=correctionQuantity(clause);
  if(quantity!==undefined)assign('quantity',quantity);else update.invalid=true;
 }
 if(!Object.keys(update.fields).length&&!update.price)update.invalid=true;
 if(refinement&&(!Object.keys(update.fields).some(field=>field!=='quantity')||update.fields.quantity!==undefined))update.invalid=true;
 return update;

 });
}

/** Rebuild only a single search; constraints remain literal and non-executable. */
export function updatedSearch(dictionary:Dictionary,text:string,entities:Record<string,any>,update:SearchUpdate,index?:KnowledgeIndex):string|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 if(update.invalid||languagePattern('search-updates.updatedSearch.pattern.1').test(text)||!entities.productText||entities.line_items||entities.items?.length>1)return;
 const knowledge=index??(dictionary.languageKnowledge&&compileKnowledge(dictionary.languageKnowledge));
 const utterance=entities.shoppingContext?shoppingUtterance(knowledge,text):undefined;
 // Work only on the verified main clause; put reviewed literal sentences back
 // afterward so their original preferences survive the next interpretation.
 const main=utterance?.search.text??text;
 const budget=entities.shoppingContext&&priceTail(main,knowledge);
 const question=questionRead(dictionary.languageKnowledge,main);
 const questionProduct=question?.intent==='PRODUCT_SEARCH'&&question.entities.productText===entities.productText?question.entities.productText:undefined;
 const source=questionProduct?languageValue<string>('search-updates.source.value.1')+questionProduct:budget?.tail?budget.body+budget.tail:main;
 const {coreText,constraints}=entities.shoppingContext?{coreText:source,constraints:[]}:requestConstraints(source);
 const attributed=searchAttributes(dictionary,coreText);
 if(attributed?.invalid)return;
 const attributes:SearchAttributes={...attributed?.fields};
 const priorPurpose=entities.shoppingContext?undefined:purposeSearch(dictionary,attributed?.coreText??coreText);
 let next=(priorPurpose?.coreText??attributed?.coreText??coreText).trim();
 let productText=String(entities.productText);
 if(update.purpose&&entities.shoppingContext){
  const prior=contextualShoppingSearch(knowledge,main);
  if(!prior||prior.unresolved?.length)return;
  // Remove only the explicit old use span, preserving recipients, other facts,
  // and prices. Coordinated dependencies need a full restatement rather than
  // a lossy rewrite of their inherited preposition.
  const uses=prior.relations.filter(r=>r.relation==='intended_use');
  if(!uses.length||uses.some(r=>r.negated)||prior.relations.some(r=>languagePattern('search-updates.updatedSearch.pattern.2').test(r.text)))return;
  const chars=[...source];
  for(const use of uses)chars.splice(use.start,use.end-use.start,...' '.repeat(use.end-use.start));
  next=chars.join('').replace(languagePattern('search-updates.updatedSearch.pattern.3'),' ').trim();
  const suffix=priceTail(next,knowledge);
  next=suffix.body+languageValue<string>('search-updates.updatedSearch.value.1')+update.purpose+suffix.tail;
 }
 if(update.price){
  const explicitCurrency=new RegExp(languageValue<string>('search-updates.explicitCurrency.value.1')+currencyCode()+languageValue<string>('search-updates.explicitCurrency.value.2'),'i').test(update.price);
  const currency=!explicitCurrency&&entities.price?.currency?' '+entities.price.currency:'';
  const direction=boundDirection(update.price);
  const changesLower=direction==='min';
  const changesUpper=direction==='max';
  const priorBounds=[...next.matchAll(pricePattern())].flatMap(match=>{
   const pair=new RegExp(languageValue<string>('search-updates.pair.value.1')+money()+languageValue<string>('search-updates.pair.value.2')+money()+')$','i').exec(match[0]);
   return pair?[languageValue<string>('search-updates.priorBounds.value.1')+pair[1].trim(),languageValue<string>('search-updates.priorBounds.value.2')+pair[2].trim()]:[match[0]];
  });
  const retained=priorBounds.filter(bound=>{
   const prior=boundDirection(bound);
   return changesUpper&&prior==='min'||changesLower&&prior==='max';
  });
  // An upper-budget edit cannot silently remove a previously stated minimum.
  const oldCurrency=entities.price?.currency??entities.currency;
  if(retained.length&&explicitCurrency&&oldCurrency){
   const declared=update.price.match(new RegExp(languageValue<string>('search-updates.declared.value.1')+currencyCode()+languageValue<string>('search-updates.declared.value.2'),'i'))?.[0];
   const mapped=declared&&({'$':'USD','€':'EUR','£':'GBP'}[declared]??declared.toUpperCase());
   if(mapped!==oldCurrency)return;
  }
  next=next.replace(pricePattern(),' ').trim().replace(languagePattern('search-updates.updatedSearch.pattern.4'),'');
  const lower=retained.length===1&&languagePattern('search-updates.lower.pattern.1').exec(retained[0]);
  const upper=languagePattern('search-updates.upper.pattern.1').exec(update.price+currency);
  next+=' '+(entities.shoppingContext&&lower&&upper?languageValue<string>('search-updates.updatedSearch.value.2')+lower[1]+languageValue<string>('search-updates.updatedSearch.value.3')+upper[1]:[...retained,update.price+currency].join(' and '));
 }
 for(const [key,value] of Object.entries(update.fields)){
  if(key==='quantity'){
   const match=languagePattern('search-updates.match.pattern.1').exec(next);
   if(!match)return;
   const tokens=match[2].split(languagePattern('search-updates.tokens.pattern.1')),q=quantityPrefix(tokens);
   next=match[1]+value+' '+tokens.slice(q.end).join(' ');continue;
  }
  const attribute=key as SearchAttribute;
  if(entities.shoppingContext&&languageValue<string[]>('search-updates.updatedSearch.value.4').includes(key)){
   const prior=contextualShoppingSearch(knowledge,next);
   const old=prior?.relations.filter(r=>r.relation===key&&!r.negated)??[];
   if(old.length){
    const meaning=lexicalConcept(knowledge,key as 'color'|'material',String(value));
    if(!meaning||prior?.unresolved?.length||prior?.relations.some(r=>languagePattern('search-updates.updatedSearch.pattern.5').test(r.text)))return;
    const chars=[...next];for(const relation of old)chars.splice(relation.start,relation.end-relation.start,...' '.repeat(relation.end-relation.start));
    const suffix=priceTail(chars.join('').replace(languagePattern('search-updates.suffix.pattern.1'),' ').trim(),knowledge);
    next=suffix.body+(key==='color'?languageValue<string>('search-updates.canonical.value.1'):languageValue<string>('search-updates.canonical.value.2'))+meaning.canonical+suffix.tail;
    delete attributes[attribute];continue;
   }
  }
  const explicit=update.explicitFields?.includes(attribute)||attributes[attribute]!==undefined;
  if(attributes[attribute]!==undefined){attributes[attribute]=String(value);continue;}
  const old=entities[key];let replaced=false;
  if(old!==undefined){
   const aliases=key==='size'?[String(old)]:dictionary.entity_terms.filter(a=>a.type===key.toUpperCase()&&a.value===old).map(a=>a.alias).sort((a,b)=>b.length-a.length);
   for(const alias of aliases){
    const pattern=new RegExp(key==='size'?languageValue<string>('search-updates.pattern.value.3')+escape(alias)+languageValue<string>('search-updates.pattern.value.4'):languageValue<string>('search-updates.pattern.value.5')+escape(alias)+languageValue<string>('search-updates.pattern.value.6'),'i');
    if(pattern.test(next)){
     next=next.replace(pattern,()=>explicit?'':key==='size'?languageValue<string>('search-updates.updatedSearch.value.5')+value:String(value));
     productText=productText.replace(pattern,()=>explicit?'':String(value)).trim();replaced=true;break;
    }
   }
   if(!replaced)return;
  }
  if(explicit){attributes[attribute]=String(value);continue;}
  if(!replaced){
   if(key==='size')next+=languageValue<string>('search-updates.updatedSearch.value.6')+value;
   else {
    const product=new RegExp(escape(productText).replace(languagePattern('search-updates.product.pattern.1'),languageValue<string>('search-updates.product.value.1')),'i');
    if(!product.test(next))return;
    next=next.replace(product,(match:string)=>String(value)+' '+match);
    productText=String(value)+' '+productText;
   }
  }
 }
 // Original qualifiers are not regenerated from a lossy interpretation.
 const purpose=entities.shoppingContext&&update.purpose?undefined:update.purpose??priorPurpose?.purpose;
 next=next.replace(languagePattern('search-updates.updatedSearch.pattern.6'),' ').trim()+(purpose?languageValue<string>('search-updates.updatedSearch.value.7')+purpose:'')+attributeSuffix(attributes);
 if(constraints.length)next+=' '+constraints.map(c=>c.text).join(' ');
 // Asking one narrowing question is a turn request. Once the shopper replies,
 // do not keep asking instead of applying the answer or the new preference.
 const priorRoles=(utterance?.sentenceRoles??[]).filter(role=>knowledge?.utteranceRules.find(rule=>rule.id===role.ruleId)?.preference!=='one_question');
 const sentenceRoles=[...new Map([...priorRoles,...(update.sentenceRoles??[])].map(role=>[role.ruleId,role])).values()];
 if(sentenceRoles.length)next+='.'+sentenceRoles.map(role=>' '+role.text+'.').join('');
 return next.length<=4000&&normalize(next)?next:undefined;

 });
}
