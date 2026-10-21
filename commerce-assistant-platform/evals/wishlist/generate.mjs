import {writeFileSync} from 'node:fs';
const products=['milk','bread','lemons','coffee','necklace','ring','earrings','bracelet','copper fasteners','camping lantern'];
const wrappers=['{s}','Please {s}','Could you {s}?','Can you please {s}?','I would like to {s}','I want to {s}','Help me {s}','Would you {s}?','{s} please','pls {s}'];
const families={
 add:[
 'add {p} to my wishlist','save {p} to my wishlist','put {p} in my wishlist','add {p} to my wish list','save {p} in my favorites','add {p} to my favourites','wishlist {p}','favorite {p}','favourite {p}','save {p} for later','keep {p} for later','bookmark {p}',
 'please add {p} to the wishlist','could you save {p} to my wishlist','I want to add {p} to my wishlist','I would like to save {p} for later','put the {p} on my wish list','include {p} in my wishlist','add {p} into my wishlist','save the {p} in my wish list','pls add {p} to my wishlst','add {p} to my whishlist','save {p} to my wish-list','can you bookmark {p} for me'],
 remove:[
 'remove {p} from my wishlist','delete {p} from my wishlist','take {p} off my wishlist','take {p} out of my wishlist','remove {p} from my wish list','delete {p} from my favorites','remove {p} from my favourites','unfavorite {p}','unfavourite {p}','unsave {p}',
 'please remove {p} from my wishlist','could you delete {p} from my wishlist','I want to remove {p} from my wishlist','I would like to take {p} off my wish list','drop {p} from my wishlist','erase {p} from my wishlist','remove the {p} from my saved items','delete {p} from my saved products','remove {p} from my wishlst','take {p} off my wish-list'],
 move:[
 'move {p} from my wishlist to my cart','transfer {p} from my wishlist to my cart','move {p} from my wish list to my basket','move {p} from my favorites to my cart','move {p} from my favourites to my shopping cart','move my wishlist {p} to my cart','take {p} from my wishlist and put it in my cart','remove {p} from my wishlist and add it to my cart','please move {p} from wishlist to cart','could you transfer {p} from my wish list to my basket','I want to move {p} from my wishlist to my cart','move 2 {p} from my wishlist to my cart','transfer two {p} from wishlist to basket','move {p} out of my wishlist into my cart','move {p} from my saved items to my basket','move {p} from my wishlst to my cart','send {p} from my wishlist to my cart','move {p} from my wish-list to my cart'],
 cart_to_wishlist:[
 'move {p} from my cart to my wishlist','transfer {p} from my cart to my wishlist','move {p} from my basket to my wish list','save {p} from my cart to my favorites','take {p} from my cart and save it in my wishlist','please move {p} from cart to wishlist','move 2 {p} from my shopping cart to my wishlist','move {p} out of my basket into my favourites'],
 negative:[
 'do not add {p} to my wishlist','do not remove {p} from my wishlist','never delete {p} from my favorites',"don't move {p} from my wishlist to my cart",'do not move {p} from my cart to my wishlist','explain how to remove {p} from my wishlist','how do I add {p} to my wishlist?','what happens if I move {p} from wishlist to cart?','translate "remove {p} from my wishlist"','pretend to delete {p} from my wishlist'],
};
const rows=[];
const intents={add:'ADD_TO_WISHLIST',remove:'REMOVE_FROM_WISHLIST',move:'CART_MOVE_FROM_WISHLIST',cart_to_wishlist:'CART_MOVE_TO_WISHLIST'};
function push(family,text,expected,context={},pattern){rows.push({id:`WL-${String(rows.length+1).padStart(4,'0')}`,family,text,expected,context,pattern,split:pattern%5===0?'variation':'development'});}
for(const [family,patterns] of Object.entries(families))patterns.forEach((pattern,i)=>products.forEach(p=>push(family,pattern.replaceAll('{p}',p),family==='negative'?{behavior:'no_mutation'}:{behavior:'intent',intent:intents[family],product:p,...(/\b(?:2|two) \{p\}/.test(pattern)?{quantity:2}:{})},{},i)));
const views=['show my wishlist','list my saved items','show what is in my wishlist','open my favorites','show my wish list','show everything I saved','list my favourites','view my wishlists'];
views.forEach((s,i)=>wrappers.forEach(w=>push('view',w.replace('{s}',s),{behavior:'intent',intent:'VIEW_WISHLIST'},{},i)));
const clears=['clear my wishlist','empty my wish list','remove all items from my favorites','delete everything from my wishlist'];
clears.forEach((s,i)=>wrappers.forEach(w=>push('clear',w.replace('{s}',s),{behavior:'clear_wishlist'},{},i)));
const ambiguous=['move it from wishlist to cart','remove that from my wishlist','add it to my wishlist','move my wishlist to my cart','copy my wishlist to my cart','move something from my wishlist to my cart'];
ambiguous.forEach((s,i)=>wrappers.forEach(w=>push('clarification',w.replace('{s}',s),{behavior:'clarify',reason:i===4?'copy must retain saved items':'product or selection missing'},{},i)));
products.forEach(p=>{
 push('follow_up',`the ${p}`,{behavior:'intent',intent:'CART_MOVE_FROM_WISHLIST',product:p},{pendingRequest:'move an item from wishlist to cart'},0);
 push('follow_up',`2 ${p}`,{behavior:'intent',intent:'CART_MOVE_FROM_WISHLIST',product:p,quantity:2},{pendingRequest:'move an item from wishlist to cart'},1);
});
if(rows.length!==1000||new Set(rows.map(r=>r.text)).size!==1000)throw new Error('Expected 1000 unique phrases');
writeFileSync(new URL('./cases.json',import.meta.url),JSON.stringify({version:1,language:'English',description:'100 authored structural patterns expanded into 1000 unique synthetic customer utterances. All patterns are synthetic regression examples; no independent holdout accuracy is claimed. Intent resolution is not proof of mutation completion.',cases:rows},null,2)+'\n');
console.log(`Generated ${rows.length} unique wishlist phrases.`);
