import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import { orderProductRequest, orderProductQueries } from './order-product-language.ts';
import { withoutPriceTail } from './price-language.ts';
/** Unpunctuated counted plural items require independent product selection. */
export function countedProductGuidance(message: string): {productText:string;quantity:number}[] | undefined {
  const match=languagePattern('product-guidance.match.pattern.1').exec(message.trim());
  if(!match)return;
  const parts=match[1].split(languagePattern('product-guidance.parts.pattern.1'));
  if(parts.length<2||parts.length>5)return;
  const items=parts.map(part=>productGuidance(languageValue<string>('product-guidance.items.value.1')+part));
  // Model numbers, sizes, measurements and additional actions must not become
  // quantities. Keep this shorthand limited to plainly counted plural nouns.
  if(items.some(item=>!item||!languagePattern('product-guidance.countedProductGuidance.pattern.1').test(item.query)||languagePattern('product-guidance.countedProductGuidance.pattern.2').test(item.query)))return;
  return items.map(item=>({productText:item!.query,quantity:item!.quantity}));
}

/** Recognize an incomplete positive shopping command, never a write instruction. */
export function productGuidance(message: string): {
  query: string; quantity: number; action: 'choose' | 'remove';
} | undefined {
  const text = message.trim().replace(languagePattern('product-guidance.text.pattern.1'), '');
  if (languagePattern('product-guidance.productGuidance.pattern.1').test(text)) return languageValue<{ query: string; quantity: number; action: "remove"; }>('product-guidance.productGuidance.value.1');
  const match = languagePattern('product-guidance.match.pattern.2').exec(text);
  if (!match) return;
  // Editing prose is not selecting a commerce product or collection.
  if (match[1].toLowerCase() === languageValue<string>('product-guidance.productGuidance.value.2') && languagePattern('product-guidance.productGuidance.pattern.2').test(match[2])) return;
  if (languagePattern('product-guidance.productGuidance.pattern.3').test(match[2])) return;
  let query = match[2].replace(languagePattern('product-guidance.query.pattern.1'), '').trim();
  if(languagePattern('product-guidance.productGuidance.pattern.4').test(query))return;
  if (withoutPriceTail(query.toLowerCase()) !== query.toLowerCase()) return;
  // Destinations, modifiers and compound instructions stay on the regular guarded path.
  if (languagePattern('product-guidance.productGuidance.pattern.5').test(query)) return;
  let quantity = 1;
  const words: Record<string, number> = languageValue<Record<string, number>>('product-guidance.words.value.1');
  const word = languagePattern('product-guidance.word.pattern.1').exec(query);
  if (word) { quantity = words[word[1].toLowerCase()]; query = word[2]; }
  const count = languagePattern('product-guidance.count.pattern.1').exec(query);
  if (count) {
    if (word) return;
    quantity = Number(count[1]);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) return;
    query = count[2];
  }
  if (languagePattern('product-guidance.productGuidance.pattern.6').test(query)) return;
  // Do not reinterpret weights, dozens or conflicting counts as package quantities.
  if ((word || count) && languagePattern('product-guidance.productGuidance.pattern.7').test(query)) return;
  if (!query || query.length > 120 || query.split(languagePattern('product-guidance.productGuidance.pattern.8')).length > 12 || !languagePattern('product-guidance.productGuidance.pattern.9').test(query) || languagePattern('product-guidance.productGuidance.pattern.10').test(query)) return;
  return {query, quantity, action: match[1].toLowerCase() === languageValue<string>('product-guidance.productGuidance.value.3') ? 'remove' : 'choose'};
}

/** An order naming products starts with product selection, never existing-cart checkout. */
export function orderProductGuidance(message: string): string[] | undefined {
  const requested = orderProductRequest(message);
  if (!requested) return;
  // Existing order references, repeat purchases and checkout steps are not products.
  if (languagePattern('product-guidance.orderProductGuidance.pattern.1').test(requested) || languagePattern('product-guidance.orderProductGuidance.pattern.2').test(requested)) return;
  const queries = orderProductQueries(requested);
  if (!queries.length || queries.length > 50 || queries.some(query => !productGuidance(languageTemplate('product-guidance.orderProductGuidance.template.1', [query])))) return;
  return queries;
}
