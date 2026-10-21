import type {CorpusCase} from '../types.ts';
export const transferSource='collection-transfer-v1';
/** Authored targets exercise grammar, selection, direction and abstention. */
export function* transferCases():Generator<CorpusCase>{
 const directions=[
  {intent:'CART_MOVE_FROM_WISHLIST',source:'wishlist',destination:'cart',sources:['wishlist','wish list','favorites'],targets:['cart','basket','shopping cart']},
  {intent:'CART_MOVE_TO_WISHLIST',source:'cart',destination:'wishlist',sources:['cart','basket','shopping basket'],targets:['wishlist','wish list','favourites']},
 ];
 const items=[
  {text:'item',status:'NEEDS_CONTEXT',entities:{}},
  {text:'two items',status:'NEEDS_CONTEXT',entities:{quantity:2}},
  {text:'it',status:'NEEDS_CONTEXT',entities:{product_reference:'CURRENT'}},
  {text:'two black shoes',status:'RESOLVED',entities:{quantity:2,productText:'black shoes'}},
  {text:'quasar widgets',status:'RESOLVED',entities:{productText:'quasar widgets'}},
  {text:'two socks and three mugs',status:'RESOLVED',entities:{line_items:[{description:'socks',quantity:2},{description:'mugs',quantity:3}]}},
 ];
 for(const d of directions)for(const action of ['move','transfer'])for(const source of d.sources)for(const target of d.targets){
  for(const [prefix,split] of [['','train'],['could you ','development'],['please ','test']] as const)for(const item of items){
   const forms=[`${action} ${item.text} from my ${source} to the ${target}`,`${action} ${item.text} into my ${target} from the ${source}`,`${action} my ${source} ${item.text} to the ${target}`];
   for(const [layout,text] of forms.entries())yield {text:prefix+text,intent:d.intent,status:item.status,entities:{sourceCollection:d.source,destination:d.destination,...item.entities},difficulty:'PARAPHRASE',split,templateFamily:`transfer-layout-${layout}-${split}`,source:transferSource};
  }
  for(const prefix of ['do not ','never ','explain how to ','write a story about '])yield {text:`${prefix}${action} shoes from ${source} to ${target}`,intent:null,status:'UNKNOWN',difficulty:'NEGATION',split:'test',templateFamily:'transfer-denied-or-instructional',source:transferSource};
 }
 for(const [text,status,intent] of [
  ['move item from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['move two shoes out of wishlist into cart','RESOLVED','CART_MOVE_FROM_WISHLIST'],
  ['move shoes from wishlist to cart or wishlist','UNKNOWN',null],
  ['move shoes from cart to cart','UNKNOWN',null],
  ['move shoes from wishlist to garage','UNKNOWN',null],
  ['move shoes to cart','UNKNOWN',null],
  ['move shoes from wishlist','UNKNOWN',null],
  ['move shoes from wishlist to cart and move mugs from cart to wishlist','AMBIGUOUS',null],
  ['move 0 shoes from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['move -2 shoes from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['move 1.5 shoes from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['move two items and three mugs from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['move zero socks and three mugs from wishlist to cart','NEEDS_CONTEXT','CART_MOVE_FROM_WISHLIST'],
  ['do not move shoes from cart to wishlist but move socks from wishlist to cart','RESOLVED','CART_MOVE_FROM_WISHLIST'],
  ['move shoes from wishlist to cart then move mugs from wishlist to cart','AMBIGUOUS',null],
 ] as const)yield {text,status,intent,difficulty:'HARD_NEGATIVE',split:'test',templateFamily:'transfer-boundaries',source:transferSource};
}
