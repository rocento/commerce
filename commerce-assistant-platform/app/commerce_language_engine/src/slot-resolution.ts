import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import type {SemanticContext,SemanticRequest,ResolvedSlot,SlotState} from './semantic-types.ts';
import type {Dictionary,IntentSlot} from './types.ts';

type Resolution={slots:ResolvedSlot[];missing:string[];question?:string};
type SlotInput={entities:SemanticRequest['entities'];missing:string[]};

const getValue=(slot:IntentSlot,request:SlotInput,context:SemanticContext):{value?:unknown;source?:string;state?:SlotState;requiresAuthorizationLookup?:boolean}=>{
 const resolver=slot.metadata.resolver;
 switch(resolver){
  case 'ITEMS': return request.entities.items.length>=slot.minCount?{value:request.entities.items,source:'utterance'}:request.entities.order?{value:request.entities.order,source:'commerce_order_lookup',state:'AUTHORITY_LOOKUP_REQUIRED',requiresAuthorizationLookup:true}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.1');
  case 'PRODUCT_TEXT': {
   const items=request.entities.items.filter(item=>item.productText);
   const rankedReference=request.entities.items.find(item=>item.selectionStrategy);
   if(rankedReference?.selectionStrategy&&context.resultSetItems?.length)return {value:{selectionStrategy:rankedReference.selectionStrategy,resultCount:context.resultSetItems.length},source:'result_set_context',state:'AUTHORITY_LOOKUP_REQUIRED',requiresAuthorizationLookup:true};
   if(request.entities.order&&!items.length)return {value:request.entities.order,source:'commerce_order_lookup',state:'AUTHORITY_LOOKUP_REQUIRED',requiresAuthorizationLookup:true};
   if(items.length<slot.minCount||request.entities.items.some(item=>!item.productText))return {value:items.map(item=>item.productText),source:items.length?'partial_utterance':undefined,state:request.entities.items.some(item=>item.reference)?'REFERENCE_PENDING':'MISSING'};
   return items.length?{value:items.map(item=>item.productText),source:'utterance'}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.2');
  }
  case 'QUANTITY': {
   const values=request.entities.items.map(item=>item.quantity);
   return values.length&&values.every(value=>value!==undefined)?{value:values,source:'utterance'}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.3');
  }
  case 'ITEM_COUNT': return request.entities.items.length>=slot.minCount?{value:request.entities.items.length,source:'utterance'}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.4');
  case 'ORDER_REFERENCE': {
   const reference=request.entities.order;
   if(reference?.resolvedReference)return {value:reference.resolvedReference,source:context.orderReference?'conversation_context':'utterance'};
   if(reference)return {value:reference.reference,source:'utterance',state:reference.requiresAuthorizationLookup||slot.resolutionStrategy==='COMMERCE_LOOKUP'&&reference.reference==='CURRENT'?'AUTHORITY_LOOKUP_REQUIRED':'REFERENCE_PENDING',requiresAuthorizationLookup:reference.requiresAuthorizationLookup||slot.resolutionStrategy==='COMMERCE_LOOKUP'&&reference.reference==='CURRENT'};
   return {state:slot.resolutionStrategy==='COMMERCE_LOOKUP'?'AUTHORITY_LOOKUP_REQUIRED':'MISSING'};
  }
  case 'DELIVERY_ADDRESS': {
   const address=request.entities.delivery?.addressReference;
   if(address)return {value:address,source:context.deliveryAddressReference?'conversation_context':'utterance'};
   if(request.missing.includes(languageValue<string>('slot-resolution.getValue.value.5')))return languageValue<{ state: "REFERENCE_PENDING"; source: string; }>('slot-resolution.getValue.value.6');
   return {state:slot.resolutionStrategy==='COMMERCE_LOOKUP'?'AUTHORITY_LOOKUP_REQUIRED':'MISSING'};
  }
  case 'DELIVERY_DATE': {
   const date=request.entities.delivery?.date??request.entities.delivery?.relativeDate;
   return date?{value:date,source:'utterance'}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.7');
  }
  case 'DELIVERY_TIME_WINDOW': {
   const time=request.entities.delivery?.timeWindow;
   return time?{value:time,source:'utterance'}:languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.8');
  }
  default: {
   const missingKey=slot.metadata.missingKey;
   if(typeof missingKey==='string'&&request.missing.includes(missingKey))return languageValue<{ state: "MISSING"; }>('slot-resolution.getValue.value.9');
   return languageValue<{ state: "UNSUPPORTED"; }>('slot-resolution.getValue.value.10');
  }
 }
};

