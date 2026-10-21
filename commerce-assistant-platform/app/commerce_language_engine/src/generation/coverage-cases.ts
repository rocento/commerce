import type {CorpusCase,Dictionary} from '../types.ts';

export const coverageSource='linguistic-coverage-v6';
type Row={family:string;split:NonNullable<CorpusCase['split']>;intent:string|null;status?:string;difficulty:string;texts:string[];context?:CorpusCase['context']};
// Independently authored structures. Labels express desired semantics, never model predictions.
const rows:Row[]=[
 {family:'reorder-reconstruction',split:'train',intent:'REORDER',difficulty:'PARAPHRASE',texts:[
  'recreate my last order','repeat the previous order','repurchase my prior order','recreate the order from before','repeat my latest order','re-order the previous order','my previous order is the one to recreate','the last order is what I want you to repeat',
 ]},
 {family:'reorder-equivalence',split:'development',intent:'REORDER',difficulty:'REFERENCE',texts:[
  'order the same things again','buy the same things once more','purchase the same items again','same last order please','same previous order','the same order again please','make the order again','place that order again',
 ],context:{previousIntent:'SELECT_ORDER',states:['ORDER_SELECTED']}},
 {family:'reorder-purchase-memory',split:'test',intent:'REORDER',difficulty:'REFERENCE',texts:[
  'buy what I bought before','purchase what I purchased previously','order what I ordered last time','get what I bought previously','buy the things I purchased earlier','what I bought before is what I want to buy','do that order again','make my previous order again',
 ],context:{previousIntent:'ORDER_DETAILS',states:['ORDER_SELECTED']}},
 {family:'reorder-demonstrative-unbound',split:'development',intent:'REORDER',status:'NEEDS_CONTEXT',difficulty:'CONTEXT_REQUIRED',texts:['do that order again','repeat this order','recreate that order','make this order again']},
 {family:'reorder-demonstrative-bound',split:'test',intent:'REORDER',difficulty:'CONTEXT_REQUIRED',context:{previousIntent:'SELECT_ORDER',states:['ORDER_SELECTED']},texts:['repeat that order','recreate this order','do this order again','place this order again']},
 {family:'reorder-ellipsis-bound',split:'train',intent:'REORDER',difficulty:'CONTEXT_REQUIRED',context:{previousIntent:'ORDER_DETAILS',states:['ORDER_SELECTED']},texts:['same again','once more','do it again','one more time']},
 {family:'reorder-negative-command',split:'test',intent:null,status:'UNKNOWN',difficulty:'NEGATION',texts:[
  'do not recreate my last order','never repeat my previous order','please do not repurchase the last order','do not buy what I bought before','never order the same things again','do not make the order again','do not repeat this order','do not purchase what I purchased before',
 ]},
 {family:'reorder-reference-is-not-action',split:'development',intent:null,status:'UNKNOWN',difficulty:'HARD_NEGATIVE',texts:[
  'my previous order','same color','again','last time','previous','the same things','bought before','my prior purchase','last order','same address','same delivery date','identical packaging','once more','before the weekend',
 ]},
 {family:'reorder-competing-actions',split:'test',intent:null,status:'AMBIGUOUS',difficulty:'AMBIGUOUS',texts:[
  'cancel and recreate my order','repeat and cancel the order','recreate my order or cancel my order','new order','recent order','latest order',
 ]},
 {family:'order-action-reference-contrasts',split:'development',intent:'CANCEL_ORDER',difficulty:'HARD',texts:['cancel my previous order','scrap my prior order','call off my last order','the last order is what I want you to cancel']},
 {family:'tracking-location-questions',split:'train',intent:'TRACK_ORDER',difficulty:'PARAPHRASE',texts:['where is my parcel','track the shipment for me','can you trace my consignment','locate my package','where has my shipment gone','my package is the one to track','trace the delivery package','where is the order I placed']},
 {family:'cart-command-argument-order',split:'train',intent:'ADD_TO_CART',difficulty:'PARAPHRASE',texts:['please put three mangosteens into my shopping basket','include two quasar widgets in my cart','pop any two items in the basket','place a dozen oranges into the shopping cart','toss a pair of socks in my cart','drop six bottles into my basket']},
 {family:'cart-view-list-synonym',split:'test',intent:'VIEW_CART',difficulty:'PARAPHRASE',texts:['list my cart','list the items in my basket']},
 {family:'cart-remove-prepositional',split:'test',intent:'REMOVE_FROM_CART',difficulty:'PARAPHRASE',texts:['take two shirts out of my shopping basket','remove the blue shoes from the cart','take one quasar widget off the basket','delete three mangosteens from my cart','take out two rugs from my basket']},
 {family:'wishlist-destination-contrast',split:'development',intent:'ADD_TO_WISHLIST',difficulty:'HARD',texts:['save two quasar widgets to my wish list','put these headphones in my favorites','add one chair to my wishlist','place two shirts in my favourites'],context:{states:['PRODUCT_SELECTED']}},
 {family:'search-open-catalog',split:'test',intent:'PRODUCT_SEARCH',difficulty:'PARAPHRASE',texts:['find quasar widgets','seek veltronic modules','search for copper adapters','look around for linen curtains','hunt for amber lamps','find teal organizers']},
 {family:'comparison-open-catalog',split:'development',intent:'PRODUCT_COMPARE',difficulty:'PARAPHRASE',texts:['compare quasar widgets','contrast linen curtains','weigh up the headphones','compare these jackets'],context:{states:['PRODUCT_SELECTED']}},
 {family:'return-object-fronting',split:'development',intent:'RETURN_ITEM',difficulty:'PARAPHRASE',texts:['send back the linen curtains','ship back the headphones','give back the amber lamp','return the mangosteens']},
 {family:'address-indirect-requests',split:'train',intent:'CHANGE_ADDRESS',difficulty:'PARAPHRASE',texts:['the shipping address is what I want you to change','could you edit my delivery address','I would appreciate you updating the shipping address','please revise the destination address','can you modify my shipping address']},
 {family:'support-human-requests',split:'test',intent:'CONTACT_SUPPORT',difficulty:'PARAPHRASE',texts:['connect me with a human','I want to speak with an agent','can I talk to customer service','let me speak to a person','please reach customer support']},
 {family:'refund-event-reports',split:'test',intent:'REFUND_MISSING',difficulty:'PARAPHRASE',texts:['my refund has not arrived','the reimbursement never arrived','I am still waiting for my refund','my money back is missing','my refund was not received']},
 {family:'damage-event-reports',split:'development',intent:'ORDER_DAMAGED',difficulty:'PARAPHRASE',texts:['my parcel arrived broken','the package was delivered damaged','I received a cracked item','the shipment arrived smashed','the item I got is defective']},
 {family:'wrong-item-event-reports',split:'train',intent:'ORDER_WRONG_ITEM',difficulty:'PARAPHRASE',texts:['I received the wrong item','the package contained a different product','my order arrived with an incorrect item','they sent the wrong product','I got an item different from what I ordered']},
 {family:'payment-event-reports',split:'development',intent:'PAYMENT_DUPLICATE_CHARGE',difficulty:'PARAPHRASE',texts:['I was billed two times','you charged me more than once','my account was debited twice','the shop billed me twice','money was taken from my account twice']},
 {family:'loyalty-negative-state',split:'test',intent:'LOYALTY_MISSING_POINTS',difficulty:'NEGATION',texts:['my reward points were not credited','the points never arrived','I did not receive my loyalty points','my rewards are missing','my points are not showing']},
 {family:'restock-notification-condition',split:'train',intent:'STOCK_ALERT_CREATE',difficulty:'PARAPHRASE',texts:['alert me when the jacket is restocked','let me know when the lamp is available again','text me when these shoes are back on sale','send me a notification when the item is in stock again','keep me posted when the headset is restocked'],context:{states:['PRODUCT_SELECTED']}},
 {family:'restock-notification-stop',split:'development',intent:'STOCK_ALERT_CANCEL',difficulty:'PARAPHRASE',texts:['stop restock notifications','disable the stock alert','cancel the restock alert','turn off back in stock notifications','unsubscribe from restock alerts']},
 {family:'negation-scope-correction',split:'development',intent:'TRACK_ORDER',difficulty:'NEGATION',texts:['do not cancel my order but track it','never cancel my order just track the order','do not cancel the order instead trace the shipment'],context:{states:['PRODUCT_SELECTED']}},
 {family:'explicit-nonliteral-conversation',split:'test',intent:'CONVERSATION_JOKE',difficulty:'HARD_NEGATIVE',texts:['imagine you recreate my last order','pretend to add shirts to cart']},
 {family:'noncommerce-metalinguistic',split:'test',intent:null,status:'UNKNOWN',difficulty:'HARD_NEGATIVE',texts:[
  'write a poem about canceling an order','write a story about tracking a parcel','translate cancel my order','define the word reorder','what does the word refund mean','write a poem about adding shoes to a cart','translate repeat my previous order','write a story about my refund',
 ]},
 {family:'noncommerce-overlapping-vocabulary',split:'development',intent:null,status:'UNKNOWN',difficulty:'HARD_NEGATIVE',texts:[
  'my phone battery was charged twice','the electric car was charged twice','my story needs a different order','cancel the music lesson','the chair is next to the rug','same melody again','repeat the previous paragraph','recreate the last painting','buying time is an expression','remove the punctuation from this sentence','return to the previous paragraph','the strawberry shampoo smells nice',
 ]},
 {family:'incomplete-command-fragments',split:'train',intent:null,status:'UNKNOWN',difficulty:'INCOMPLETE',texts:['cancel','remove','compare','search','find','return','recreate','repeat','previous one','same','last','again please','to my','from the','can you','could you please','please I need help','I want','help','my order is']},
 {family:'cart-underspecified-slots',split:'development',intent:'ADD_TO_CART',status:'NEEDS_CONTEXT',difficulty:'INCOMPLETE',texts:['add two items to cart','put some products in the basket','add this to cart','put that in my basket','add two or three shirts to cart']},
 {family:'cart-related-actions-add-remove',split:'test',intent:'REMOVE_FROM_CART',difficulty:'COMPOUND',texts:['add shoes to cart and remove socks from cart']},
 {family:'cart-related-actions-remove-add',split:'test',intent:'ADD_TO_CART',difficulty:'COMPOUND',texts:['remove shirts from cart and add trousers to cart']},
 {family:'cart-explicit-opposition',split:'test',intent:null,status:'AMBIGUOUS',difficulty:'AMBIGUOUS',texts:['add two lamps to cart or remove one lamp from cart','add and remove shoes from cart']},
 {family:'informal-and-typo-requests',split:'test',intent:'REORDER',difficulty:'TYPO_NOISE',texts:['pls recreate my last order','plz repeat the previous order','reorder my last ordar','repeat my previous order pls','repurchase mi last order']},
 {family:'tracking-typo-requests',split:'development',intent:'TRACK_ORDER',difficulty:'TYPO_NOISE',texts:['trak my order','wheres mi ordar','pls trak my package','plz trace mi shipment','trak the parcel please']},
 {family:'cancel-typo-requests',split:'train',intent:null,status:'NEEDS_CONTEXT',difficulty:'TYPO_NOISE',texts:['cancle my order','pls cancle mi order','cancle the last order','plz cancle my previous order','cancle my order please']},
];

