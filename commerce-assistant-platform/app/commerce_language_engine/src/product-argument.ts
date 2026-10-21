import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {quantityPrefix} from './quantities.ts';
import {withoutPriceTail} from './price-language.ts';
import type {Match} from './types.ts';

// Extract the argument of the relevant action, not leftover words from the
// request wrapper. Catalog lookup is deliberately absent from this parser.
export function productArgument(tokens:string[],matches:Match[],actionGroup?:string,productActionGroups?:Set<string>) {
 if(!actionGroup){
  const structural=matches.filter(m=>!m.negated&&(m.group.startsWith('ACTION_')||m.group.startsWith('REFERENCE_')||m.group==='ORDER_RECENCY'||m.group.startsWith('OBJECT_')&&m.group!=='OBJECT_PRODUCT'));
  const remaining=tokens.filter((_,p)=>matches.some(m=>m.group==='OBJECT_PRODUCT'&&p>=m.start&&p<m.end&&!structural.some(s=>s.start<=m.start&&s.end>=m.end&&s.end-s.start>m.end-m.start))||!structural.some(m=>p>=m.start&&p<m.end));
  const words=withoutPriceTail(remaining.join(' ')).replace(languagePattern('product-argument.words.pattern.1'),'').replace(languagePattern('product-argument.words.pattern.2'),'').trim().split(' ').filter(Boolean);
  while(languageValue<string[]>('product-argument.productArgument.value.1').includes(words[0]))words.shift();
  const quantity=quantityPrefix(words);
  return {productText:words.slice(quantity.end).join(' '),...(quantity.quantity!==undefined?{quantity:quantity.quantity}:{}),...(quantity.quantityRange?{quantityRange:quantity.quantityRange}:{})};
 }
 const anchor=actionGroup?matches.filter(m=>m.group===actionGroup&&!m.negated).sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start))[0]:undefined;
 if(actionGroup&&!anchor)return {productText:''};
 let start=anchor?.end??0,end=tokens.length;
 if(anchor&&start===end){start=0;end=anchor.start;}
 else if(anchor){const boundary=matches.filter(m=>m.start>anchor.end&&m.group.startsWith('ACTION_')&&languageValue<string[]>('product-argument.boundary.value.1').includes(tokens[m.start-1])).sort((a,b)=>a.start-b.start)[0];if(boundary)end=boundary.start-1;}
 let phrase=withoutPriceTail(tokens.slice(start,end).join(' '))
  .replace(languagePattern('product-argument.phrase.pattern.1'),'')
  .replace(languagePattern('product-argument.phrase.pattern.2'),'')
  .replace(languagePattern('product-argument.phrase.pattern.3'),'').trim();
 const words=phrase.split(' ').filter(Boolean);
 while(languageValue<string[]>('product-argument.productArgument.value.2').includes(words[0])){words.shift();start++;}
 const quantity=quantityPrefix(words);
 const body=words.slice(quantity.end);
 const structural=matches.filter(m=>!m.negated&&(m.group.startsWith('ACTION_')||m.group.startsWith('REFERENCE_')||m.group==='ORDER_RECENCY'||m.group.startsWith('OBJECT_')&&m.group!=='OBJECT_PRODUCT'));
 // In "show the price of shoes", shoes qualify the information being
 // requested. The entire phrase must not become a search product argument.
 if(structural.some(m=>m.group.startsWith('OBJECT_')&&m.start===start+quantity.end&&languageValue<string[]>('product-argument.productArgument.value.3').includes(tokens[m.end])))return {productText:''};
 const content=body.filter((word,i)=>{
  const p=start+quantity.end+i;
  return !languageValue<string[]>('product-argument.content.value.1').includes(word)&&(matches.some(m=>m.group==='OBJECT_PRODUCT'&&p>=m.start&&p<m.end&&!structural.some(s=>s.start<=m.start&&s.end>=m.end&&s.end-s.start>m.end-m.start))||!structural.some(m=>p>=m.start&&p<m.end));
 });
 const modifiers=structural.filter(m=>productActionGroups?.has(m.group));
 const productText=content.length?body.filter((_,i)=>!modifiers.some(m=>start+quantity.end+i>=m.start&&start+quantity.end+i<m.end)).join(' '):'';
 return {productText,...(quantity.quantity!==undefined?{quantity:quantity.quantity}:{}),...(quantity.quantityRange?{quantityRange:quantity.quantityRange}:{})};
}
