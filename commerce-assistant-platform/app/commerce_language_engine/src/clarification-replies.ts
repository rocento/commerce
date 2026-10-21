import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {clauses,tokenize} from './semantic-clauses.ts';
import {quantityPrefix} from './quantities.ts';
import {correctionQuantity} from './correction-numbers.ts';
import {transferReply} from './transfer-parser.ts';
import {parseRequest} from './request-parser.ts';
import {requestConstraints} from './request-constraints.ts';
import {priceCurrency} from './price-language.ts';
import type {Dictionary} from './types.ts';
import type {PendingClarification} from './semantic-types.ts';

type Prior={status:string;intent:string|null;missing?:string[];entities:Record<string,any>;requestType?:string;operations?:string[]};
const quantityMissing=(missing:string)=>missing==='quantity'||languagePattern('clarification-replies.quantityMissing.pattern.1').test(missing);
const productMissing=(missing:string)=>missing==='productReference'||missing==='items'||languagePattern('clarification-replies.productMissing.pattern.1').test(missing);
const productIntents=()=>recognitionMemo('clarification-replies.productIntents',()=>(new Set(['PRODUCT_SEARCH','PRODUCT_RECOMMEND','ADD_TO_CART','REMOVE_FROM_CART','ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST','PRODUCT_COMPARE'])));

export function pendingClarification(prior:Prior,text:string):PendingClarification|undefined {
  if(prior.status!=='NEEDS_CONTEXT'||!prior.intent||prior.entities.requestConstraints||requestConstraints(text).constraints.length)return;
  const missing=prior.missing??[];
  if(missing.filter(quantityMissing).length===1)return {text,intent:prior.intent,slot:'quantity'};
  if(!prior.requestType&&productIntents().has(prior.intent)&&missing.filter(productMissing).length===1)return {text,intent:prior.intent,slot:'product'};
}

/** A reply may fill one proven missing slot, never replace the request or its qualifiers. */
export function clarificationText(dictionary:Dictionary,pending:PendingClarification,prior:Prior,reply:string):string|undefined {
 return withDictionaryRecognition(dictionary,()=>{
  if(prior.intent!==pending.intent||prior.entities.requestConstraints||requestConstraints(pending.text).constraints.length)return;
  const answer=reply.trim().replace(languagePattern('clarification-replies.answer.pattern.1'),'').replace(languagePattern('clarification-replies.answer.pattern.2'),'').trim();
  if(!answer||answer.length>250||languagePattern('clarification-replies.clarificationText.pattern.1').test(answer))return;
  if(pending.slot==='currency'){
    if(prior.status!=='RESOLVED'||prior.requestType||!['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(prior.intent??'')||!prior.entities.price||prior.entities.price.currency||prior.entities.currency)return;
    const code=priceCurrency(answer.toLowerCase().replace(languagePattern('clarification-replies.code.pattern.1'),''));
    return code?pending.text.trim().replace(languagePattern('clarification-replies.clarificationText.pattern.2'),'')+' '+code:undefined;
  }
  const expected=pendingClarification(prior,pending.text);
  if(expected?.slot!==pending.slot)return;
  if(pending.slot==='quantity'){
    const value=correctionQuantity(answer.toLowerCase().replace(languagePattern('clarification-replies.value.pattern.1'),''));
    if(value===undefined)return;
    if(['CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST'].includes(prior.intent??'')){
      return transferReply(dictionary,String(value),{pendingRequest:pending.text},parseRequest);
    }
    // Find the unresolved numeric prefix using original token offsets. Replacing
    // the range avoids leaving a second contradictory number elsewhere.
    const candidates=clauses(pending.text,dictionary).filter(clause=>!clause.negated&&['ADD_TO_CART','REMOVE_FROM_CART','PRODUCT_SEARCH'].includes(clause.intent)).flatMap(clause=>{
      const tokens=clause.argument,q=quantityPrefix(tokens.map(token=>token.value));
      if(!q.end||!q.quantityRange&&(q.quantity===undefined||Number.isSafeInteger(q.quantity)&&q.quantity>0&&q.quantity<=1000000))return [];
      return [{start:tokens[0].start,end:tokens[q.end-1].end}];
    });
    if(candidates.length!==1)return;
    const span=candidates[0];return pending.text.slice(0,span.start)+value+pending.text.slice(span.end);
  }
  // Only a complete noun phrase can fill a product. Attributes, amounts, new
  // actions and confirmation words require a new request or their own question.
  if(languagePattern('clarification-replies.clarificationText.pattern.3').test(answer)||languagePattern('clarification-replies.clarificationText.pattern.4').test(answer)||clauses(answer,dictionary).length)return;
  const tokens=tokenize(answer);
  if(!tokens.length||tokens.some(token=>token.quoted)||!tokens.some(token=>languagePattern('clarification-replies.clarificationText.pattern.5').test(token.value)))return;
  const parsed=quantityPrefix(tokens.map(token=>token.value));
  if(parsed.quantity!==undefined||parsed.quantityRange)return;
  const reference=languagePattern('clarification-replies.reference.pattern.1').exec(pending.text);
  if(!reference)return;
  return pending.text.slice(0,reference.index)+answer+pending.text.slice(reference.index+reference[0].length);

 });
}

export const clarificationQuestion=(slot:PendingClarification['slot'])=>slot==='quantity'?'How many should I use? Give one positive whole number.':slot==='currency'?'Which currency should I use? For example, USD or EGP.':'Which product do you mean? Give its full name or select a product.';
