import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Whole-sentence roles from the published knowledge pack; no partial matching. */
import {utterancePhrase,knowledgeTokenSpans,knowledgeTokens,type KnowledgeIndex,type ResponsePreference} from './language-knowledge.ts';
import {correctionPrice} from './correction-numbers.ts';
export type SentenceRole={role:'background'|'search_prompt'|'response_preference';text:string;start:number;end:number;ruleId:string};
type Span={text:string;start:number;end:number};
export type ShoppingUtterance={search:Span;budget?:Span&{price:string};sentenceRoles:SentenceRole[];responsePreferences:ResponsePreference[]};
const unsafeText=(text:string)=>languagePattern('utterance-language.unsafeText.pattern.1').test(text)||languagePattern('utterance-language.unsafeText.pattern.2').test(text);
const coordinate=(text:string,index:number)=>[...text.slice(0,index)].length;
function span(text:string,start:number,end:number):Span{
 while(start<end&&languagePattern('utterance-language.span.pattern.1').test(text[start]))start++;
 while(end>start&&languagePattern('utterance-language.span.pattern.2').test(text[end-1]))end--;
 return {text:text.slice(start,end),start,end};
}
/** Offsets here are JS offsets for direct slicing; emitted role offsets are Unicode code points. */
export function shoppingDiscourse(index:KnowledgeIndex|undefined,text:string):{remaining:Span[];sentenceRoles:SentenceRole[];responsePreferences:ResponsePreference[]}|undefined{
 if(!index||text.length>1500||unsafeText(text))return;
 const all=knowledgeTokenSpans(text),protectedSpans:[number,number][]=[];
 for(let at=0;at<all.length;at++)for(const entry of index.byFirstToken.get(all[at].value)??[]){
  if(entry.tokens.every((token,i)=>all[at+i]?.value===token))protectedSpans.push([all[at].start,all[at+entry.tokens.length-1].end]);
 }
 const spans:Span[]=[];let start=0;
 for(const match of text.matchAll(languagePattern('utterance-language.shoppingDiscourse.pattern.1'))){
  if(match[0]==='.'&&(protectedSpans.some(([from,to])=>match.index!>=from&&match.index!<to)||languagePattern('utterance-language.shoppingDiscourse.pattern.2').test(text.slice(0,match.index))&&languagePattern('utterance-language.shoppingDiscourse.pattern.3').test(text.slice(match.index!+1))))continue;
  const next=span(text,start,match.index!);if(next.text)spans.push(next);
  start=match.index!+match[0].length;
 }
 const last=span(text,start,text.length);if(last.text)spans.push(last);
 const roles:SentenceRole[]=[],preferences=new Set<ResponsePreference>(),remaining:Span[]=[];
 for(const part of spans){
  // Normalization must not erase a price, emoji, quoted phrase or operator and
  // accidentally make unreviewed content match a harmless sentence.
  const value=languagePattern('utterance-language.value.pattern.1').test(part.text)&&![...part.text.matchAll(languagePattern('utterance-language.value.pattern.2'))].some(match=>!knowledgeTokens(match[0]).length)?utterancePhrase(part.text):'';
  const rule=value?index.utteranceRules.find(rule=>languageValue<string[]>('utterance-language.rule.value.1').includes(rule.role)&&rule.phrases.some(p=>utterancePhrase(p)===value)):undefined;
  if(!rule){remaining.push(part);continue;}
  roles.push({role:rule.role as SentenceRole['role'],text:part.text,start:coordinate(text,part.start),end:coordinate(text,part.end),ruleId:rule.id});
  if(rule.preference)preferences.add(rule.preference);
 }
 return {remaining,sentenceRoles:roles,responsePreferences:[...preferences]};
}
export function shoppingUtterance(index:KnowledgeIndex|undefined,text:string):ShoppingUtterance|undefined{
 const parsed=shoppingDiscourse(index,text);if(!parsed)return;
 const {remaining,...roles}=parsed;
 // A complete published monetary sentence can qualify one complete search.
 // Keep its original span separate: no words or source offsets are fabricated.
 const budgets=remaining.map(part=>({part,price:budgetSentence(index,part.text)})).filter(row=>row.price);
 if(budgets.length===1&&remaining.length===2){
  const budget=budgets[0];
  return {search:remaining.find(part=>part!==budget.part)!,budget:{...budget.part,price:budget.price!},...roles};
 }
 // With no reviewed roles the legacy parser sees the original complete input.
 if(!roles.sentenceRoles.length)return {search:span(text,0,text.length),sentenceRoles:[],responsePreferences:[]};
 if(remaining.length!==1)return;
 return {search:remaining[0],...roles};
}
/** Reviewed prompts and preferences reuse a proven prior search; never invent one. */
export function shoppingResponseFollowup(index:KnowledgeIndex|undefined,text:string):SentenceRole[]|undefined{
 const parsed=shoppingDiscourse(index,text);
 if(!parsed||parsed.remaining.length||!parsed.sentenceRoles.some(role=>role.role==='search_prompt'||role.role==='response_preference'))return;
 return parsed.sentenceRoles;
}
/** Whole reviewed recommendation replies authorize identity lookup, never an inferred SKU. */
export function recommendationReferenceFollowup(index:KnowledgeIndex|undefined,text:string):'FIRST'|undefined{
 if(!index||text.length>500||unsafeText(text)||!languagePattern('utterance-language.recommendationReferenceFollowup.pattern.1').test(text))return;
 const normalized=utterancePhrase(text);
 return index.utteranceRules.find(rule=>rule.role==='recommendation_followup'&&rule.phrases.some(phrase=>utterancePhrase(phrase)===normalized))?.reference;
}
/** A complete published budget phrase, with its entire amount slot validated. */
export function budgetSentence(index:KnowledgeIndex|undefined,text:string):string|undefined{
 if(!index||unsafeText(text)||!languagePattern('utterance-language.budgetSentence.pattern.1').test(text)||[...text.matchAll(languagePattern('utterance-language.budgetSentence.pattern.2'))].some(match=>!knowledgeTokens(match[0]).length))return;
 const source=utterancePhrase(text).replace(languagePattern('utterance-language.source.pattern.1'),'');
 const escape=(value:string)=>value.replace(languagePattern('utterance-language.escape.pattern.1'),'\\$&');
 for(const rule of index.utteranceRules.filter(rule=>rule.role==='budget_update'))for(const template of rule.phrases){
  const normalized=utterancePhrase(template.replace(languageValue<string>('utterance-language.normalized.value.1'),languageValue<string>('utterance-language.normalized.value.2')));
  const [before,after]=normalized.split('amountslot');
  const match=new RegExp('^'+escape(before)+'(.+?)'+escape(after)+'$').exec(source);
  if(match){const price=correctionPrice(languageValue<string>('utterance-language.price.value.1')+match[1]);if(price)return price;}
 }
}
/** A budget edit consumes one entire sentence plus reviewed conversational tails. */
export function utteranceBudgetUpdate(index:KnowledgeIndex|undefined,text:string):string|undefined{
 const utterance=shoppingUtterance(index,text);if(!utterance||utterance.budget)return;
 return budgetSentence(index,utterance.search.text);
}
