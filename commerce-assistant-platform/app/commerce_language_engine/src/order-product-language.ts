import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {passiveCartRequest} from './semantic-clauses.ts';
/** Order syntax only. Product spelling stays untouched for catalog selection. */
export function orderProductRequest(message: string): string | undefined {
 let text = message.trim().replace(languagePattern('order-product-language.text.pattern.1'), "'");
 // Passive cart commands belong to the cart clause parser, including slot replies.
 if (passiveCartRequest(text)) return;
 const politeCountList = languagePattern('order-product-language.politeCountList.pattern.1').test(text);
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.1'), languageValue<string>('order-product-language.orderProductRequest.value.1'));
 const explicitDesire = languagePattern('order-product-language.explicitDesire.pattern.1').test(text);
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.2'), '');
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.3'), '');
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.4'), '');
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.5'), '');
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.6'), languageValue<string>('order-product-language.orderProductRequest.value.2'));
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.7'), languageValue<string>('order-product-language.orderProductRequest.value.3'));
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.8'), '');
 // Typo aliases are confined to the command, never replaced inside names/SKUs.
 text = text.replace(languagePattern('order-product-language.orderProductRequest.pattern.9'), languageValue<string>('order-product-language.orderProductRequest.value.4')).replace(languagePattern('order-product-language.orderProductRequest.pattern.10'), languageValue<string>('order-product-language.orderProductRequest.value.5'));
 const match = languagePattern('order-product-language.match.pattern.1').exec(text);
 const countFirst = languagePattern('order-product-language.countFirst.pattern.1').test(text);
 if (!match && (politeCountList || countFirst)) {
  const products = text.replace(languagePattern('order-product-language.products.pattern.1'), '').trim();
  return politeCountList || countedOrderList(products) ? products : undefined;
 }
 if (!match || (languagePattern('order-product-language.orderProductRequest.pattern.11').test(text) && !languagePattern('order-product-language.orderProductRequest.pattern.12').test(text) && !explicitDesire)) return;
 const products = match[1].trim().replace(languagePattern('order-product-language.products.pattern.2'), '').replace(languagePattern('order-product-language.products.pattern.3'), '').trim();
 // A conversational need is a search. Only an independently counted list
 // supplies enough order structure to open multiple product selections.
 const desire = languagePattern('order-product-language.desire.pattern.1').test(text);
 return !desire || countedOrderList(products) ? products : undefined;
}

export function normalizeOrderQuantity(query: string): string {
 // Explicit multiplication notation, rather than a bare trailing model number.
 return query.replace(languagePattern('order-product-language.normalizeOrderQuantity.pattern.1'), '$1 $2')
  .replace(languagePattern('order-product-language.normalizeOrderQuantity.pattern.2'), '$2 $1');
}

/** Split count-first lists once, preserving product spelling and model guards. */
export function orderProductQueries(requested: string): string[] {
 return requested.split(languagePattern('order-product-language.orderProductQueries.pattern.1')).flatMap(part => {
  const chunks = normalizeOrderQuantity(part.trim()).split(languagePattern('order-product-language.chunks.pattern.1')).map(normalizeOrderQuantity);
  if (chunks.length === 1) return chunks;
  if (!chunks.every(chunk => languagePattern('order-product-language.orderProductQueries.pattern.2').test(chunk))) return [''];
  if (chunks.some(chunk => languagePattern('order-product-language.orderProductQueries.pattern.3').test(chunk))) return [''];
  return chunks;
 }).map(normalizeOrderQuantity);
}

function countedOrderList(products: string): boolean {
 const queries = orderProductQueries(products);
 return queries.length > 1 && queries.every(query => languagePattern('order-product-language.countedOrderList.pattern.1').test(query));
}

export function orderRequestIssue(message: string, valid: boolean): string | undefined {
 if (valid) return;
 const request = orderProductRequest(message);
 if (request && languagePattern('order-product-language.orderRequestIssue.pattern.1').test(request)) return;
 const negated = languagePattern('order-product-language.negated.pattern.1').test(message.trim());
 const clearThenOrder = languagePattern('order-product-language.clearThenOrder.pattern.1').test(message.trim());
 if (negated && languagePattern('order-product-language.orderRequestIssue.pattern.2').test(message)) return;
 if (negated) return 'Nothing will be added or ordered. Tell me what you would like to do instead.';
 if (!clearThenOrder && (!request || languagePattern('order-product-language.orderRequestIssue.pattern.3').test(request))) return;
 if (clearThenOrder || languagePattern('order-product-language.orderRequestIssue.pattern.4').test(request!)) return 'Please choose the products first, then use the cart options to keep existing items or clear them. Send the product list separately; your cart has not been changed.';
 if (languagePattern('order-product-language.orderRequestIssue.pattern.5').test(request!)) return 'Please send the product list first. We will confirm delivery details and payment during checkout. Nothing has been added or ordered.';
 return 'Please clarify the products, quantities, and any conditions in this order. Use a list such as “2 bananas, 3 apples”. We need to match product units and confirm requirements before adding anything.';
}
