import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Whole-cart English commands. A partial match must never empty a cart. */
export function clearCartRequested(message:string):boolean {
 if(message.length>4000||languagePattern('cart-clear-language.clearCartRequested.pattern.1').test(message))return false;
 let text=message.normalize('NFKC').toLowerCase().trim().replace(languagePattern('cart-clear-language.text.pattern.1'),'').trim().replace(languagePattern('cart-clear-language.text.pattern.2'),' ');
 text=text.replace(languagePattern('cart-clear-language.clearCartRequested.pattern.2'),'');
 text=text.replace(languagePattern('cart-clear-language.clearCartRequested.pattern.3'),'');
 const cart=languageValue<string>('cart-clear-language.cart.value.1');
 const all=languageValue<string>('cart-clear-language.all.value.1');
 const clear=languageValue<string>('cart-clear-language.clear.value.1');
 const remove=languageValue<string>('cart-clear-language.remove.value.1');
 const patterns=[
  languageTemplate('cart-clear-language.patterns.template.1', [clear, cart]),
  languageTemplate('cart-clear-language.patterns.template.2', [remove, all, cart]),
  languageTemplate('cart-clear-language.patterns.template.3', [all, cart]),
  languageTemplate('cart-clear-language.patterns.template.4', [cart]),
  languageTemplate('cart-clear-language.patterns.template.5', [remove, cart]),
  languageTemplate('cart-clear-language.patterns.template.6', [remove, cart]),
  languageTemplate('cart-clear-language.patterns.template.7', [cart]),
  languageTemplate('cart-clear-language.patterns.template.8', [cart]),
 ];
 return patterns.some(pattern=>new RegExp(`^(?:${pattern})$`).test(text));
}
