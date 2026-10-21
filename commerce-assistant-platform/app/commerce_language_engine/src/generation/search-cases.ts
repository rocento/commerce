import type {CorpusCase} from '../types.ts';

// Authored compositional regressions; these are synthetic examples, not user
// data or independent evidence of general language accuracy.
export const searchSource='product-search-requests-v2';
export function* searchCases():Generator<CorpusCase> {
 const products=[
  {text:'black running shoes',entities:{category:'running_shoes',color:'black'}},
  {text:'blue shirts',entities:{category:'shirt',color:'blue'}},
  {text:'white headphones',entities:{category:'headphones',color:'white'}},
  {text:'leather wallets',entities:{material:'leather'}},
  {text:'quasar widgets',entities:{}},
  {text:'veltronic modules',entities:{}},
 ];
 const prices=[
  {text:'under 3000',value:3000,operator:'<'},
  {text:'below $287.45',value:287.45,operator:'<',currency:'USD'},
  {text:'above 875',value:875,operator:'>'},
  {text:'at most 910',value:910,operator:'<='},
 ];
 const wrappers=[['','train'],['could you ','development'],['please ','test']] as const;
 for(const product of products)for(const verb of ['show me','show','find','search for','look for','display'])for(const [prefix,split] of wrappers)for(const price of prices)yield {
  text:`${prefix}${verb} ${product.text} ${price.text}`,intent:'PRODUCT_SEARCH',status:'RESOLVED',
  entities:{...product.entities,productText:product.text,price:{operator:price.operator,value:price.value,...(price.currency?{currency:price.currency}:{})}},
  difficulty:'PARAPHRASE',split,templateFamily:'search-product-argument-'+split,source:searchSource,
 };
 for(const product of products)for(const prefix of ['do not show me ','never show me ',''])yield {
  text:`${prefix}${product.text} under 3000`,intent:null,status:'UNKNOWN',difficulty:prefix?'NEGATION':'HARD_NEGATIVE',
  split:'test',templateFamily:'search-negative-controls',source:searchSource,
 };
 for(const [text,intent] of [
  ['show me my cart','VIEW_CART'],['list my cart','VIEW_CART'],['show me my order','ORDER_DETAILS'],
  ['show me the price of running shoes','CHECK_PRICE'],['show me the warranty for headphones','PRODUCT_WARRANTY'],
  ['show me the size guide for running shoes','PRODUCT_SIZE_GUIDE'],
 ] as const)yield {text,intent,status:'RESOLVED',difficulty:'HARD_NEGATIVE',split:'development',templateFamily:'search-other-object-controls',source:searchSource};
 for(const text of ['show me','show me products'])yield {text,intent:null,status:'UNKNOWN',difficulty:'INCOMPLETE',split:'test',templateFamily:'search-incomplete-controls',source:searchSource};
 // Conversational search heads compose with arbitrary catalog names and prices.
 // Keep these independent from the ontology's terms to catch extraction regressions.
 for(const head of ['looking for','searching for','shopping for','browsing for','trying to find','on the lookout for','in search of','in the market for','help me find','help me look for','help me search for','do you sell','do you carry','do you have','where can I find',"I'm looking for",'we are searching for','please help me find']) {
  for(const product of ['oranges','Local Bananas 1kg','black running shoes','quasar widgets']) {
   for(const suffix of ['', ' under $50'])yield {
    text:`${head} ${product}${suffix}`,intent:'PRODUCT_SEARCH',status:'RESOLVED',
    entities:{productText:product.toLowerCase(),...(suffix?{price:{operator:'<',value:50,currency:'USD'}}:{})},
    difficulty:'PARAPHRASE',split:'test',templateFamily:'conversational-search',source:searchSource,
   };
  }
 }
 for(const text of ['not looking for oranges','never search for oranges','do not look for oranges','looking for','searching for','do you sell','do you have','looking for my order','looking for my cart'])yield {
  text,intent:null,status:'UNKNOWN',difficulty:'HARD_NEGATIVE',split:'test',templateFamily:'conversational-search-controls',source:searchSource,
 };
 yield {text:'show me shoes or cancel my order',intent:null,status:'AMBIGUOUS',difficulty:'AMBIGUOUS',split:'test',templateFamily:'search-competing-actions',source:searchSource};
}
