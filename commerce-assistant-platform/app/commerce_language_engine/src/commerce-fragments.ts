import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import type {Dictionary} from './types.ts';

/** Explicit read meanings. No mutation verbs or inferred product attributes. */
export const commerceReadFragments = ()=>recognitionMemo('commerce-fragments.commerceReadFragments',()=>(languageValue<readonly {intent:string;text:string;aliases:readonly string[]}[]>('commerce-fragments.commerceReadFragments.value.1')));
type Read={text:string;intent:string;productText?:string;sort_by?:'price_desc';salesPeriod?:string};
const indexes=()=>recognitionMemo('commerce-fragments.indexes',()=>new WeakMap<Dictionary,Map<string,Set<string>>>());
export function commerceFragment(dictionary:Dictionary,text:string):Read|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 // Internal separators, quotes, and clauses must never be erased into a command.
 const raw=text.trim().replace(languagePattern('commerce-fragments.raw.pattern.1'),'');
 if(!languagePattern('commerce-fragments.commerceFragment.pattern.1').test(raw))return;
 const phrase=normalize(raw).replace(languagePattern('commerce-fragments.phrase.pattern.1'),'').replace(languagePattern('commerce-fragments.phrase.pattern.2'),'');
 // Match the whole read request so plural collection wording cannot swallow a mutation or clause.
 if(languagePattern('commerce-fragments.commerceFragment.pattern.2').test(phrase))return languageValue<{ text: string; intent: string; }>('commerce-fragments.commerceFragment.value.1');
 if(languagePattern('commerce-fragments.commerceFragment.pattern.3').test(phrase))return languageValue<{ text: string; intent: string; }>('commerce-fragments.commerceFragment.value.2');
 for(const entry of commerceReadFragments())if((entry.aliases as readonly string[]).includes(phrase))return {text:entry.text,intent:entry.intent};
 let index=indexes().get(dictionary);
 if(!index){index=new Map();for(const e of dictionary.entity_terms){
  if(e.type!=='CATEGORY')continue;
  const key=normalize(e.alias),values=index.get(key)??new Set<string>();values.add(e.value);index.set(key,values);
 }indexes().set(dictionary,index);}
 // Only a complete, unambiguous category alias can stand for a catalog search.
 // Brands, SKUs, quantities, locations, and attribute values need an explicit request/context.
 if(index.get(phrase)?.size===1)return {text:languageTemplate('commerce-fragments.commerceFragment.template.1', [phrase]),intent:'PRODUCT_SEARCH',productText:phrase};

 });
}
