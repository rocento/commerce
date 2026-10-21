/** Reviewed authoring semantics; predictions and runtime results are deliberately not inputs. */
import {isDeepStrictEqual} from 'node:util';
import type {CorpusCase} from '../types.ts';

export const contracts={
 industry_scope:{rationale:'The authoring family explicitly names its industry. Supply that scope consistently to every industry-authored case, including already passing siblings; do not pretend that a context-free homonym has one meaning.',evidence:'src/generation/data-expansion.ts: expansionCases; tests/routing-collision-regression.test.ts'},
 nonliteral:{rationale:'Explicit pretend commands and requests for a joke are recognized nonliteral conversation, with no commerce operations. This is distinct from translate/story requests, which remain UNKNOWN.',evidence:'tests/conversation.test.ts; src/generation/coverage-cases.ts: explicit-nonliteral-conversation'},
 generic_product:{rationale:'Any N fresh items describes quantity and properties but never identifies a product. Preserve every asserted quantity, selection and freshness field; require clarification instead of approving an arbitrary item.',evidence:'tests/scoring.test.ts; tests/semantic-request.test.ts: clarification policy'},
 missing_product_target:{rationale:'Naming the cart or wishlist identifies a collection, not the product to add/remove. A collection write without an item requires clarification. This applies to all generated siblings, regardless of the old engine result.',evidence:'tests/semantic-request.test.ts: product and pronoun clarification; src/generation/corpus.ts; src/generation/coverage-cases.ts'},
 physical_bag_ambiguity:{rationale:'An add request for bag/shopping bag with no destination or selected item can refer to a physical product or cart collection. Ask for product/action selection rather than assume a cart write.',evidence:'tests/product-guidance.test.ts: incomplete positive commands and explicit destinations'},
 transfer_target:{rationale:'Cart/wishlist item identifies the source collection but not a specific item. A transfer requires a product reference; the existing intent-command generator already marks the same commands NEEDS_CONTEXT.',evidence:'src/generation/corpus.ts: CART_MOVE_FROM_WISHLIST/CART_MOVE_TO_WISHLIST statuses'},
 cart_quantity_read:{rationale:'The cart read contract deliberately returns one verified quantity-and-money snapshot for item-count and pricing questions. CART_TOTAL is the established route; preserve quantity semantics in that response instead of inventing a different route for polite wrappers.',evidence:'src/cart-pricing-language.ts: quantity questions; tests/cart-pricing-language.test.ts'},
 offer_discovery:{rationale:'Unqualified show/find deals or offers requests use verified discount-ranked product discovery. Keep promotion terms, eligibility, constrained products and other actions separate.',evidence:'tests/recommendation-discovery.test.ts; src/read-language.ts: canonical offer reads'},
 literal_question_product:{rationale:'The governed question.search templates preserve the literal product span, including case. The older conversational-search generator lowercased every head. Correct only these complete unpriced question frames; preserve exact entity comparison for all fields.',evidence:'data/knowledge/shopping-en-phase2-v3.json: question.search; tests/question-language.test.ts: literal Acme Notebook/Atlas Laptop names'},
 repeat_without_antecedent:{rationale:'Do it again expresses repetition but supplies no previous action/order. Preserve REORDER as a clarification intent and require its antecedent; no operation may execute.',evidence:'tests/semantic-request.test.ts: order references remain unresolved without explicit context'},
 order_list_not_selection:{rationale:'ORDER_LIST_VISIBLE and ORDER_HISTORY identify a list, not a selected order. Repetition of that context must ask which order. Apply to every repeat synonym, including old passing siblings.',evidence:'tests/semantic-request.test.ts: order references; src/generation/corpus.ts: transition fixtures'},
 visible_products_not_selection:{rationale:'A visible result list does not choose a product for a bare add command. Require clarification; keep a genuinely PRODUCT_SELECTED transition unchanged.',evidence:'tests/semantic-request.test.ts: pronouns and explicit selected items; src/generation/corpus.ts: transition fixtures'},
 product_is_not_order:{rationale:'The explicit noun product must not be reinterpreted as an order by an order-list context. With no product result context, this ordinal fragment is UNKNOWN.',evidence:'tests/routing-collision-regression.test.ts: ordinal product context requirements'},
 missing_pronoun_antecedent:{rationale:'The product pronouns it/this have no supplied selected product. Preserve the requested allergen/ingredient intent and ask for the product before giving product facts.',evidence:'tests/routing-read-regression.test.ts: selected product fixtures; src/generation/conversation-cases.ts'},
 duplicate_cancellation:{rationale:'An explicit cancel verb requests cancellation of a duplicate/repeated order. It is not a report of duplication. Resolution identifies the language intent only; downstream authority/confirmation remain required.',evidence:'src/generation/coverage-cases.ts: order-action-reference-contrasts; dictionary CANCEL_ORDER versus ORDER_DUPLICATE'},
};

