import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {giftSearch, type GiftContext} from './gift-language.ts';
import {withoutPriceTail,currencyName} from './price-language.ts';
import {attributeValue} from './search-attributes.ts';
import {searchCommandCorrections} from './search-language.ts';
import {evidenceRequirements} from './evidence-requirements.ts';
import type {Dictionary} from './types.ts';

/** Extract linguistic purpose only; the merchant schema decides its meaning. */
export function purposeSearch(dictionary:Dictionary,text:string):{coreText:string;purpose:string;browse?:boolean;gift?:GiftContext}|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 // Composer padding is not a second request. Keep rejecting line breaks inside
 // the request so separate clauses cannot be swallowed as a catalog purpose.
 text=text.trim();
 const gift=giftSearch(text);
 if(gift)return gift;
 if(languagePattern('purpose-language.purposeSearch.pattern.1').test(text))return;
 // Evidence qualifiers retain their own verification path. A phrase such as
 // "safe for an allergy" must not become an ordinary merchant purpose filter.
 if(evidenceRequirements(text).length)return;
 const trimmed=text.trim().replace(languagePattern('purpose-language.trimmed.pattern.1'),'');
 const noPrice=withoutPriceTail(trimmed.toLowerCase());
 const preparation=languagePattern('purpose-language.preparation.pattern.1').exec(noPrice);
 if(preparation&&attributeValue(dictionary,'purpose',preparation[1])){
  return {coreText:(languageValue<string>('purpose-language.purposeSearch.value.1')+trimmed.slice(noPrice.length)).trim(),purpose:languageValue<string>('purpose-language.purposeSearch.value.2')+preparation[1].toLowerCase(),browse:true};
 }
 const match=languagePattern('purpose-language.match.pattern.1').exec(text.trim());
 if(!match)return;
 // "search for milk" introduces the product, not its intended use.
 let commandHead=match[1];
 // A purpose is context, never permission to turn a negated command into a
 // search when its remaining head cannot resolve. Preparation wording above
 // has its own complete grammar; negative typed relations use their own path.
 if(languagePattern('purpose-language.purposeSearch.pattern.2').test(commandHead))return;
 for(const correction of searchCommandCorrections(text.trim()).filter(change=>change.end<=commandHead.length))commandHead=commandHead.slice(0,correction.start)+correction.to+commandHead.slice(correction.end);
 if(languagePattern('purpose-language.purposeSearch.pattern.3').test(commandHead)){
  const nested=purposeSearch(dictionary,match[2]);
  return nested?{...nested,coreText:match[1]+languageValue<string>('purpose-language.purposeSearch.value.3')+nested.coreText}:undefined;
 }
 const head=withoutPriceTail(match[2].toLowerCase());
 if(languagePattern('purpose-language.purposeSearch.pattern.4').test(head))return;
 if(new RegExp('^(?:[0-9$€£]|'+currencyName()+languageValue<string>('purpose-language.purposeSearch.value.4'),'i').test(head))return;
 const raw=head.replace(languagePattern('purpose-language.raw.pattern.1'),'');
 const negative=languagePattern('purpose-language.negative.pattern.1').exec(raw);
 const purpose=negative&&attributeValue(dictionary,'purpose',negative[1])?raw:attributeValue(dictionary,'purpose',raw);
 if(!purpose)return;
 const coreText=(match[1]+' '+match[2].slice(head.length)).trim();
 const productHead=withoutPriceTail(coreText.toLowerCase());
 if(languagePattern('purpose-language.purposeSearch.pattern.5').test(productHead)){
  return {coreText:(languageValue<string>('purpose-language.purposeSearch.value.5')+coreText.slice(productHead.length)).trim(),purpose,browse:true};
 }
 return {coreText,purpose};

 });
}
