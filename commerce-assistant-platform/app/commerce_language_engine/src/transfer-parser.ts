import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import {quantityPrefix} from './quantities.ts';
import type {ActionFrame,Context,Dictionary} from './types.ts';
import type {ParsedFrame} from './request-parser.ts';

const articles=()=>recognitionMemo('transfer-parser.articles',()=>(new Set(languageValue<string[]>('transfer-parser.articles.value.1'))));
const at=(t:string[],p:number,s:string)=>s.split(' ').every((w,i)=>t[p+i]===w);
const collection=(s:string)=>languagePattern('transfer-parser.collection.pattern.1').test(s)?'wishlist':'cart';
// The second verb must refer back to the same items, not introduce a new object.
export function transferBridge(tokens:string[]):boolean {
 return languagePattern('transfer-parser.transferBridge.pattern.1').test(tokens.join(' '));
}
function noun(t:string[],p:number,aliases:string[]){
 while(articles().has(t[p]))p++;
 const alias=[...aliases].sort((a,b)=>b.length-a.length).find(s=>at(t,p,s));
 return alias?{alias,end:p+alias.split(' ').length}:null;
}
export function transferFrame(tokens:string[],frame:ActionFrame,p:number,action:string,limit:number):ParsedFrame|null {
 const begin=p+action.split(' ').length,t=tokens.slice(0,limit);
 const sources: {start:number;end:number;alias:string}[]=[],targets:typeof sources=[];
 for(let i=begin;i<limit;i++){
  const sourcePrep=at(t,i,languageValue<string>('transfer-parser.sourcePrep.value.1'))?2:t[i]===languageValue<string>('transfer-parser.lexical.value.1')?1:0;
  if(sourcePrep){const n=noun(t,i+sourcePrep,frame.sources!);if(n)sources.push({start:i,...n});}
  for(const prep of [...new Set([...frame.prepositions,languageValue<string>('transfer-parser.transferFrame.value.1'),languageValue<string>('transfer-parser.transferFrame.value.2')])])if(at(t,i,prep)){const n=noun(t,i+prep.split(' ').length,frame.targets);if(n)targets.push({start:i,...n});}
 }
 if(targets.length!==1||sources.length>1)return null;
 const target=targets[0];let source=sources[0],raw:string[],end:number;
 if(source){
  const first=source.start<target.start?source:target,second=first===source?target:source;
  const bridged=first===source&&transferBridge(t.slice(first.end,second.start));
  if(first.end!==second.start&&!bridged)return null;
  if(languageValue<string[]>('transfer-parser.transferFrame.value.3').includes(action)&&!bridged)return null;
  raw=t.slice(begin,first.start);end=second.end;
 }else{
  if(languageValue<string[]>('transfer-parser.transferFrame.value.4').includes(action))return null;
  const n=noun(t,begin,frame.sources!);if(!n||n.end>target.start)return null;
  source={start:begin,...n};raw=t.slice(n.end,target.start);end=target.end;
 }
 if(t.slice(end).some(w=>!languageValue<string[]>('transfer-parser.transferFrame.value.5').includes(w)))return null;
 while(articles().has(raw[0]))raw.shift();
 if(raw.some(w=>languageValue<string[]>('transfer-parser.transferFrame.value.6').includes(w)))return null;
 const q=quantityPrefix(raw);
 if(q.end===0&&languagePattern('transfer-parser.transferFrame.pattern.1').test(raw[0])){q.quantity=Number(raw[0]);q.end=1;}
 const body=raw.slice(q.end),description=body.join(' ');
 const entities:Record<string,unknown>={sourceCollection:collection(source.alias),destination:collection(target.alias)};
 if(entities.sourceCollection==='wishlist'&&entities.destination==='cart'){
  const selection=raw.join(' ');
  if(languagePattern('transfer-parser.transferFrame.pattern.2').test(selection))entities.selection='ALL_SAVED';
  if(languagePattern('transfer-parser.transferFrame.pattern.3').test(selection))entities.selection='RANDOM_SAVED';
 }
 if(q.quantity!==undefined&&!entities.selection)entities.quantity=q.quantity;
 if(q.quantityRange)entities.quantityRange=q.quantityRange;
 if(languagePattern('transfer-parser.transferFrame.pattern.4').test(description))entities.product_reference='CURRENT';
 const parts=raw.join(' ').split(languagePattern('transfer-parser.parts.pattern.1'));
 if(parts.length>1){const lines=parts.map(part=>{const words=part.split(' '),n=quantityPrefix(words);return {description:words.slice(n.end).join(' '),...(n.quantity!==undefined?{quantity:n.quantity}:{})};});if(lines.every(l=>l.description)){entities.line_items=lines;delete entities.quantity;}}
 const preceding=t.slice(Math.max(0,p-12),p),boundary=preceding.findLastIndex(w=>languageValue<string[]>('transfer-parser.boundary.value.1').includes(w));
 const left=preceding.slice(boundary+1).join(' ');
 return {code:frame.code,intent:frame.intent,action,start:p,end,target:target.alias,description,entities,selectionRequired:true,negated:languagePattern('transfer-parser.transferFrame.pattern.5').test(left),instructional:languagePattern('transfer-parser.transferFrame.pattern.6').test(left)};
}

/** Resume only an item clarification; a new command never becomes an item name. */
export function transferReply(dictionary:Dictionary,text:string,context:Context,parse:(tokens:string[],dictionary:Dictionary)=>ParsedFrame[]):string|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 if(!context.pendingRequest)return;
 const pending=parse(normalize(context.pendingRequest).split(' '),dictionary).filter(f=>f.entities.sourceCollection&&!f.negated&&!f.instructional);
 if(pending.length!==1)return;
 const f=pending[0];
 const reply=normalize(text),tokens=reply.split(' ');
 const q=quantityPrefix(tokens);
 if(f.entities.quantity!==undefined&&(!Number.isSafeInteger(f.entities.quantity)||Number(f.entities.quantity)<=0||Number(f.entities.quantity)>1000000)){
  if(q.end===tokens.length&&Number.isSafeInteger(q.quantity)&&q.quantity!>0&&q.quantity!<=1000000)return languageTemplate('transfer-parser.transferReply.template.1', [f.action, q.quantity, f.description, f.entities.sourceCollection, f.entities.destination]);
  return;
 }
 if(f.description&&!languagePattern('transfer-parser.transferReply.pattern.1').test(f.description))return;
 if(f.entities.sourceCollection==='wishlist'&&f.entities.destination==='cart'&&f.entities.quantity===undefined&&languagePattern('transfer-parser.transferReply.pattern.2').test(reply))return languageTemplate('transfer-parser.transferReply.template.2', [f.action, reply]);
 if(!reply||reply.length>250||languagePattern('transfer-parser.transferReply.pattern.3').test(reply))return;
 if(dictionary.groups.some(g=>g.code.startsWith('ACTION_')&&g.terms.some(term=>tokens.some((_,i)=>at(tokens,i,term)))))return;
 const prefix=quantityPrefix(tokens).quantity===undefined&&f.entities.quantity!==undefined?String(f.entities.quantity)+' ':'';
 return languageTemplate('transfer-parser.transferReply.template.3', [f.action, prefix, reply, f.entities.sourceCollection, f.entities.destination]);

 });
}
