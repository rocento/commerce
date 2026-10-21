import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import {cartPricingRequested} from './cart-pricing-language.ts';

/** Whole-request read paraphrases only; never consume a later action clause. */
export function canonicalRead(text:string):{text:string;intent:string;productText?:string;sort_by?:'price_desc';salesPeriod?:string;discountRanking?:boolean;recommendationFollowup?:'different'|'cheaper';orderReference?:string}|undefined {
 if(languagePattern('read-language.canonicalRead.pattern.1').test(text))return;
 // A bare order-history reference is a read, never an instruction to place an order.
 // Strip only trailing punctuation inside this whole-request rule, not from product text.
 if(languagePattern('read-language.canonicalRead.pattern.2').test(text.trim()))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.1');
 const order = languagePattern('read-language.order.pattern.1').exec(text.trim());
 if(order)return {text:languageValue<string>('read-language.lexical.value.1'),intent:'ORDER_DETAILS',orderReference:order[1]};
 const normalized=normalize(text);
 const service=normalize(text).replace(languagePattern('read-language.service.pattern.1'),'').replace(languagePattern('read-language.service.pattern.2'),'');
 if(service===languageValue<string>('read-language.lexical.value.2'))return {text:service,intent:'FIND_PICKUP_LOCATION'};
 if(service===languageValue<string>('read-language.lexical.value.3'))return {text:service,intent:'NEAREST_STORE'};
 if(service===languageValue<string>('read-language.lexical.value.4'))return {text:service,intent:'PRICE_RANGE'};
 if(service===languageValue<string>('read-language.lexical.value.5'))return {text:service,intent:'PRODUCT_STORAGE_CAPACITY'};
 if(service===languageValue<string>('read-language.lexical.value.6'))return {text:service,intent:'PICKUP_READY'};
 if(service===languageValue<string>('read-language.lexical.value.7'))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.2');
 if(languagePattern('read-language.canonicalRead.pattern.3').test(service))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.3');
 if(languagePattern('read-language.canonicalRead.pattern.4').test(service))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.4');
 // Complete field reads own their full noun phrase before a generic price
 // question can treat "per unit" as the name of a catalog product.
 if(languagePattern('read-language.canonicalRead.pattern.5').test(service))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.5');
 // Tracking a refund is a refund read. It must never become shipment tracking
 // just because both requests contain the verb "track".
 const refund=languagePattern('read-language.refund.pattern.1').exec(service);
 if(refund)return {text:languageValue<string>('read-language.lexical.value.8'),intent:'REFUND_STATUS',...(refund[1]?{orderReference:refund[1]}:{})};
 if(languagePattern('read-language.canonicalRead.pattern.6').test(service))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.6');
 const followup=normalized.replace(languagePattern('read-language.followup.pattern.1'),'').replace(languagePattern('read-language.followup.pattern.2'),'');
 // Service questions route to existing read-only guidance. Whole-request matches
 // deliberately exclude promises, payment changes and additional action clauses.
 if(languagePattern('read-language.canonicalRead.pattern.7').test(followup))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.7');
 if(languagePattern('read-language.canonicalRead.pattern.8').test(followup))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.8');
 if(languagePattern('read-language.canonicalRead.pattern.9').test(followup))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.9');
 if(languagePattern('read-language.canonicalRead.pattern.10').test(followup))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.10');
 if(languagePattern('read-language.canonicalRead.pattern.11').test(followup))return languageValue<{ text: string; intent: string; productText: string; recommendationFollowup: "different"; }>('read-language.canonicalRead.value.11');
 if(languagePattern('read-language.canonicalRead.pattern.12').test(followup))return languageValue<{ text: string; intent: string; productText: string; recommendationFollowup: "cheaper"; }>('read-language.canonicalRead.value.12');
 if(languagePattern('read-language.canonicalRead.pattern.13').test(normalized))return languageValue<{ text: string; intent: string; productText: string; }>('read-language.canonicalRead.value.13');
 // Open-ended discovery only: anchored so product names and extra constraints survive.
 if(languagePattern('read-language.canonicalRead.pattern.14').test(normalized))return languageValue<{ text: string; intent: string; productText: string; }>('read-language.canonicalRead.value.14');
 if(languagePattern('read-language.canonicalRead.pattern.15').test(normalized))return languageValue<{ text: string; intent: string; productText: string; discountRanking: true; }>('read-language.canonicalRead.value.15');
 if(languagePattern('read-language.canonicalRead.pattern.16').test(followup))return languageValue<{ text: string; intent: string; productText: string; discountRanking: true; }>('read-language.canonicalRead.value.16');
 if(cartPricingRequested(text))return languageValue<{ text: string; intent: string; }>('read-language.canonicalRead.value.17');
 const bestseller=languagePattern('read-language.bestseller.pattern.1').exec(normalized.replace(languagePattern('read-language.bestseller.pattern.2'),languageValue<string>('read-language.bestseller.value.1')));
 if(bestseller)return {text:languageValue<string>('read-language.lexical.value.9'),intent:'PRODUCT_RECOMMEND',productText:'*',salesPeriod:(bestseller[1]??languageValue<string>('read-language.canonical.value.1')).replace(' ','_')};
 if(languagePattern('read-language.canonicalRead.pattern.17').test(normalized))return languageValue<{ text: string; intent: string; productText: string; }>('read-language.canonicalRead.value.18');
 const expensive=languagePattern('read-language.expensive.pattern.1').test(normalized);
 if(expensive)return languageValue<{ text: string; intent: string; productText: string; sort_by: "price_desc"; }>('read-language.canonicalRead.value.19');
 const tracking=languagePattern('read-language.tracking.pattern.1').exec(normalized);
 if(tracking)return {text:languageTemplate('read-language.canonicalRead.template.1', [tracking[1]]),intent:'TRACK_ORDER'};
 const stock=languagePattern('read-language.stock.pattern.1').exec(normalized);
 if(!stock||languagePattern('read-language.canonicalRead.pattern.18').test(text)||languagePattern('read-language.canonicalRead.pattern.19').test(stock[1])||stock[1].split(' ').length>12)return;
 return {text:languageValue<string>('read-language.lexical.value.10'),intent:'CHECK_STOCK',productText:stock[1]};
}
