import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Whole-request collection paraphrases. Product text is never spelling-corrected. */
import {normalize} from './normalize.ts';
import {quantityPrefix} from './quantities.ts';
import {tokenize} from './semantic-clauses.ts';
import {wishlistReadRequested} from './wishlist-read-language.ts';
const collection=()=>recognitionMemo('wishlist-language.collection',()=>(languageValue<string>('wishlist-language.collection.value.1')));
const cart=()=>recognitionMemo('wishlist-language.cart',()=>(languageValue<string>('wishlist-language.cart.value.1')));
const prefix=()=>recognitionMemo('wishlist-language.prefix',()=>(languagePattern('wishlist-language.prefix.pattern.1')));
export function wishlistReadOrCommand(message:string):{canonical?:string;unsupportedCopy?:boolean;productText?:string}|undefined {
 if(wishlistReadRequested(message))return languageValue<{ canonical: string; }>('wishlist-language.wishlistReadOrCommand.value.1');
 if(languagePattern('wishlist-language.wishlistReadOrCommand.pattern.1').test(message))return;
 let text=message.trim().replace(languagePattern('wishlist-language.text.pattern.1'),'').replace(prefix(),'').replace(languagePattern('wishlist-language.text.pattern.2'),'').trim();
 if(languagePattern('wishlist-language.wishlistReadOrCommand.pattern.2').test(text))return;
 const coll=languageTemplate('wishlist-language.coll.template.1', [collection()]);
 const dst=languageTemplate('wishlist-language.dst.template.1', [cart()]);
 if(new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.1', [coll]),'i').test(text)||languagePattern('wishlist-language.wishlistReadOrCommand.pattern.3').test(text))return languageValue<{ canonical: string; }>('wishlist-language.wishlistReadOrCommand.value.2');
 if(new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.2', [coll]),'i').test(text)||new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.3', [coll]),'i').test(text))return languageValue<{ canonical: string; }>('wishlist-language.wishlistReadOrCommand.value.3');
 if(new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.4', [coll, dst]),'i').test(text))return {unsupportedCopy:true};
 let m=new RegExp(languageTemplate('wishlist-language.m.template.1', [coll, dst, coll, dst]),'i').exec(text);
 if(m){
  const from=new RegExp(`^${coll}$`,'i').test(m[2])?'wishlist':'cart';const to=new RegExp(`^${coll}$`,'i').test(m[3])?'wishlist':'cart';
  if(from!==to)return {canonical:languageTemplate('wishlist-language.wishlistReadOrCommand.template.5', [m[1], from, to]),productText:m[1]};
 }
 m=new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.6', [coll]),'i').exec(text)
  ?? languagePattern('wishlist-language.wishlistReadOrCommand.pattern.4').exec(text)
  ?? languagePattern('wishlist-language.wishlistReadOrCommand.pattern.5').exec(text);
 if(m)return {canonical:languageTemplate('wishlist-language.wishlistReadOrCommand.template.7', [m[1]]),productText:m[1]};
 m=new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.8', [coll]),'i').exec(text)
  ?? new RegExp(languageTemplate('wishlist-language.wishlistReadOrCommand.template.9', [coll]),'i').exec(text)
  ?? languagePattern('wishlist-language.wishlistReadOrCommand.pattern.6').exec(text);
 if(m)return {canonical:languageTemplate('wishlist-language.wishlistReadOrCommand.template.10', [m[1]]),productText:m[1]};
}

export function preservedWishlistReference(message:string,recognized:unknown):string|undefined {
 const raw=wishlistReadOrCommand(message)?.productText;
 if(!raw||typeof recognized!=='string')return;
 const tokens=tokenize(raw),quantity=quantityPrefix(tokens.map(token=>token.value));
 const candidates=[raw,raw.replace(languagePattern('wishlist-language.candidates.pattern.1'),'')];
 if(quantity.end>0&&tokens[quantity.end])candidates.push(raw.slice(tokens[quantity.end].start));
 return candidates.find(value=>normalize(value)===normalize(recognized))?.toLowerCase();
}
