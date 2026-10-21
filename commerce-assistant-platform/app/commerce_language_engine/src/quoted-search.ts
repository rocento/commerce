import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';

/** An explicit whole search command may name a product containing action words. */
export function quotedSearch(text:string):{productText:string;command:string;commandTokens:number}|undefined {
 const commandPattern=languageValue<string>('quoted-search.commandPattern.value.1');
 const exact=new RegExp(languageValue<string>('quoted-search.exact.value.1')+commandPattern+languageValue<string>('quoted-search.exact.value.2'),'i').exec(text);
 // Text printed on a product is literal product data, even when it mentions
 // money or actions. The unquoted noun prefix is deliberately bounded.
 const printed=exact?null:new RegExp(languageValue<string>('quoted-search.printed.value.1')+commandPattern+languageValue<string>('quoted-search.printed.value.2'),'i').exec(text);
 if(printed&&languagePattern('quoted-search.quotedSearch.pattern.1').test(printed[2]))return;
 const match=exact??(printed?[printed[0],printed[1],printed[2].replace(languagePattern('quoted-search.match.pattern.1'),'')+' '+printed[3]]:undefined);
 if(!match)return;
 // Product titles are literal data, not English grammar tokens. The lexical
 // normalizer drops accents, non-Latin letters and merchant punctuation.
 const productText=match[2].toLowerCase().normalize('NFKC')
  .replace(languagePattern('quoted-search.productText.pattern.1'),char=>languagePattern('quoted-search.productText.pattern.2').test(char)?char:' ')
  .replace(languagePattern('quoted-search.productText.pattern.3'),' ').replace(languagePattern('quoted-search.productText.pattern.4'),' ').trim();
 if(!productText)return;
 const command=normalize(match[1]);
 return {productText,command,commandTokens:command.split(' ').length};
}
