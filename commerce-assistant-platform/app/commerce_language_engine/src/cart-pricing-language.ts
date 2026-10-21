import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';

/** Read-only cart pricing grammar. Consume the whole request, never action clauses. */
export function cartPricingRequested(text:string):boolean {
 if(languagePattern('cart-pricing-language.cartPricingRequested.pattern.1').test(text)||languagePattern('cart-pricing-language.cartPricingRequested.pattern.2').test(text))return false;
 const value=normalize(text).replace(languagePattern('cart-pricing-language.value.pattern.1'),'').replace(languagePattern('cart-pricing-language.value.pattern.2'),'');
 const metric=languageValue<string>('cart-pricing-language.metric.value.1');
 const metrics=languageTemplate('cart-pricing-language.metrics.template.1', [metric, metric]);
 const cart=languageValue<string>('cart-pricing-language.cart.value.1');
 const items=languageValue<string>('cart-pricing-language.items.value.1');
 const prefix=languageValue<string>('cart-pricing-language.prefix.value.1');
 // Quantity questions return the same verified quantity-and-money snapshot.
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.1', [prefix, cart])).test(value))return true;
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.2', [prefix, cart])).test(value))return true;
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.3', [cart])).test(value))return true;
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.4', [prefix, metrics, items, cart])).test(value))return true;
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.5', [prefix, cart, metrics])).test(value))return true;
 if(new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.6', [cart])).test(value))return true;
 return new RegExp(languageTemplate('cart-pricing-language.cartPricingRequested.template.7', [cart, cart])).test(value);
}
