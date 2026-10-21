import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {withoutPriceTail} from './price-language.ts';

export type GiftContext = {core_text:string;occasion?:string;recipient?:string};
/** Whole read-only gift requests. Recipient/occasion are context, never product facts. */
export function giftSearch(text:string):{coreText:string;purpose:string;browse:boolean;gift:GiftContext}|undefined {
 if(text.length>500||languagePattern('gift-language.giftSearch.pattern.1').test(text)||languagePattern('gift-language.giftSearch.pattern.2').test(text))return;
 const clean=text.trim().replace(languagePattern('gift-language.clean.pattern.1'),'');
 const head=withoutPriceTail(clean.toLowerCase());
 const price=clean.slice(head.length);
 const body=head.replace(languagePattern('gift-language.body.pattern.1'),'').replace(languagePattern('gift-language.body.pattern.2'),'');
 let product=languageValue<string>('gift-language.product.value.1'),suffix='',occasion:string|undefined,recipient:string|undefined;
 let m=languagePattern('gift-language.m.pattern.1').exec(body);
 if(m)suffix=m[1]??'';
 else if((m=languagePattern('gift-language.giftSearch.pattern.3').exec(body))){product=m[1];suffix=m[2]??'';}
 else if((m=languagePattern('gift-language.giftSearch.pattern.4').exec(body))){occasion=m[1]===languageValue<string>('gift-language.lexical.value.1')?'wedding':m[1];suffix=m[2]??'';}
 else return;
 if(suffix){
  const recipientMatch=languagePattern('gift-language.recipientMatch.pattern.1').exec(suffix);
  const occasionMatch=languagePattern('gift-language.occasionMatch.pattern.1').exec(suffix);
  if(recipientMatch){recipient=recipientMatch[1]+' '+recipientMatch[2];occasion=recipientMatch[3]??occasion;}
  else if(occasionMatch){occasion=occasionMatch[1];if(occasionMatch[2])recipient=occasionMatch[2]+' '+occasionMatch[3];}
  else return; // Never discard an unrecognized requirement.
 }
 if(occasion===languageValue<string>('gift-language.lexical.value.2'))occasion='wedding';
 if(languagePattern('gift-language.giftSearch.pattern.5').test(product))return;
 const coreText=(languageValue<string>('gift-language.coreText.value.1')+product+' '+price).trim();
 return {coreText,purpose:'gift',browse:product===languageValue<string>('gift-language.lexical.value.3'),gift:{core_text:coreText,...(occasion?{occasion}:{}),...(recipient?{recipient}:{})}};
}
