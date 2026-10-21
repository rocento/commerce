import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {clauses,tokenize,passiveCartRequest} from './semantic-clauses.ts';
import {quotedNumericProduct,packagedQuantity} from './quantities.ts';
import {priceAmount} from './price-language.ts';
import {comparisonPhrasePattern} from './comparison-operators.ts';
import {itemsFrom,deliveryFrom} from './semantic-entities.ts';
import type {Dictionary,SemanticIndexes} from './types.ts';
import type {SemanticContext,SemanticRequest,Item,Action,Delivery,ResolvedAmbiguity} from './semantic-types.ts';
import {resolveSlots} from './slot-resolution.ts';
import {buildSemanticGraph} from './semantic-graph.ts';
import {findReferenceRule,referenceIndexFor,resolveAmbiguities} from './reference-resolution.ts';
const operation:Record<string,string>={ADD_TO_CART:'ADD_ITEM',REMOVE_FROM_CART:'REMOVE_ITEM',PRODUCT_SEARCH:'SEARCH_PRODUCTS',PRODUCT_COMPARE:'COMPARE_PRODUCTS',TRACK_ORDER:'TRACK_ORDER',SELECT_DELIVERY_SLOT:'SELECT_DELIVERY_SLOT',CREATE_ORDER:'CREATE_ORDER',START_CHECKOUT:'START_CHECKOUT',REORDER:'REPEAT_ORDER',SET_DELIVERY_ADDRESS:'SET_DELIVERY_ADDRESS',CANCEL_ORDER:'CANCEL_ORDER'};
const productIntents=()=>recognitionMemo('semantic-request.productIntents',()=>(new Set(['ADD_TO_CART','REMOVE_FROM_CART','PRODUCT_SEARCH','PRODUCT_COMPARE'])));
const priceBound=()=>recognitionMemo('semantic-request.priceBound',()=>(languageValue<string>('semantic-request.priceBound.value.1')+comparisonPhrasePattern()+languageValue<string>('semantic-request.priceBound.value.2')+priceAmount()));
const priceRange=()=>recognitionMemo('semantic-request.priceRange',()=>(languageValue<string>('semantic-request.priceRange.value.1')+priceAmount()+languageValue<string>('semantic-request.priceRange.value.2')+priceAmount()));
const priceTail=()=>recognitionMemo('semantic-request.priceTail',()=>(new RegExp('^(?:'+priceRange()+'|'+priceBound()+languageValue<string>('semantic-request.priceTail.value.1')+priceBound()+')*)[?!]*$')));

