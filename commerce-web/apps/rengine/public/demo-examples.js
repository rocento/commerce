export function demoExamples(store, currency) {
 const budget=amount=>typeof currency==='string' && /^[A-Z]{3}$/.test(currency)?` under ${amount} ${currency}`:'';
 const samples={
  grocery:[`Find fresh fruit${budget(200)}`,'Add two bottles of milk to my cart','Show my wishlist'],
  jewelry:[`Find a silver ring${budget(1000)}`,'Compare these necklaces','Show my cart'],
  electronics:['Find a laptop with 16GB RAM',`Show headphones${budget(2000)}`,'Where is my order?'],
  pharmacy:['Find a gentle face cleanser',`Show moisturizer${budget(500)}`,'Compare these products'],
 };
 return samples[store];
}

export function demoSuite(store, currency) {
 const samples=demoExamples(store,currency);
 const search=samples[store==='electronics'||store==='pharmacy'?1:0];
 return ['show my cart | VIEW_CART','show my wishlist',search,
  'remove this product from my cart','where is my order?','compare these products'].join('\n');
}

export function refreshExample(current, previous, next) {
 return previous.includes(current)?next:current;
}
