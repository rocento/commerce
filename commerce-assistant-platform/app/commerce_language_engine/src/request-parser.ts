import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import {quantityPrefix} from './quantities.ts';
import {transferFrame,transferBridge} from './transfer-parser.ts';
import type {ActionFrame,Dictionary,Match} from './types.ts';

export type ParsedFrame={contextual?:boolean;code:string;intent:string;action:string;start:number;end:number;target:string;description:string;negated:boolean;entities:Record<string,unknown>;selectionRequired:boolean; excludedObject?:string; instructional?:boolean};
const at=(tokens:string[],p:number,phrase:string)=>normalize(phrase).split(' ').every((t,j)=>tokens[p+j]===t);
const length=(phrase:string)=>normalize(phrase).split(' ').length;
const boundaries=()=>recognitionMemo('request-parser.boundaries',()=>(new Set(languageValue<string[]>('request-parser.boundaries.value.1'))));
function negated(tokens:string[],position:number){
 const left=tokens.slice(Math.max(0,position-7),position);const boundary=left.findLastIndex(t=>boundaries().has(t));
 return left.slice(boundary+1).some(t=>languageValue<string[]>('request-parser.negated.value.1').includes(t));
}
function targetAt(tokens:string[],position:number,frame:ActionFrame){
 for(const target of [...frame.targets].sort((a,b)=>length(b)-length(a)))if(at(tokens,position,target))return target;
 return null;
}
export function parseRequest(tokens:string[],dictionary:Dictionary) {
 return withDictionaryRecognition(dictionary,()=>{
 const frames:ParsedFrame[]=[];
 // Dictionary phrases repeat at every token position and recursive parse. Build
 // the token index once per invocation; never cache customer text across turns.
 const phrases=new Map<string,string[]>();
 const words=(phrase:string)=>{let row=phrases.get(phrase);if(!row){row=normalize(phrase).split(' ');phrases.set(phrase,row);}return row;};
 const at=(input:string[],p:number,phrase:string)=>words(phrase).every((t,j)=>input[p+j]===t);
 const length=(phrase:string)=>words(phrase).length;
 for(const frame of dictionary.actionFrames??[]){
 const actions=[...frame.actions,...(frame.sources?.length?languageValue<string[]>('request-parser.action.value.1'):[])].sort((a,b)=>length(b)-length(a));
 for(let p=0;p<tokens.length;p++) {
  const action=actions.find(a=>at(tokens,p,a));if(!action)continue;
  const actionEnd=p+length(action);
  // A bounded argument scan ends at a competing command or a clause boundary.
  let limit=Math.min(tokens.length,actionEnd+24);
  for(let j=actionEnd;j<limit;j++)if(boundaries().has(tokens[j])||tokens[j]===languageValue<string>('request-parser.parseRequest.value.1')&&(dictionary.actionFrames??[]).some(f=>f.actions.some(a=>at(tokens,j+1,a)))){
   if(frame.sources?.length&&transferBridge(tokens.slice(j,j+3)))continue;
   limit=j;break;
  }
  if(frame.sources?.length){const transfer=transferFrame(tokens,frame,p,action,limit);if(transfer)frames.push(transfer);continue;}
  for(let prepAt=actionEnd;prepAt<limit;prepAt++) {
   const prepositions=frame.intent==='ADD_TO_CART'?[...frame.prepositions,languageValue<string>('request-parser.prepositions.value.1')]:frame.prepositions;
   const prep=prepositions.find(value=>at(tokens,prepAt,value));if(!prep)continue;
   let nounAt=prepAt+length(prep);while(languageValue<string[]>('request-parser.parseRequest.value.2').includes(tokens[nounAt]))nounAt++;
   const target=targetAt(tokens,nounAt,frame);if(!target)continue;
   const rawObject=tokens.slice(actionEnd,prepAt);
   // The direct object matters: adding a coupon to a cart is still APPLY_COUPON.
   const excludedObject=frame.excludedObjects.find(ex=>rawObject.some((_,i)=>at(rawObject,i,ex)));
   if(rawObject.some(t=>languageValue<string[]>('request-parser.parseRequest.value.3').includes(t)))continue; // transfer requests need their own explicit rules
   if(!rawObject.length)continue;
   const quantity=quantityPrefix(rawObject);
   const body=rawObject.slice(quantity.end).filter((word,i)=>!(i===0&&languageValue<string[]>('request-parser.body.value.1').includes(word)));
   const descriptor=body.join(' ').replace(languagePattern('request-parser.descriptor.pattern.1'),'').trim();
   const entities:Record<string,unknown>={destination:target.includes(languageValue<string>('request-parser.entities.value.1'))||languageValue<string[]>('request-parser.entities.value.2').includes(target)?'wishlist':'cart'};
   if(quantity.quantity!==undefined)entities.quantity=quantity.quantity;
   if(quantity.quantityRange)entities.quantityRange=quantity.quantityRange;
   if(quantity.selection)entities.selection=quantity.selection;
   if(languagePattern('request-parser.parseRequest.pattern.1').test(descriptor))entities.freshness='fresh';
   if(languagePattern('request-parser.parseRequest.pattern.2').test(descriptor))entities.product_attributes=descriptor.split(' ').filter(t=>languageValue<string[]>('request-parser.parseRequest.value.4').includes(t));
   if(languagePattern('request-parser.parseRequest.pattern.3').test(rawObject.join(' ')))entities.product_reference='CURRENT';
   const segments=rawObject.join(' ').split(languagePattern('request-parser.segments.pattern.1'));
   if(segments.length>1){const lineItems=segments.map(segment=>{const words=segment.split(' '),q=quantityPrefix(words);return {quantity:q.quantity,quantityRange:q.quantityRange,description:words.slice(q.end).join(' ')};});if(lineItems.every(item=>(item.quantity!==undefined||item.quantityRange)&&item.description))entities.line_items=lineItems;}
   const instructional=languagePattern('request-parser.instructional.pattern.1').test(tokens.slice(Math.max(0,p-12),p).join(' '));
   frames.push({excludedObject,instructional,code:frame.code,intent:frame.intent,action,start:p,end:nounAt+length(target),target,description:descriptor,negated:negated(tokens,p),entities,selectionRequired:frame.selectionRequired});
   break;
  }
 }
 }
 // The longest action phrase at the same position defines one frame path.
 const transfers=frames.filter(f=>f.entities.sourceCollection);
 // A source-qualified transfer owns the nested destination-only add frame.
 // Separate commands keep their own spans and remain independently resolvable.
 const specific=frames.filter(f=>f.entities.sourceCollection||!transfers.some(t=>t.start<=f.start&&t.end>=f.end));
 return [...new Map(specific.map(f=>[f.intent+':'+f.start,f])).values()];

 });
}