/** Bounded linguistic graph. RESOLVED means understood, never executed. */
export function semanticRequest(dictionary:Dictionary,text:string,context:SemanticContext={},force=false,indexes?:SemanticIndexes):SemanticRequest|null {
 return withDictionaryRecognition(dictionary,()=>{
  const parsed=clauses(text,dictionary);
  if(!parsed.length)return null;
  const items:Item[]=[];const actions:Action[]=[];const references:SemanticRequest['references']=[];const relationships:SemanticRequest['relationships']=[];const missing:string[]=[];
  const referenceIndex=referenceIndexFor(dictionary,indexes);
  const lexicalAmbiguities=resolveAmbiguities(dictionary,text,context,indexes?.ambiguitiesByTerm);
  let delivery:Delivery|undefined;let order:SemanticRequest['entities']['order'];let recentItems=context.resultSetItems??context.selectedItems??[];
  const referenceAmbiguities:ResolvedAmbiguity[]=[];
  let referenceDetected=false;
  let recognizedItems=0;
  const active=parsed.filter(c=>!c.negated);
  if(!active.length)return null;
  referenceDetected=active.some(clause=>!!findReferenceRule(clause.text,referenceIndex));
  let primary=active.find(c=>c.intent==='CREATE_ORDER')?.intent??active.find(c=>c.intent==='REORDER')?.intent??active.find(c=>c.intent==='START_CHECKOUT')?.intent??active.findLast(c=>c.intent!=='SET_DELIVERY_ADDRESS')?.intent??active[0].intent;
  if(active.some(c=>['CREATE_ORDER','REORDER'].includes(c.intent))&&active.some(c=>c.intent==='CANCEL_ORDER'))primary='CREATE_ORDER';
  const addAction=(intent:string,clauseId:string,indexes?:number[])=>{const action={id:languageTemplate('semantic-request.action.template.1', [actions.length+1]),intent,clauseId,operation:operation[intent],...(indexes?{itemIndexes:indexes}:{})};actions.push(action);for(const i of indexes??[])relationships.push({from:action.id,relation:'uses',to:languageTemplate('semantic-request.addAction.template.1', [i+1])});return action;};
  for(const clause of active) {
    const argument=clause.argument.map(t=>t.value).join(' ');
    // The same scoped command corrections used by the clause tokenizer apply
    // to owned-order references; raw "ordar" must not lose the lookup policy.
    const orderRule=findReferenceRule(tokenize(clause.text).map(token=>token.value).join(' '),referenceIndex,'ORDER');
    const selectedOrderInContext=!!context.orderReference||!!context.states?.includes('ORDER_SELECTED');
    const orderReference=clause.intent==='REORDER'&&(languagePattern('semantic-request.orderReference.pattern.1').test(clause.text)||languagePattern('semantic-request.orderReference.pattern.2').test(clause.text.toLowerCase())||selectedOrderInContext)||clause.intent==='CREATE_ORDER'&&languagePattern('semantic-request.orderReference.pattern.3').test(clause.text.toLowerCase());
    const directOrder=clause.intent==='CREATE_ORDER'&&languagePattern('semantic-request.directOrder.pattern.1').test(clause.text)&&!!argument&&!languagePattern('semantic-request.directOrder.pattern.2').test(argument);
    if(clause.intent==='CREATE_ORDER'&&!orderReference&&!directOrder&&!languagePattern('semantic-request.semanticRequest.pattern.1').test(argument))missing.push('items');
    if(orderReference){
      const numbered=languagePattern('semantic-request.numbered.pattern.1').exec(clause.text)?.[1];
      const ref=numbered??(languagePattern('semantic-request.ref.pattern.1').test(clause.text)?'LAST':'SAME');
      const authorizedLookup=!numbered&&!context.orderReference&&(!!orderRule?.rule.constraints.requiresAuthorizedLookup||selectedOrderInContext||languagePattern('semantic-request.authorizedLookup.pattern.1').test(clause.text));
      order={reference:ref,...(numbered?{resolvedReference:numbered}:context.orderReference?{resolvedReference:context.orderReference}:{}),...(authorizedLookup?{requiresAuthorizationLookup:true}:{})};
      references.push({expression:ref,kind:'order',resolved:!!order.resolvedReference||authorizedLookup,...(authorizedLookup?languageValue<{ state: "AUTHORITY_LOOKUP_REQUIRED"; }>('semantic-request.semanticRequest.value.1'):{}),...(order.resolvedReference?{target:order.resolvedReference}:authorizedLookup?languageValue<{ target: string; }>('semantic-request.semanticRequest.value.2'):{})});
      if(!order.resolvedReference&&(clause.intent==='CREATE_ORDER'||clause.intent==='REORDER'&&!authorizedLookup&&!!dictionary.semanticModel||active.length>1))missing.push('orderReference');
      if(clause.intent==='CREATE_ORDER'){const copy=addAction('REORDER',clause.id);copy.operation='COPY_ORDER_ITEMS';relationships.push({from:copy.id,relation:'uses',to:'order'});}
    }
    if(clause.intent==='TRACK_ORDER'){
      const numbered=languagePattern('semantic-request.numbered.pattern.2').exec(clause.text)?.[1];
      const resolved=numbered??context.orderReference;
      order={reference:numbered??'CURRENT',...(resolved?{resolvedReference:resolved}:{})};
      references.push({expression:order.reference,kind:'order',resolved:true,state:'AUTHORITY_LOOKUP_REQUIRED',...(resolved?{target:resolved}:languageValue<{ target: string; }>('semantic-request.semanticRequest.value.3'))});
      addAction('TRACK_ORDER',clause.id);
    }
    if(clause.intent==='REORDER'&&!orderReference){
      missing.push('orderReference');
      references.push({expression:clause.text.toUpperCase(),kind:'order',resolved:false,state:'REFERENCE_PENDING'});
    }
    const wantsItems=productIntents().has(clause.intent)||(clause.intent==='CREATE_ORDER'&&!orderReference&&(directOrder||languagePattern('semantic-request.wantsItems.pattern.1').test(argument)));
    if(wantsItems){
      if(!clause.argument.length)return null;
      // Non-product cart objects continue through the existing domain-specific rules.
      if((dictionary.actionFrames??[]).filter(f=>f.intent===clause.intent).some(f=>f.excludedObjects.some(o=>new RegExp(languageTemplate('semantic-request.semanticRequest.template.1', [o.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')])).test(argument))))return null;
      if(languagePattern('semantic-request.semanticRequest.pattern.2').test(argument))return null;
      // "above 100 and under 200" joins price bounds, not two shopping items.
      // Trim only a complete numeric price tail; other products remain intact.
      const priceAt=clause.intent==='PRODUCT_SEARCH'?clause.argument.findIndex((token,i)=>!text.slice(token.start,token.end).startsWith('"')&&priceTail().test(clause.argument.slice(i).map(t=>t.value).join(' ').replace(languagePattern('semantic-request.priceAt.pattern.1'),','))):-1;
      const itemTokens=priceAt>=0?clause.argument.slice(0,priceAt):clause.argument;
      // The compare picker sends canonical routes; token normalization removes slashes.
      // Preserve each explicit identity from the original clause before noun extraction.
      const routes=clause.intent==='PRODUCT_COMPARE'?[...clause.text.matchAll(languagePattern('semantic-request.routes.pattern.1'))].map(match=>({productText:match[1]})):[];
      const extracted:Item[]=routes.length?routes:itemsFrom(itemTokens,referenceIndex);recognizedItems+=extracted.length;
      if(extracted.some(item=>item.reference&&item.reference!=='UNSPECIFIED'&&item.reference!=='QUANTITY_CHOICE'))referenceDetected=true;
      if(!extracted.length)missing.push('items');
      const indices:number[]=[];const resolved:Item[]=[];
      for(const item of extracted){
        if(item.reference){
          if(item.reference==='QUANTITY_CHOICE'){missing.push(languageTemplate('semantic-request.semanticRequest.template.2', [items.length]));}
          else {
            const rule=findReferenceRule(item.reference,referenceIndex),targetItems=context.resultSetItems??context.selectedItems??recentItems;
            if(rule?.rule.targetKind==='RESULT_SET'){
              const available=(context.resultSetItems??[]).length>0;
              references.push({expression:item.reference,kind:'result_set',resolved:available,state:available?'AUTHORITY_LOOKUP_REQUIRED':'REFERENCE_PENDING',selectionStrategy:String(rule.rule.constraints.selectionStrategy??'LATEST_COMPATIBLE'),...(available?languageValue<{ target: string; }>('semantic-request.semanticRequest.value.4'):{})});
              if(!available)missing.push(languageTemplate('semantic-request.semanticRequest.template.3', [items.length]));
              const bound={...item};indices.push(items.length);items.push(bound);continue;
            }
            if(targetItems.length&&rule?.rule.targetKind==='ENTITY'){
              const plural=rule.rule.selectionStrategy==='LATEST_PLURAL'||rule.rule.selectionStrategy==='PREVIOUS_SELECTION'&&targetItems.length>1;
              if(plural){for(const prior of targetItems){const bound={...prior,...(item.quantity!==undefined?{quantity:item.quantity}:{}),reference:undefined,resolvedFrom:item.reference};indices.push(items.length);items.push(bound);resolved.push(bound);references.push({expression:item.reference,kind:'product',resolved:true,state:'RESOLVED',target:languageTemplate('semantic-request.semanticRequest.template.4', [items.length])});}continue;}
              if(targetItems.length===1){const bound={...targetItems[0],...(item.quantity!==undefined?{quantity:item.quantity}:{}),reference:undefined,resolvedFrom:item.reference};indices.push(items.length);items.push(bound);resolved.push(bound);references.push({expression:item.reference,kind:'product',resolved:true,state:'RESOLVED',target:languageTemplate('semantic-request.semanticRequest.template.5', [items.length])});continue;}
              const candidates=targetItems.map(candidate=>({kind:'PRODUCT_REFERENCE',value:candidate.productText??'item',score:Number((1/targetItems.length).toFixed(3))}));
              references.push({expression:item.reference,kind:'product',resolved:false,state:'AMBIGUOUS',candidates});referenceAmbiguities.push({span:item.reference,candidates,clarificationRequired:true});
            } else {
              const pending=rule?.rule.targetKind==='LOCATION'?'address':'product';
              references.push({expression:item.reference,kind:pending,resolved:false,state:'REFERENCE_PENDING'});
              missing.push(languageTemplate('semantic-request.semanticRequest.template.6', [items.length]));
            }
          }
        }
        if(item.quantity!==undefined&&(!Number.isSafeInteger(item.quantity)||item.quantity<=0||item.quantity>1000000))missing.push(languageTemplate('semantic-request.semanticRequest.template.7', [items.length]));
        indices.push(items.length);items.push(item);if(item.productText)resolved.push(item);
      }
      if(resolved.length)recentItems=resolved;
      addAction(clause.intent==='CREATE_ORDER'?'ADD_TO_CART':clause.intent,clause.id,indices);
    }
    if(clause.intent==='SET_DELIVERY_ADDRESS') {
      const result=deliveryFrom(clause.text,{...context,deliveryAddressReference:delivery?.addressReference??context.deliveryAddressReference},referenceIndex);
      delivery={...delivery,...result.delivery};missing.push(...result.missing);
      if(result.reference)references.push({expression:result.reference,kind:'address',resolved:!!delivery.addressReference,state:delivery.addressReference?'RESOLVED':'REFERENCE_PENDING',selectionStrategy:'SAVED_REFERENCE',...(delivery.addressReference?languageValue<{ target: string; }>('semantic-request.semanticRequest.value.5'):{})});
      if(!Object.keys(result.delivery).length&&!result.missing.length)missing.push('delivery.details');
      const deliveryAction=addAction(clause.intent,clause.id);
      if(!delivery.addressReference&&!result.missing.includes(languageValue<string>('semantic-request.semanticRequest.value.6'))&&(result.delivery.date||result.delivery.relativeDate||result.delivery.timeWindow))deliveryAction.operation='SET_DELIVERY_TIME';
      relationships.push({from:deliveryAction.id,relation:'uses',to:'delivery'});
      if(languagePattern('semantic-request.semanticRequest.pattern.3').test(argument)){const target=order?'order':items.length?'request.items':context.orderReference?'order':undefined;references.push({expression:'IT',kind:'order',resolved:!!target,...(target?{target}:{})});if(target)relationships.push({from:deliveryAction.id,relation:'refers_to',to:target});}
      if(deliveryAction.operation!=='SET_DELIVERY_TIME'&&(result.delivery.date||result.delivery.relativeDate||result.delivery.timeWindow))addAction('SET_DELIVERY_ADDRESS',clause.id).operation='SET_DELIVERY_TIME';
    } else if(clause.intent==='SELECT_DELIVERY_SLOT') {
      const result=deliveryFrom(clause.text,context,referenceIndex);delivery={...delivery,...result.delivery};missing.push(...result.missing);
      if(!delivery.date&&!delivery.relativeDate)missing.push('delivery.date');
      if(!delivery.timeWindow)missing.push('delivery.timeWindow');
      const action=addAction(clause.intent,clause.id);relationships.push({from:action.id,relation:'uses',to:'delivery'});
    } else if(!wantsItems&&clause.intent!=='TRACK_ORDER'||clause.intent==='CREATE_ORDER')addAction(clause.intent,clause.id);
    if(languagePattern('semantic-request.semanticRequest.pattern.4').test(argument))missing.push('unsupportedClause');
  }
  const slotNeedsResolution=(missing.length>0&&['ADD_TO_CART','PRODUCT_SEARCH','PRODUCT_COMPARE','REORDER','TRACK_ORDER','SELECT_DELIVERY_SLOT'].includes(primary))||['PRODUCT_COMPARE','REORDER','TRACK_ORDER','SELECT_DELIVERY_SLOT'].includes(primary);
  if(!force&&!passiveCartRequest(text)&&parsed.length<2&&!(primary==='CREATE_ORDER'&&items.length)&&recognizedItems<2&&!slotNeedsResolution&&!referenceDetected&&!lexicalAmbiguities.length&&!active.some(clause=>clause.intent==='ADD_TO_CART'&&packagedQuantity(clause.argument.map(token=>token.value).join(' '))))return null;
  if(items.length>50||parsed.length>32)missing.push('requestLimit');
  // Preparation operations precede the terminal action even when it occurs first in the sentence.
  const terminal=new Set(['CREATE_ORDER','START_CHECKOUT','REPEAT_ORDER']);
  actions.sort((a,b)=>Number(terminal.has(a.operation))-Number(terminal.has(b.operation)));
  for(let i=1;i<actions.length;i++)relationships.push({from:actions[i-1].id,relation:'precedes',to:actions[i].id});
  for(const a of actions.filter(a=>a.operation.startsWith('SET_DELIVERY')))relationships.push({from:a.id,relation:'modifies',to:actions.find(x=>terminal.has(x.operation))?.id??'request'});
  const conflicting=active.some(c=>c.connector===languageValue<string>('semantic-request.lexical.value.1'))||(active.some(c=>['CREATE_ORDER','REORDER'].includes(c.intent))&&active.some(c=>c.intent==='CANCEL_ORDER'));
  const entities={items,...(delivery?{delivery}:{}),...(order?{order}:{})};
  const slotResolution=resolveSlots(dictionary,primary,{entities,missing},context);
  const ambiguities=[...lexicalAmbiguities,...referenceAmbiguities];
  const graph=buildSemanticGraph({primaryIntent:primary,clauses:parsed.map(({argument:_,...clause})=>clause),actions,items,...(delivery?{delivery}:{}),...(order?{order}:{}),slots:slotResolution.slots,references,relationships,compositionRules:dictionary.semanticModel?.compositionRules??[],compositionBySignature:indexes?.compositionBySignature,ambiguities});
  if(graph.truncated)missing.push('graphLimit');
  // Preserve V1 flat status and question text; typed slots add detail without
  // changing legacy required-field semantics or message templates.
  const uniqueMissing=[...new Set(missing)];
  const status=conflicting||ambiguities.some(ambiguity=>ambiguity.clarificationRequired)?'AMBIGUOUS':uniqueMissing.length?'NEEDS_CONTEXT':'RESOLVED';
  const question=uniqueMissing.some(m=>m.includes('productText')||m==='items' || m==='productReference')?'Which product or items do you mean?':uniqueMissing.includes(languageValue<string>('semantic-request.question.value.1'))?'Which delivery address do you mean?':uniqueMissing.includes('orderReference')?'Which previous order do you mean?':uniqueMissing.some(m=>m.includes(languageValue<string>('semantic-request.question.value.2')))?'What quantity should I use for each item?':uniqueMissing.some(m=>m.startsWith(languageValue<string>('semantic-request.question.value.3')))?'What delivery date, time or address should I use?':'Please clarify the remaining part of your request.';
  const ambiguousTerms=ambiguities.filter(ambiguity=>ambiguity.clarificationRequired).map(ambiguity=>`${ambiguity.span}: ${ambiguity.candidates.map(candidate=>`${candidate.kind.toLowerCase().replaceAll('_',' ')} ${candidate.value}`).join(' or ')}`);
  return {status,primaryIntent:primary,intents:[...new Set(active.map(c=>c.intent))],entities,operations:actions.map(a=>a.operation),actions,clauses:parsed.map(({argument:_,...c})=>c),references,relationships,slots:slotResolution.slots,graph,ambiguities,missing:uniqueMissing,clarificationQuestion:slotResolution.question,message:status==='AMBIGUOUS'?(ambiguousTerms.length?languageTemplate('semantic-request.semanticRequest.template.8', [ambiguousTerms.join('; ')]):'These actions conflict or offer alternatives. Which action should I use?'):status==='NEEDS_CONTEXT'?question:'Understood. Your request has been structured for review; no commerce action has been executed.'};

 });
}

export function contextualRequest(dictionary:Dictionary,text:string,context:SemanticContext,indexes?:SemanticIndexes):{request:SemanticRequest|null;sourceText:string;context:SemanticContext} {
 return withDictionaryRecognition(dictionary,()=>{
  const direct=semanticRequest(dictionary,text,context,quotedNumericProduct(text),indexes);
  if(direct||!context.pendingRequest||(clauses(text,dictionary).length&&!languagePattern('semantic-request.contextualRequest.pattern.1').test(text.trim())))return {request:direct,sourceText:text,context};
  // Only a pending unresolved request can consume a short noun/reference answer.
  if(text.length>250||languagePattern('semantic-request.contextualRequest.pattern.2').test(text))return {request:null,sourceText:text,context};
  const previous=semanticRequest(dictionary,context.pendingRequest,context,true,indexes);
  if(!previous||previous.status!=='NEEDS_CONTEXT')return {request:null,sourceText:text,context};
  const next={...context};
  let sourceText=context.pendingRequest;
  if(previous.missing.some(m=>m.includes('productText')||m==='items')) {
    const reply=tokenize(text).map(t=>t.value);
    while(languageValue<string[]>('semantic-request.contextualRequest.value.1').includes(reply[0]))reply.shift();
    if(reply.some(w=>languageValue<string[]>('semantic-request.contextualRequest.value.2').includes(w))||dictionary.groups.some(g=>g.code.startsWith('ACTION_')&&g.terms.some(term=>term.split(' ').every((w,i)=>reply[i]===w))))return {request:null,sourceText:text,context};
    const selected=itemsFrom(tokenize(text),referenceIndexFor(dictionary,indexes));
    if(selected.length===1&&selected[0].productText){
      next.selectedItems=selected;
      sourceText=sourceText.replace(languagePattern('semantic-request.contextualRequest.pattern.3'),()=>selected[0].productText!);
    }
  } else if(previous.missing.includes(languageValue<string>('semantic-request.contextualRequest.value.3'))) {
    const selected=deliveryFrom(text,{}).delivery.addressReference;
    if(selected)next.deliveryAddressReference=selected;
  } else if(previous.missing.includes('orderReference')) {
    const number=languagePattern('semantic-request.number.pattern.1').exec(text.trim());if(number)next.orderReference=number[1];
  }
  return {request:semanticRequest(dictionary,sourceText,next,true,indexes),sourceText,context:next};

 });
}
