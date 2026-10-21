import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import type {Match} from './types.ts';

export type SearchCorrection = {start:number;end:number;tokenIndex:number;from:string;to:string};

// Correct only a request's leading search command after approved wrappers.
// Never scan the product argument, quoted names, SKU fragments or later clauses.
const wrappers=()=>recognitionMemo('search-language.wrappers',()=>(languageValue<string>('search-language.wrappers.value.1')));
const command=()=>recognitionMemo('search-language.command',()=>(new RegExp(languageTemplate('search-language.command.template.1', [wrappers()]),'i')));
const replacements=():Record<string,string>=>recognitionMemo('search-language.replacements',()=>(languageValue<Record<string,string>>('search-language.replacements.value.1')));

export function searchCommandCorrections(text:string):SearchCorrection[] {
 const match=command().exec(text);
 if(!match)return [];
 const phrase=match[1];
 const from=languagePattern('search-language.from.pattern.1').test(phrase)?phrase.slice(-2):phrase;
 const start=match[0].length-from.length;
 const prefix=normalize(text.slice(0,start));
 return [{start,end:start+from.length,tokenIndex:prefix?prefix.split(' ').length:0,from,to:replacements()[from.toLowerCase()]}];
}

// A concrete noun phrase after "I need" can be a search. A prefix before a
// different action still belongs to that action; no catalog vocabulary is used.
export function directNeedSearch(tokens:string[],match:Match,productText:string):boolean {
 if(!languageValue<string[]>('search-language.directNeedSearch.value.1').includes(match.phrase)||!productText||match.negated)return false;
 if(!tokens.slice(0,match.start).every(t=>languageValue<string[]>('search-language.directNeedSearch.value.2').includes(t)))return false;
 if(languageValue<string[]>('search-language.directNeedSearch.value.3').includes(tokens[match.end]))return false;
 if(languagePattern('search-language.directNeedSearch.pattern.1').test(productText))return false;
 return !languagePattern('search-language.directNeedSearch.pattern.2').test(productText)
  && !languagePattern('search-language.directNeedSearch.pattern.3').test(productText);
}
