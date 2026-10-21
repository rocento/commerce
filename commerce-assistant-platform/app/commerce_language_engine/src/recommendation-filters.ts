import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Explicit generic recommendation filters; values remain merchant-resolved text. */
export function recommendationFilters(text:string):Record<string,string>|undefined {
 const match=languagePattern('recommendation-filters.match.pattern.1').exec(text.trim());
 if(!match)return;
 const value=(match[1]??match[3]).replace(languagePattern('recommendation-filters.value.pattern.1'),'').trim().toLowerCase();
 // Compound requirements must go through the normal parser, never disappear into a value.
 if(!value||value.length>100||languagePattern('recommendation-filters.recommendationFilters.pattern.1').test(value))return;
 return {productText:'*',[match[1]?'category':match[2].toLowerCase()]:value};
}
