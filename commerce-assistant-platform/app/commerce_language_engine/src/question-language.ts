import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Published whole-question frames extract literal arguments, never catalog facts. */
import {utterancePhrase,knowledgeTokens,knowledgeTokenSpans,compileKnowledge,type KnowledgeIndex,type KnowledgeConcept,type LanguageKnowledgePack} from './language-knowledge.ts';
import {comparisonPhrasePattern} from './comparison-operators.ts';
import {priceAmount} from './price-language.ts';
import {shoppingDiscourse} from './utterance-language.ts';
import {relationshipSuffix} from './relationship-grammar.ts';

type QuestionMatch={intent:string;entities:Record<string,any>;ruleId:string;question?:string;missing?:string[];reason?:string};
type QuestionFrame={intent:string;ruleId:string;slots:string[];pattern:RegExp};
type QuestionIndex={frames:QuestionFrame[];leadIns:Set<string>;devices:Map<string,KnowledgeConcept|null>;knowledge?:KnowledgeIndex};
// Releases are immutable. Weak keys permit an old release and its regex/index
// allocations to be collected after a new compiled release replaces it.
const indexes=()=>recognitionMemo('question-language.indexes',()=>new WeakMap<LanguageKnowledgePack,QuestionIndex>());
const escape=(text:string)=>text.replace(languagePattern('question-language.escape.pattern.1'),'\\$&').replace(languagePattern('question-language.escape.pattern.2'),languageValue<string>('question-language.escape.value.1')).replace(languagePattern('question-language.escape.pattern.3'),"['’]");
function questionIndex(pack:LanguageKnowledgePack):QuestionIndex{
 const cached=indexes().get(pack);if(cached)return cached;
 const frames:QuestionFrame[]=[],leadIns=new Set<string>(),devices=new Map<string,KnowledgeConcept|null>();
 for(const rule of pack.utteranceRules??[])if(rule.role==='lead_in')for(const phrase of rule.phrases)leadIns.add(utterancePhrase(phrase));
 for(const concept of pack.concepts)if(concept.kind==='device')for(const alias of [concept.canonical,...concept.aliases]){
  const key=knowledgeTokens(alias).join(' '),previous=devices.get(key);
  devices.set(key,previous===undefined||previous?.id===concept.id?concept:null);
 }
 for(const rule of pack.questionRules??[])for(const template of rule.templates){
  const slots:string[]=[];let pattern='',at=0;
  for(const token of template.matchAll(languagePattern('question-language.questionIndex.pattern.1'))){
   pattern+=escape(template.slice(at,token.index));slots.push(token[1]);
   pattern+=token[1]===languageValue<string>('question-language.questionIndex.value.1')?'([1-9][0-9]{0,4})':token[1]===languageValue<string>('question-language.questionIndex.value.2')?'(today|tomorrow)':'(.+?)';at=token.index!+token[0].length;
  }
  pattern+=escape(template.slice(at));
  frames.push({intent:rule.intent,ruleId:rule.id,slots,pattern:new RegExp('^'+pattern+'$','id')});
 }
 const result={frames,leadIns,devices};indexes().set(pack,result);return result;
}
// English alias matching must not erase an unrecognized word or script. Literal
// product slots do not use this normalization and retain Unicode merchant names.
const preservesAliasWords=(text:string)=>!languagePattern('question-language.preservesAliasWords.pattern.1').test(text.replace(languagePattern('question-language.preservesAliasWords.pattern.2'),''))&&![...text.matchAll(languagePattern('question-language.preservesAliasWords.pattern.3'))].some(match=>!knowledgeTokens(match[0]).length);
export function questionLeadIn(pack:LanguageKnowledgePack|undefined,text:string):string|undefined {
 const match=languagePattern('question-language.match.pattern.1').exec(text);
 if(pack&&match&&languagePattern('question-language.questionLeadIn.pattern.1').test(match[1])&&preservesAliasWords(match[1])&&questionIndex(pack).leadIns.has(utterancePhrase(match[1])))return match[2];
}
const priceQualifier=()=>recognitionMemo('question-language.priceQualifier',()=>(new RegExp(languageValue<string>('question-language.priceQualifier.value.1')+comparisonPhrasePattern()+languageValue<string>('question-language.priceQualifier.value.2')+priceAmount(),'i')));
function product(text:string):boolean {
 // Keep merchant punctuation and numerals. Clause operators cannot hide inside
 // a product slot and become a read for only the surviving noun phrase.
 return !!text&&text.length<=180&&languagePattern('question-language.product.pattern.1').test(text)&&!languagePattern('question-language.product.pattern.2').test(text)&&
  !languagePattern('question-language.product.pattern.3').test(text)&&
  !languagePattern('question-language.product.pattern.4').test(text)&&!priceQualifier().test(text)&&
  !languagePattern('question-language.product.pattern.5').test(text)&&
  !languagePattern('question-language.product.pattern.6').test(text);
}
export function questionRead(pack:LanguageKnowledgePack|undefined,message:string):QuestionMatch|undefined {
 let text=message.trim().replace(languagePattern('question-language.text.pattern.1'),'').replace(languagePattern('question-language.text.pattern.2'),'').trim();
 if(!pack?.questionRules?.length||text.length>1500||languagePattern('question-language.questionRead.pattern.1').test(text))return;
 const index=questionIndex(pack);
 // Only reviewed whole sentences may surround a delivery question. Keep the
 // original contiguous source slice; never discard an extra substantive clause.
 const discourse=languagePattern('question-language.discourse.pattern.1').test(message)&&pack.questionRules.some(rule=>rule.intent==='DELIVERY_DATE')?shoppingDiscourse(index.knowledge??=compileKnowledge(pack),message):undefined;
 let deliveryText=text,deliveryStart=message.indexOf(text);
 if(discourse?.remaining.length){
  const first=discourse.remaining[0],last=discourse.remaining.at(-1)!;
  if(!discourse.sentenceRoles.some(role=>role.start>[...message.slice(0,first.start)].length&&role.end<[...message.slice(0,last.end)].length)){
   const core=message.slice(first.start,last.end).replace(languagePattern('question-language.core.pattern.1'),'');
   deliveryText=core;deliveryStart=last.end-core.length;
  }
 }
 let selected:QuestionMatch|undefined,meaning:string|undefined;
 for(const frame of index.frames){
  const delivery=frame.intent==='DELIVERY_DATE';
  const match=frame.pattern.exec(delivery?deliveryText:text);if(!match)continue;
  const values=Object.fromEntries(frame.slots.map((slot,i)=>[slot,match[i+1].trim()]));
  if(!product(values.product)||values.other&&!product(values.other)||values.device&&!product(values.device))continue;
  const entities:Record<string,any>=values.other?{items:[{productText:values.product},{productText:values.other}]}:{productText:values.product};
  if(values.quantity)entities.quantity=Number(values.quantity);
  if(delivery){
   if(values.purpose&&!product(values.purpose))continue;
   entities.requestedDate=values.date.toLowerCase();
   if(values.purpose){
    entities.purposeText=values.purpose;
    const purposeSlot=frame.slots.indexOf('purpose')+1,slotStart=match.indices![purposeSlot][0]+deliveryStart;
    const marker=languagePattern('question-language.marker.pattern.1').exec(message.slice(0,slotStart));if(!marker)continue;
    const sourceStart=marker.index,source=message.slice(sourceStart,slotStart+values.purpose.length),all=knowledgeTokenSpans(source);
    const parsed=relationshipSuffix(index.knowledge??=compileKnowledge(pack),source,all,0);
    const coordinate=(at:number)=>[...message.slice(0,at)].length;
    const relations=parsed.unresolved.length?[]:parsed.hits.filter(hit=>!hit.negated).map(hit=>{
     const start=sourceStart+all[hit.start].start,end=sourceStart+all[hit.end-1].end;
     return {relation:hit.rule.relation,value:hit.concept.canonical,text:message.slice(start,end),start:coordinate(start),end:coordinate(end),negated:false,conceptId:hit.concept.id,ruleId:hit.rule.id};
    });
    entities.shoppingContext={version:1,coreText:deliveryText,relations,sentenceRoles:discourse?.sentenceRoles??[],responsePreferences:discourse?.responsePreferences??[],...(parsed.unresolved.length?{unresolved:[{text:values.purpose,start:coordinate(slotStart),end:coordinate(slotStart+values.purpose.length),reason:'unknown_phrase'}]}:{})};
   }else if(discourse?.responsePreferences.length)entities.responsePreferences=discourse.responsePreferences;
  }
  if(values.device){
   if(!preservesAliasWords(values.device))continue;
   const target=knowledgeTokens(values.device.replace(languagePattern('question-language.target.pattern.1'),'')).join(' ');
   const device=index.devices.get(target);if(!device)continue;
   // Whole question is the evidence span; no generated specification is attached.
   entities.deviceText=values.device;
   entities.evidenceRequirements=[{kind:device.metadata?.requiresExactModel===true?'device_compatibility':'named_device_compatibility',text:message,start:0,end:[...message].length}];
  }
  const current={intent:frame.intent,entities,ruleId:frame.ruleId,...(delivery?languageValue<{ question: string; missing: string[]; reason: string; }>('question-language.current.value.1'):values.device?{question:languageTemplate('question-language.current.template.1', [values.product, values.device])}:{})};
  // Disagreement fails closed immediately; retaining every match would allocate
  // per-message memory proportional to a large overlapping rule release.
  const signature=JSON.stringify({intent:current.intent,entities});
  if(meaning!==undefined&&signature!==meaning)return;
  if(!selected){selected=current;meaning=signature;}
 }
 return selected;
}