/** Only original text, provenance and context drive a correction. No runtime import or predictions. */
export function adjudicateCase(input:CorpusCase){
 const next=structuredClone(input),rules:string[]=[];
 const add=(rule:keyof typeof contracts,patch:Partial<CorpusCase>)=>{Object.assign(next,patch);rules.push(rule);};
 const source=input.source??'',family=input.templateFamily??'',text=input.text.toLowerCase();
 if(source==='industry-coverage-v7'){
  const industry=family.match(/^industry-(?:search|cart|information|negation|missing-action)-(GROCERY|FASHION|BEAUTY|PHARMACY|ELECTRONICS|JEWELRY|HOME|AUTOMOTIVE|B2B)(?:-|$)/)?.[1];
  if(industry&&input.context?.industry!==industry)add('industry_scope',{context:{...input.context,industry}});
 }
 if(source==='contrastive-coverage-v6'&&family==='metalinguistic-command-2'&&/^pretend to /.test(text)||source==='contrastive-v2'&&family==='out-of-domain'&&text==='tell me a joke')add('nonliteral',{intent:'CONVERSATION_JOKE',status:'RESOLVED'});
 if(source==='compositional-structure-v4'&&/\bany (?:two|three|twelve|twenty-one) fresh items\b/.test(text)||source==='linguistic-coverage-v6'&&text==='pop any two items in the basket')add('generic_product',{status:'NEEDS_CONTEXT'});
 if(['intent-command-v2','syntax-composition-v6'].includes(source)&&['ADD_TO_CART','ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST'].includes(input.intent??'')){
  if(input.intent==='ADD_TO_CART'&&/\b(?:shopping bag|bag)\b/.test(text))add('physical_bag_ambiguity',{intent:'PRODUCT_ACTION_CHOICE',status:'NEEDS_CONTEXT'});
  else add('missing_product_target',{status:'NEEDS_CONTEXT'});
 }
 if(source==='syntax-composition-v6'&&['CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST'].includes(input.intent??''))add('transfer_target',{status:'NEEDS_CONTEXT'});
 if(input.intent==='CART_ITEM_COUNT')add('cart_quantity_read',{intent:'CART_TOTAL'});
 if(['intent-command-v2','syntax-composition-v6'].includes(source)&&input.intent==='CHECK_PROMOTION'&&/\b(?:show(?: me)?|find) (?:(?:my|the) )?(?:deals|offers)\b/.test(text))add('offer_discovery',{intent:'PRODUCT_RECOMMEND',entities:{...input.entities,discountRanking:true}});
 if(source==='product-search-requests-v2'&&family==='conversational-search'&&input.intent==='PRODUCT_SEARCH'&&!input.entities?.price){
  const literal=input.text.match(/^(?:do you sell|where can i find) (.+)$/i)?.[1];
  if(literal&&literal.toLowerCase()===input.entities?.productText&&literal!==input.entities.productText)add('literal_question_product',{entities:{...input.entities,productText:literal}});
 }
 if(source==='curated-core-v1'&&text==='do it again'&&!input.context)add('repeat_without_antecedent',{intent:'REORDER',status:'NEEDS_CONTEXT'});
 if(source==='transition-v2'&&input.intent==='REORDER'&&input.context?.previousIntent==='ORDER_HISTORY'&&input.context.states?.includes('ORDER_LIST_VISIBLE'))add('order_list_not_selection',{status:'NEEDS_CONTEXT'});
 if(source==='transition-v2'&&input.intent==='ADD_TO_CART'&&input.context?.states?.includes('PRODUCT_RESULTS_VISIBLE')&&!input.context.states.includes('PRODUCT_SELECTED'))add('visible_products_not_selection',{status:'NEEDS_CONTEXT'});
 if(source==='transition-v2'&&input.intent==='SELECT_ORDER'&&/\b(?:first|second|last) product\b/.test(text))add('product_is_not_order',{intent:null,status:'UNKNOWN'});
 if(source==='authored-conversation-v3'&&['does it contain sesame','are there traces of peanuts in it','what ingredients are in this'].includes(text)&&!input.context)add('missing_pronoun_antecedent',{status:'NEEDS_CONTEXT'});
 if(['intent-command-v2','syntax-composition-v6'].includes(source)&&input.intent==='ORDER_DUPLICATE'&&/\bcancel\b/.test(text))add('duplicate_cancellation',{intent:'CANCEL_ORDER'});
 // Do not create vacuous patches for cases already correct under the same contract.
 return {next,rules,changed:!isDeepStrictEqual(input,next)};
}

