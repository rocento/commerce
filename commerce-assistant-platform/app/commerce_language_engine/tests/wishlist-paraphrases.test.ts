import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {wishlistReadOrCommand} from '../src/wishlist-language.ts';
const c=await loadRuntime();
test('collection paraphrases preserve exact product text and transfer direction',()=>{
 for(const product of ['milk','silver moon necklace','copper fasteners','SKU-001']){
  for(const [text,intent] of [
   [`save ${product} for later`,'ADD_TO_WISHLIST'],[`unsave ${product}`,'REMOVE_FROM_WISHLIST'],
   [`send 2 ${product} from my saved items to my basket`,'CART_MOVE_FROM_WISHLIST'],
   [`save ${product} from my cart to my favorites`,'CART_MOVE_TO_WISHLIST'],
  ]){const r=resolve(c,text);assert.equal(r.intent,intent,text);assert.equal(r.entities.productText,product.toLowerCase());}
 }
});
test('paraphrases never consume quotes, negation, conditions or later commands',()=>{
 for(const text of ['do not save milk for later','explain how to remove milk from wishlist','save milk for later and buy bread','remove milk from wishlist if it is old','save "Wish-list Notebook" for later','move milk from wishlist to cart without removing it','delete milk from wishlist; empty cart'])assert.equal(wishlistReadOrCommand(text),undefined,text);
});
test('bulk clear stays in wishlist and copying cannot become a move',()=>{
 const r=resolve(c,'could you empty my wish list?');assert.equal(r.intent,'REMOVE_FROM_WISHLIST');assert.equal(r.entities.productText,'all items');assert.equal(r.entities.destination,'wishlist');
 const copy=resolve(c,'copy my wishlist to my cart');assert.equal(copy.status,'UNSUPPORTED');assert.deepEqual(copy.actions,[]);assert.match(copy.message,/remain saved/);
 const vague=resolve(c,'move something from wishlist to cart');assert.equal(vague.status,'NEEDS_CONTEXT');
});
test('merchant name punctuation survives wishlist actions and explicit quantities',()=>{
 for(const text of ['save Silver Moon Necklace — 45cm for later','remove Silver Moon Necklace — 45cm from wishlist','move 2 Silver Moon Necklace — 45cm from wishlist to cart','save Silver Moon Necklace — 45cm from cart to wishlist']){
  const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.entities.productText,'silver moon necklace — 45cm',text);
  if(text.startsWith('move 2'))assert.equal(r.entities.quantity,2);
 }
});