function unresolved(slot:ResolvedSlot):boolean {
 if(slot.requirement==='REQUIRED')return ['MISSING','AMBIGUOUS','INVALID','REFERENCE_PENDING','UNSUPPORTED'].includes(slot.state);
 return slot.requirement==='CONTEXTUAL'&&['AMBIGUOUS','INVALID','REFERENCE_PENDING','UNSUPPORTED'].includes(slot.state);
}

/** Resolves declared slots without performing commerce or identity lookups. */
export function resolveSlots(dictionary:Dictionary,intent:string,request:SlotInput,context:SemanticContext):Resolution {
 return withDictionaryRecognition(dictionary,()=>{
 const model=dictionary.semanticModel;
 if(!model)return {slots:[],missing:request.missing};
 const definitions=model.intentSlots.filter(slot=>slot.intent===intent);
 const slots:ResolvedSlot[]=definitions.map(definition=>{
  const result=getValue(definition,request,context);
  const state=result.state??'RESOLVED';
  return {code:definition.code,state,requirement:definition.requirement,...(result.source?{source:result.source}:{}),...(result.value!==undefined?{value:result.value}:{}),candidates:[],confidence:state==='RESOLVED'?1:0,requiresAuthorizationLookup:result.requiresAuthorizationLookup??definition.resolutionStrategy==='COMMERCE_LOOKUP'};
 });
 const policies=new Map(model.clarificationPolicies.filter(policy=>policy.intent===intent).map(policy=>[policy.slotCode,policy]));
 const prioritized=definitions.map((definition,index)=>({definition,slot:slots[index],policy:policies.get(definition.code)}))
  .filter(entry=>unresolved(entry.slot))
  .sort((a,b)=>Number(b.definition.requirement==='REQUIRED')-Number(a.definition.requirement==='REQUIRED')
   ||(a.policy?.priority??100)-(b.policy?.priority??100)
   ||a.definition.clarificationRank-b.definition.clarificationRank
   ||Number(a.definition.metadata.resolutionCost??100)-Number(b.definition.metadata.resolutionCost??100)
   ||a.definition.code.localeCompare(b.definition.code));
 const associatedMissing=(definition:IntentSlot)=>request.missing.filter(key=>{
  if(definition.metadata.missingKey===key)return true;
  const resolver=definition.metadata.resolver;
  return resolver==='PRODUCT_TEXT'&&(key==='items'||key==='productReference'||key.includes('productText'))
   ||resolver==='ORDER_REFERENCE'&&key==='orderReference'
   ||resolver==='DELIVERY_ADDRESS'&&key==='delivery.addressReference'
   ||resolver==='DELIVERY_DATE'&&key==='delivery.date'
   ||resolver==='DELIVERY_TIME_WINDOW'&&key==='delivery.timeWindow';
 });
 const missingOrder=prioritized.flatMap(entry=>{
  const associated=associatedMissing(entry.definition);
  if(associated.length)return associated;
  const key=entry.definition.metadata.missingKey;
  return typeof key==='string'?[key]:[];
 });
 const missing=[...new Set([...missingOrder,...request.missing])];
 const selected=prioritized[0];
 return {slots,missing,...(selected?.policy?{question:selected.policy.questionTemplate}:{})};

 });
}
