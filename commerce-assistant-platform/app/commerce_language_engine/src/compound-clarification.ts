import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {clarificationText} from './clarification-replies.ts';
import type {IntentCount} from './intent-count.ts';
import type {Dictionary} from './types.ts';

type Review = IntentCount & {status:string;entities:Record<string,any>};
export type CompoundReply = 'filled'|'replaced'|'cancelled'|'rejected';
const additions=()=>recognitionMemo('compound-clarification.additions',()=>(new Set(['ADD_TO_CART','ADD_TO_WISHLIST'])));
export function reviewedPair(prior:Review):boolean {
  return !['DENIED','UNSUPPORTED'].includes(prior.status)&&prior.requestedActions.length===2
    &&new Set(prior.requestedActions.map(a=>a.intent)).size===2
    &&prior.requestedActions.every(a=>additions().has(a.intent));
}

/** Linguistic continuation only. The application must bind it to a scoped revision. */
export function compoundReply(dictionary:Dictionary,original:string,reply:string,prior:Review,resolve:(text:string)=>Review):{text:string;disposition:CompoundReply} {
 return withDictionaryRecognition(dictionary,()=>{
  const rejected={text:original,disposition:'rejected' as const};
  if(!reviewedPair(prior))return rejected;
  if(languagePattern('compound-clarification.compoundReply.pattern.1').test(reply.trim()))return {text:original,disposition:'cancelled'};
  // An explicit complete replacement is interpreted independently, never patched
  // into the old text. A reply such as "yes" cannot approve a disputed parse.
  const replacement=reply.trim().replace(languagePattern('compound-clarification.replacement.pattern.1'),'');
  const fresh=resolve(replacement);
  if(fresh.intentCountStatus==='EXACT'&&fresh.requestedActions.length>0&&fresh.requestedActions.length<=2
    &&fresh.requestedActions.every(a=>additions().has(a.intent))&&!fresh.entities.requestConstraints
    &&!['DENIED','UNSUPPORTED'].includes(fresh.status))return {text:replacement,disposition:'replaced'};
  if(prior.requestedActionIssues.some(i=>i!=='UNRESOLVED_PRODUCT')||prior.entities.requestConstraints)return rejected;
  const pending={text:original,intent:'ADD_TO_CART',slot:'product' as const};
  const text=clarificationText(dictionary,pending,languageValue<{ status: string; intent: string; missing: string[]; entities: {}; }>('compound-clarification.text.value.1'),reply);
  if(!text||text.length>4000)return rejected;
  const next=resolve(text);
  if(!reviewedPair(next)||next.intentCountStatus!=='EXACT')return rejected;
  // Preserve every known binding and the customer's order; only unresolved
  // product references may change. An answer cannot alter a known quantity.
  const preserved=prior.requestedActions.every((a,index)=>{
    const b=next.requestedActions[index];
    return a.intent===b.intent&&a.after===b.after&&a.items.length===b.items.length&&a.items.every((item,i)=>{
      const filled=b.items[i];
      return (!item.productText||item.productText===filled.productText)&&item.quantity===filled.quantity&&item.unit===filled.unit;
    });
  });
  return preserved?{text,disposition:'filled'}:rejected;

 });
}
