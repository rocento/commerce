import {withDictionaryRecognition} from './recognition-rules.ts';
import type {Context,Dictionary} from './types.ts';
import {validDate} from './semantic-entities.ts';
import {states} from './dictionary-schema.ts';
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const short=(v:unknown,n:number)=>typeof v==='string'&&v.length>0&&v.length<=n;
/** Validate language context; this is never customer/session authorization. */
export function validContext(value:unknown,dictionary:Dictionary):value is Context {
 return withDictionaryRecognition(dictionary,()=>{
  if(!record(value))return false;
  const keys=new Set(['activeSearch','collection','previousIntent','states','pendingRequest','pendingActionRequest','pendingClarification','selectedItems','resultSetItems','orderReference','deliveryAddressReference','referenceDate','timezone','industry']);
  if(Object.keys(value).some(k=>!keys.has(k)))return false;
  if(value.activeSearch!==undefined&&(!record(value.activeSearch)||Object.keys(value.activeSearch).some(k=>!['text','contextual'].includes(k))||!short(value.activeSearch.text,4000)||value.activeSearch.contextual!==undefined&&value.activeSearch.contextual!==true))return false;
  if(value.pendingClarification!==undefined){
    const pending=value.pendingClarification;
    if(!record(pending)||Object.keys(pending).some(k=>!['text','intent','slot'].includes(k))||!short(pending.text,4000)||!dictionary.intents.some(i=>i.code===pending.intent)||!['quantity','product','currency'].includes(String(pending.slot)))return false;
  }
  if(value.collection!==undefined&&!['cart','wishlist'].includes(String(value.collection)))return false;
  if(value.previousIntent!=null&&(!short(value.previousIntent,100)||!['SET_DELIVERY_ADDRESS',...dictionary.intents.map(i=>i.code)].includes(value.previousIntent as string)))return false;
  if(value.states!==undefined&&(!Array.isArray(value.states)||value.states.length>32||!value.states.every(s=>typeof s==='string'&&states.includes(s))))return false;
  for(const [key,limit] of [['pendingRequest',4000],['pendingActionRequest',4000],['orderReference',100],['deliveryAddressReference',250],['timezone',100]] as const)if(value[key]!==undefined&&!short(value[key],limit))return false;
  if(value.referenceDate!==undefined&&(typeof value.referenceDate!=='string'||!validDate(value.referenceDate)))return false;
  if(value.timezone!==undefined){try{new Intl.DateTimeFormat('en',{timeZone:value.timezone as string});}catch{return false;}}
  if(value.industry!==undefined&&!dictionary.semanticModel?.industryPacks.includes(value.industry as string))return false;
  const validItems=(items:unknown):boolean=>{
    if(!Array.isArray(items)||items.length>50)return false;
    for(const item of items){
      if(!record(item)||Object.keys(item).some(k=>!['productText','quantity','unit','reference','resolvedFrom','selectionStrategy'].includes(k)))return false;
      if(!short(item.productText,250))return false;
      if(item.quantity!==undefined&&(!Number.isSafeInteger(item.quantity)||Number(item.quantity)<=0||Number(item.quantity)>1000000))return false;
      for(const k of ['unit','reference','resolvedFrom','selectionStrategy'])if(item[k]!==undefined&&!short(item[k],100))return false;
    }
    return true;
  };
  if(value.selectedItems!==undefined&&!validItems(value.selectedItems))return false;
  if(value.resultSetItems!==undefined&&!validItems(value.resultSetItems))return false;
  return true;

 });
}
