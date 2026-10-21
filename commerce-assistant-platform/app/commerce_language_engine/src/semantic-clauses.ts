import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import type {Dictionary} from './types.ts';
import type {Clause} from './semantic-types.ts';
import {scopedTokenCorrections} from './language-corrections.ts';
import {searchCommandCorrections} from './search-language.ts';

export type Token = {value: string; start: number; end: number; quoted?:boolean};
export type ActionClause = Clause & {argument: Token[]};
export function tokenize(text: string): Token[] {
  const searchCorrections=[...searchCommandCorrections(text),...scopedTokenCorrections(text)];
  return [...text.matchAll(languagePattern('semantic-clauses.tokenize.pattern.1'))]
    .map(m => {const raw=m[0].toLowerCase().replace(languagePattern('semantic-clauses.raw.pattern.1'),'').replace(languagePattern('semantic-clauses.raw.pattern.2'),'-');const correction=searchCorrections.find(c=>c.start===m.index&&c.end===m.index!+m[0].length);return {value:correction?.to??raw,start:m.index!,end:m.index!+m[0].length,...(m[0].startsWith('"')?languageValue<{ quoted: true; }>('semantic-clauses.tokenize.value.1'):{})};});
}
/** Skip only a complete affirmative wrapper, never a negation or condition. */
export function affirmativeWrapperEnd(tokens:Token[],p:number):number {
  if(tokens[p]?.quoted)return p;
  const prefix=tokens.slice(p,p+7).map(token=>token.value).join(' ');
  const wrapper=languagePattern('semantic-clauses.wrapper.pattern.1').exec(prefix);
  if(!wrapper)return p;
  const end=p+wrapper[0].split(' ').length;
  return tokens.slice(p,end).some(token=>token.quoted)?p:end;
}
const fillers = ()=>recognitionMemo('semantic-clauses.fillers',()=>(new Set(languageValue<string[]>('semantic-clauses.fillers.value.1'))));
const articles = ()=>recognitionMemo('semantic-clauses.articles',()=>(new Set(languageValue<string[]>('semantic-clauses.articles.value.1'))));
type Head = {intent:string; end:number};
function head(tokens:Token[], p:number, dictionary:Dictionary): Head|null {
  const at=(s:string) => s.split(' ').every((v,j)=>tokens[p+j]?.value===v);
  const remainder=tokens.slice(p).map(token=>token.value).join(' ');
  if(languagePattern('semantic-clauses.head.pattern.1').test(remainder)||languagePattern('semantic-clauses.head.pattern.2').test(remainder))return {intent:'REORDER',end:p+1};
  const priorPurchase=tokens.length-p<=14&&(languagePattern('semantic-clauses.priorPurchase.pattern.1').test(remainder)||languagePattern('semantic-clauses.priorPurchase.pattern.2').test(remainder));
  if(priorPurchase)return {intent:'REORDER',end:p+1};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.1')) if(at(phrase)) return {intent:'START_CHECKOUT',end:p+phrase.split(' ').length};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.2'))if(at(phrase))return {intent:'REORDER',end:p+phrase.split(' ').length};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.3'))if(at(phrase))return {intent:'REORDER',end:p+phrase.split(' ').length};
  if(languageValue<string[]>('semantic-clauses.head.value.4').includes(tokens[p]?.value)&&tokens.slice(p+1,p+5).some(token=>token.value===languageValue<string>('semantic-clauses.head.value.5'))&&tokens.slice(p+1,p+7).some(token=>languageValue<string[]>('semantic-clauses.head.value.6').includes(token.value))&&tokens.slice(p+1).some(token=>languageValue<string[]>('semantic-clauses.head.value.7').includes(token.value)))return {intent:'REORDER',end:p+1};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.8'))if(at(phrase))return {intent:'REORDER',end:p+phrase.split(' ').length};
  if(at(languageValue<string>('semantic-clauses.head.value.9')))return {intent:'REORDER',end:p+5};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.10')) if(at(phrase)) return {intent:'SELECT_DELIVERY_SLOT',end:p+phrase.split(' ').length};
  if(at(languageValue<string>('semantic-clauses.head.value.11'))||at(languageValue<string>('semantic-clauses.head.value.12'))){
    if(languageValue<string[]>('semantic-clauses.head.value.13').includes(tokens[p+1]?.value))return null;
    return {intent:'PRODUCT_COMPARE',end:p+1};
  }
  if(at(languageValue<string>('semantic-clauses.head.value.14'))||at(languageValue<string>('semantic-clauses.head.value.15'))){
    let object=p+1;while(articles().has(tokens[object]?.value))object++;
    // The verb is shared by shipment and refund reads. A declared refund noun
    // belongs to the refund rules, never an inferred order-tracking operation.
    const refund=dictionary.groups.find(group=>group.code==='OBJECT_REFUND');
    if(refund?.terms.some(term=>term.split(' ').every((word,index)=>tokens[object+index]?.value===word)))return null;
    return {intent:'TRACK_ORDER',end:p+1};
  }
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.16'))if(at(phrase))return {intent:'REORDER',end:p+phrase.split(' ').length};
  if(at(languageValue<string>('semantic-clauses.head.value.17')))return {intent:'REORDER',end:p+5};
  if(tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.18')&&tokens.slice(p+1,p+7).some(token=>languageValue<string[]>('semantic-clauses.head.value.19').includes(token.value)))return {intent:'REORDER',end:p+1};
  if((tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.20')||tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.21')||at(languageValue<string>('semantic-clauses.head.value.22')))&&tokens.slice(p+(at(languageValue<string>('semantic-clauses.head.value.23'))?2:1),p+8).some(token=>languageValue<string[]>('semantic-clauses.head.value.24').includes(token.value)))return {intent:'REORDER',end:p+(at(languageValue<string>('semantic-clauses.head.value.25'))?2:1)};
  if(tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.26')&&tokens.slice(p+1,p+5).some(token=>languageValue<string[]>('semantic-clauses.head.value.27').includes(token.value)))return {intent:'REORDER',end:p+1};
  if((at(languageValue<string>('semantic-clauses.head.value.28'))||at(languageValue<string>('semantic-clauses.head.value.29'))||at(languageValue<string>('semantic-clauses.head.value.30')))&&tokens.slice(p+1,p+6).some(token=>languageValue<string[]>('semantic-clauses.head.value.31').includes(token.value)))return {intent:'REORDER',end:p+1};
  if(languageValue<string[]>('semantic-clauses.head.value.32').includes(tokens[p]?.value)) {
    let q=p+1;while(articles().has(tokens[q]?.value))q++;
    if(tokens[q]?.value===languageValue<string>('semantic-clauses.head.value.33')) {
      const subject=tokens.slice(p,q+1).map(token=>token.value).join(' ');
      if(languagePattern('semantic-clauses.head.pattern.3').test(subject)&&tokens.slice(q+1).some(token=>languageValue<string[]>('semantic-clauses.head.value.34').includes(token.value)))return {intent:'REORDER',end:q+1};
      return {intent:'CREATE_ORDER',end:q+1};
    }
  }
  if(tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.35')&&languagePattern('semantic-clauses.head.pattern.4').test(remainder))return null;
  if(tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.36')) return {intent:'CREATE_ORDER',end:p+1};
  if(languageValue<string[]>('semantic-clauses.head.value.37').includes(tokens[p]?.value))return {intent:'SET_DELIVERY_ADDRESS',end:p+1};
  if(languageValue<string[]>('semantic-clauses.head.value.38').includes(tokens[p]?.value)&&tokens.slice(p+1,p+9).some(token=>languageValue<string[]>('semantic-clauses.head.value.39').includes(token.value)))return {intent:'SET_DELIVERY_ADDRESS',end:p+1};
  if(tokens[p]?.value===languageValue<string>('semantic-clauses.head.value.40')) return {intent:'CANCEL_ORDER',end:p+1};
  for(const phrase of languageValue<string[]>('semantic-clauses.head.value.41')) if(at(phrase)) return {intent:'PRODUCT_SEARCH',end:p+phrase.split(' ').length};
  const cancelIntent=dictionary.intents.find(intent=>intent.code==='CANCEL_ORDER');
  for(const condition of cancelIntent?.conditions.filter(condition=>condition.kind==='REQUIRED'||condition.kind==='POSITIVE')??[]){
    const group=dictionary.groups.find(candidate=>candidate.code===condition.group);
    if(group?.code.startsWith('ACTION_'))for(const phrase of group.terms.slice().sort((a,b)=>b.length-a.length))if(at(phrase))return {intent:'CANCEL_ORDER',end:p+phrase.split(' ').length};
  }
  const candidates=(dictionary.actionFrames??[]).filter(f=>['ADD_TO_CART','REMOVE_FROM_CART'].includes(f.intent)).flatMap(f=>f.actions.map(a=>({intent:f.intent,phrase:a}))).sort((a,b)=>b.phrase.length-a.phrase.length);
  for(const c of candidates)if(at(c.phrase))return {intent:c.intent,end:p+c.phrase.split(' ').length};
  return null;
}
/** A mixed action/negation must not silently swallow a later action sentence.
 * Inspect token gaps so decimal amounts, dotted product names and quoted data
 * retain their existing tokenization. This detects missing scope; it never
 * admits another action for execution.
 */
export function hasUnparsedSentenceAction(text:string,dictionary:Dictionary,parsed:Clause[]):boolean {
 return withDictionaryRecognition(dictionary,()=>{
  if(!parsed.some(clause=>clause.negated)||!parsed.some(clause=>!clause.negated))return false;
  const tokens=tokenize(text);
  for(let p=1;p<tokens.length;p++){
    if(tokens[p].quoted)continue;
    const previous=tokens[p-1];
    if(!['!','?'].includes(previous.value)&&!languagePattern('semantic-clauses.hasUnparsedSentenceAction.pattern.1').test(text.slice(previous.end,tokens[p].start)))continue;
    let q=p;
    while(languageValue<string[]>('semantic-clauses.hasUnparsedSentenceAction.value.1').includes(tokens[q]?.value))q++;
    q=affirmativeWrapperEnd(tokens,q);
    while(languageValue<string[]>('semantic-clauses.hasUnparsedSentenceAction.value.2').includes(tokens[q]?.value))q++;
    if(tokens[q]?.value===languageValue<string>('semantic-clauses.hasUnparsedSentenceAction.value.3')&&tokens[q+1]?.value===languageValue<string>('semantic-clauses.hasUnparsedSentenceAction.value.4'))q+=2;
    if(languageValue<string[]>('semantic-clauses.hasUnparsedSentenceAction.value.5').includes(tokens[q]?.value))q++;
    if(tokens[q]?.quoted||!tokens[q]||!head(tokens,q,dictionary))continue;
    if(!parsed.some(clause=>clause.start===tokens[q].start))return true;
  }
  return false;

 });
}

export function passiveCartRequest(text:string) {
  return languagePattern('semantic-clauses.passiveCartRequest.pattern.1').exec(text.trim());
}

/** Coordinators are clause boundaries only when a following action head exists. */
export function clauses(text:string,dictionary:Dictionary): ActionClause[] {
 return withDictionaryRecognition(dictionary,()=>{
  const tokens=tokenize(text);
  if(!tokens.length||languagePattern('semantic-clauses.clauses.pattern.1').test(text)||languagePattern('semantic-clauses.clauses.pattern.2').test(text))return [];
  const passive=passiveCartRequest(text);
  if(passive&&!languagePattern('semantic-clauses.clauses.pattern.3').test(passive[1])){
    const added=tokens.findIndex(token=>token.value===languageValue<string>('semantic-clauses.added.value.1'));
    const like=tokens.findIndex(token=>token.value===languageValue<string>('semantic-clauses.like.value.1'));
    if(added>like+1)return [{id:'clause1',text,start:0,end:text.length,intent:'ADD_TO_CART',connector:'start',negated:false,argument:tokens.slice(like+1,added)}];
  }
  let first=0;while(fillers().has(tokens[first]?.value)||languageValue<string[]>('semantic-clauses.clauses.value.1').includes(tokens[first]?.value))first++;
  // Conversational wrappers and a sequence marker may precede an explicit head.
  if(languageValue<string[]>('semantic-clauses.clauses.value.2').includes(tokens[first]?.value)&&tokens[first+1]?.value===languageValue<string>('semantic-clauses.clauses.value.3')){first+=2;while(languageValue<string[]>('semantic-clauses.clauses.value.4').includes(tokens[first]?.value))first++;}
  if(tokens[first]?.value===languageValue<string>('semantic-clauses.clauses.value.5'))first++;
  const starts:{p:number;head:Head;connector:string;negated:boolean}[]=[];
  function next(p:number,connector:string) {
    while(languageValue<string[]>('semantic-clauses.next.value.1').includes(tokens[p]?.value))p++;
    // An affirmative conversational wrapper belongs to this clause only. Never
    // skip a negation, condition or arbitrary prose to reach a later action.
    p=affirmativeWrapperEnd(tokens,p);
    while(languageValue<string[]>('semantic-clauses.next.value.2').includes(tokens[p]?.value))p++;
    let negated=false;
    if(tokens[p]?.value===languageValue<string>('semantic-clauses.next.value.3')&&tokens[p+1]?.value===languageValue<string>('semantic-clauses.next.value.4')){negated=true;p+=2;}
    if(languageValue<string[]>('semantic-clauses.next.value.5').includes(tokens[p]?.value)){negated=true;p++;}
    const h=head(tokens,p,dictionary);if(h)starts.push({p,head:h,connector,negated});
  }
  const leadingNegation=languageValue<string[]>('semantic-clauses.leadingNegation.value.1').includes(tokens[first]?.value);
  if(leadingNegation)first++;
  next(first,'start');
  if(!starts.some(start=>start.p===first)){
    const cancelIntent=dictionary.intents.find(intent=>intent.code==='CANCEL_ORDER');
    const actionTerms=(cancelIntent?.conditions.filter(condition=>condition.kind==='REQUIRED'||condition.kind==='POSITIVE')??[]).flatMap(condition=>dictionary.groups.find(group=>group.code===condition.group&&group.code.startsWith('ACTION_'))?.terms??[]).sort((a,b)=>b.length-a.length);
    for(let actionStart=first+1;actionStart<tokens.length&&!starts.length;actionStart++)for(const phrase of actionTerms){
      if(!phrase.split(' ').every((word,index)=>tokens[actionStart+index]?.value===word))continue;
      if(!tokens.some(token=>languageValue<string[]>('semantic-clauses.clauses.value.6').includes(token.value)))continue;
      starts.push({p:first,head:{intent:'CANCEL_ORDER',end:actionStart+phrase.split(' ').length},connector:'start',negated:languagePattern('semantic-clauses.clauses.pattern.4').test(text)});break;
    }
  }
  if(!starts.some(start=>start.p===first)&&languagePattern('semantic-clauses.clauses.pattern.5').test(text)&&languagePattern('semantic-clauses.clauses.pattern.6').test(text))starts.push({p:first,head:{intent:'REORDER',end:Math.max(first+1,tokens.findIndex(token=>languageValue<string[]>('semantic-clauses.clauses.value.7').includes(token.value))+1)},connector:'start',negated:leadingNegation||languagePattern('semantic-clauses.clauses.pattern.7').test(text)});
  if(leadingNegation)for(const start of starts)if(start.p===first)start.negated=true;
  if(!starts.length)return [];
  for(let p=first+1;p<tokens.length;p++) {
    if(languageValue<string[]>('semantic-clauses.clauses.value.8').includes(tokens[p].value))next(p+1,tokens[p].value);
  }
  const unique=[...new Map(starts.map(s=>[s.p,s])).values()].sort((a,b)=>a.p-b.p);
  return unique.slice(0,33).map((s,i)=>{
    let end=i+1<unique.length?unique[i+1].p:tokens.length;
    while(end>s.head.end&&languageValue<string[]>('semantic-clauses.clauses.value.9').includes(tokens[end-1].value))end--;
    const argument=tokens.slice(s.head.end,end).filter(t=>!['?','!'].includes(t.value));
    const start=tokens[s.p].start,stop=tokens[end-1]?.end??tokens[s.p].end;
    return {id:languageTemplate('semantic-clauses.clauses.template.1', [i+1]),text:text.slice(start,stop),start,end:stop,intent:s.head.intent,connector:s.connector,negated:s.negated,argument};
  });

 });
}