export function authoredCoverageCases():CorpusCase[] {
 return rows.flatMap(r=>r.texts.map(text=>({text,intent:r.intent,status:r.status??'RESOLVED',difficulty:r.difficulty,split:r.split,templateFamily:r.family,source:coverageSource,...(r.context?{context:r.context}:{})})));
}

// Syntactic families are partitioned, not randomly split rows of the same frame.
const structures=[
 {id:'object-fronted-focus',split:'train',render:(a:string,o:string)=>`regarding the ${o}, could you ${a}`},
 {id:'reason-before-command',split:'train',render:(a:string,o:string)=>`so we can continue, ${a} my ${o}`},
 {id:'request-with-beneficiary',split:'train',render:(a:string,o:string)=>`${a} the ${o} for me`},
 {id:'infinitive-purpose',split:'train',render:(a:string,o:string)=>`I am here to ${a} my ${o}`},
 {id:'modal-capability',split:'train',render:(a:string,o:string)=>`would you be able to ${a} the ${o}`},
 {id:'request-imperative-timing',split:'train',render:(a:string,o:string)=>`${a} my ${o} before we continue`},
 {id:'question-with-time-adjunct',split:'development',render:(a:string,o:string)=>`when you have a moment, could you ${a} my ${o}`},
 {id:'embedded-request',split:'development',render:(a:string,o:string)=>`I was hoping you could ${a} the ${o}`},
 {id:'conditional-feasibility',split:'development',render:(a:string,o:string)=>`if possible, ${a} my ${o}`},
 {id:'command-plus-reason',split:'development',render:(a:string,o:string)=>`${a} my ${o} so I can continue`},
 {id:'relative-clause-focus',split:'test',render:(a:string,o:string)=>`please ${a} the ${o} I mentioned earlier`},
 {id:'permission-to-delegate',split:'test',render:(a:string,o:string)=>`may I ask you to ${a} my ${o}`},
 {id:'urgency-fronted',split:'test',render:(a:string,o:string)=>`before we go any further, ${a} my ${o}`},
 {id:'embedded-wish',split:'test',render:(a:string,o:string)=>`what I would like is for you to ${a} the ${o}`},
 {id:'deferred-request',split:'test',render:(a:string,o:string)=>`${a} the ${o} when you get a chance`},
] as const;
const nonNominal=new Set(['made of','made','work with','use','wash','clean','in stock','available','returnable','delivery available','pickup available','back in stock','how to store','what is included']);
const commands=new Set(['show','display','find','list','read','download','get','create','add','remove','delete','change','update','cancel','start','select','choose','request','report','track','view','open','apply','use','redeem','print','resend','schedule','book','extend','restore','save','share','rename','set','retry','explain','enable','disable','accept','reject','upload','join','leave','resume','skip','reopen','close','escalate','verify','play','archive','unarchive','export','merge','replace','move','pause','stop','clear','trace','inspect','discard','scrap']);
export function* compositionalCoverageCases(d:Dictionary):Generator<CorpusCase> {
 const groups=new Map(d.groups.map(g=>[g.code,g]));
 for(const i of d.intents){
  if(i.family==='Conversation'||i.states.length||i.productArgument)continue;
  const required=i.conditions.filter(c=>c.kind==='REQUIRED');if(required.length!==2)continue;
  const actions=groups.get(required[0].group)!.terms.filter(t=>commands.has(t));
  const objects=groups.get(required[1].group)!.terms.filter(t=>!['item','items','product','products'].includes(t)&&!nonNominal.has(t));
  // Cover structures first, then lexical alternatives. This is bounded per intent
  // so large synonym inventories cannot swamp smaller intent families.
  let count=0;
  for(let variant=0;variant<Math.max(actions.length,objects.length);variant++)for(const structure of structures){
   if(!actions.length||!objects.length||count>=90)break;
   const a=actions[variant%actions.length],o=objects[variant%objects.length];count++;
   yield {text:structure.render(a,o),intent:i.code,difficulty:'PARAPHRASE',split:structure.split,templateFamily:structure.id,source:'syntax-composition-v6'};
  }
  if(!actions.length||!objects.length)continue;
  for(const [index,negation] of ['please do not','never','do not','can you please not','I said not to','you must not'].entries()){
   yield {text:`${negation} ${actions[index%actions.length]} my ${objects[index%objects.length]}`,intent:null,status:'UNKNOWN',difficulty:'NEGATION',split:index<2?'train':index<4?'development':'test',templateFamily:'scoped-negation-'+index,source:'contrastive-coverage-v6'};
  }
  for(const [index,prefix] of ['translate','write a story about how to','pretend to'].entries())yield {
   text:`${prefix} ${actions[0]} my ${objects[0]}`,intent:null,status:'UNKNOWN',difficulty:'HARD_NEGATIVE',split:index===0?'train':index===1?'development':'test',templateFamily:'metalinguistic-command-'+index,source:'contrastive-coverage-v6',
  };
 }
 const actionLexemes=[...new Set(d.groups.filter(g=>g.code.startsWith('ACTION_')).flatMap(g=>g.terms).filter(t=>commands.has(t)))];
 for(const action of actionLexemes)for(const [index,text] of [`${action} my`, `could you ${action}`, `please ${action} the`].entries())yield {
  text,intent:null,status:'UNKNOWN',difficulty:'INCOMPLETE',split:index===0?'train':index===1?'development':'test',templateFamily:'incomplete-argument-'+index,source:'fragment-coverage-v6',
 };
 for(const [a,b] of d.conflicts){
  const first=d.intents.find(i=>i.code===a)!,second=d.intents.find(i=>i.code===b)!;
  if(first.conditions[1]?.group!==second.conditions[1]?.group)continue;
  const firstAction=groups.get(first.conditions[0].group)!.terms.find(t=>commands.has(t));
  const secondAction=groups.get(second.conditions[0].group)!.terms.find(t=>commands.has(t));
  if(!firstAction||!secondAction||firstAction===secondAction)continue;
  for(const object of groups.get(first.conditions[1].group)!.terms.slice(0,2))for(const [index,text] of [
   `either ${firstAction} or ${secondAction} my ${object}`,
   `${firstAction} my ${object} or ${secondAction} my ${object}`,
   `should I ${firstAction} or ${secondAction} the ${object}`,
   `I cannot decide whether to ${firstAction} or ${secondAction} my ${object}`,
  ].entries())yield {text,intent:null,status:'AMBIGUOUS',difficulty:'AMBIGUOUS',split:index<2?'train':index===2?'development':'test',templateFamily:'alternative-actions-'+index,source:'ambiguity-coverage-v6'};
 }
 // Context contrasts have identical words but different reference environments.
 for(const [index,text] of ['same again','once more','do it again','one more time','repeat that order','do that order again'].entries())for(const bound of [false,true])yield {
  text,intent:bound||index>=4?'REORDER':null,status:bound?'RESOLVED':index>=4?'NEEDS_CONTEXT':'UNKNOWN',difficulty:'CONTEXT_REQUIRED',split:'test',templateFamily:'reference-context-pairs-v6',source:'context-coverage-v6',context:bound?{previousIntent:'ORDER_DETAILS',states:['ORDER_SELECTED']}:{previousIntent:'PRODUCT_SEARCH',states:['PRODUCT_RESULTS_VISIBLE']},
 };
 // More than surface misspellings: request fragments, abbreviations, and noisy
 // casing retain the same action/object relationship. Catalog words are untouched.
 const typoActions:[string,string,string][]=[['TRACK_ORDER','trak','order'],['OPTIMIZE_CART','optmize','cart']];
 for(const [intent,action,object] of typoActions)for(const owner of ['my','mi','the','our'])for(const suffix of ['pls','plz','please','thanks','now'])for(const form of [0,1,2])yield {
  text:form===0?`${action} ${owner} ${object} ${suffix}`:form===1?`${suffix}, ${action} ${owner} ${object}`:`${action.toUpperCase()} ${owner} ${object} ${suffix}!`,intent,difficulty:'TYPO_NOISE',split:form===0?'train':form===1?'development':'test',templateFamily:'informal-syntax-'+form,source:'informal-coverage-v6',
 };
}