export function suppressRequestPrefixes(matches:Match[],tokens:string[],dictionary:Dictionary) {
 return withDictionaryRecognition(dictionary,()=>{
 const prefixes=new Set((dictionary.requestPrefixes??[]).map(normalize));
 const bridge=new Set(languageValue<string[]>('request-parser.bridge.value.1'));
 const suppressed:Match[]=[];
 let frames:ParsedFrame[]|undefined;
 for(const match of matches){
  if(!match.group.startsWith('ACTION_'))continue;
  // A semantic match may cover only part of a request prefix (could in could you).
  const spans=[...prefixes].flatMap(prefix=>{const words=prefix.split(' ');return tokens.flatMap((_,start)=>start<=match.start&&start+words.length>=match.end&&words.every((word,j)=>tokens[start+j]===word)?[start+words.length]:[]);});
  if(!spans.length)continue;const prefixEnd=Math.max(...spans);
  const following=matches.find(other=>other.start>=prefixEnd&&other.group.startsWith('ACTION_')&&!prefixes.has(other.phrase)&&other.start-prefixEnd<=5&&tokens.slice(prefixEnd,other.start).every(t=>bridge.has(t)));
  // A published collection frame can contain a command verb which has no
  // standalone ACTION synonym. Its complete syntax still owns "I need ...";
  // otherwise that request prefix competes with the proven write as a search.
  const followingFrame=!following&&(frames??=parseRequest(tokens,dictionary)).some(frame=>frame.start>=prefixEnd&&frame.start-prefixEnd<=5&&tokens.slice(prefixEnd,frame.start).every(t=>bridge.has(t)));
  if(following||followingFrame)suppressed.push(match);
 }
 return {matches:matches.filter(m=>!suppressed.includes(m)),suppressed};

 });
}

export function fulfillment(intent:string|null,frame:ParsedFrame|undefined,entities:Record<string,unknown>) {
 if(!intent||!frame?.selectionRequired)return undefined;
 const genericDescription=(text:string)=>!text||languagePattern('request-parser.genericDescription.pattern.1').test(text);
 const lines=Array.isArray(entities.line_items)?entities.line_items as {description:string;quantity?:number}[]:[];
 const generic=genericDescription(frame.description)||lines.some(l=>genericDescription(l.description)||languagePattern('request-parser.generic.pattern.1').test(l.description));
 const reference=!!entities.product_reference;
 const choice=entities.selection==='ANY_MATCHING'||(entities.sourceCollection==='wishlist'&&entities.destination==='cart'&&['ALL_SAVED','RANDOM_SAVED'].includes(String(entities.selection)));
 const invalid=(quantity:unknown)=>quantity!==undefined&&(!Number.isSafeInteger(quantity)||Number(quantity)<=0||Number(quantity)>1000000);
 const invalidQuantity=invalid(entities.quantity)||lines.some(l=>invalid(l.quantity));
 // "Any" supplies a selection policy, not a product category. A saved-list
 // transfer has a named source; generic fresh items still need a product noun.
 const genericUnbound=generic&&!reference&&(!choice||entities.selection==='ANY_MATCHING');
 const needsClarification=!!entities.quantityRange||invalidQuantity||genericUnbound;
 return {status:'NOT_EXECUTED',needsClarification,unresolvedSlots:[{slot:'product_ids',reason:reference?'REFERENCE_BINDING_REQUIRED':genericUnbound?'PRODUCT_SELECTION_REQUIRED':choice?'CATALOG_MATCHING_REQUIRED':generic?'PRODUCT_SELECTION_REQUIRED':'CATALOG_MATCHING_REQUIRED'}],...(entities.quantityRange?languageValue<{ quantityClarification: string; }>('request-parser.fulfillment.value.1'):{}),...(invalidQuantity?languageValue<{ quantityClarification: string; }>('request-parser.fulfillment.value.2'):{})};
}
