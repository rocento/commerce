import seed from '../../seeds/expansion-intents.en.json' with {type:'json'};
import {industryTerms} from './industry-terms.ts';
import type {CorpusCase,Dictionary} from '../types.ts';
export const expansionSource='industry-coverage-v7';
// Specific commerce information concepts that are absent from the existing taxonomy.
export const expansionIntents=seed as [string,string,string][];
export function* expansionCases():Generator<CorpusCase>{
 const wrappers=[['','', 'train'],['please ','','train'],['could you ','','development'],['',' please','test']] as const;
 for(const [intent,industry,phrases] of expansionIntents)for(const phrase of phrases.split('|'))for(const action of ['show','check','explain','tell me','list','give me'])for(const [prefix,suffix,split] of wrappers){
  yield {text:prefix+action+' '+phrase+suffix,intent,status:'RESOLVED',difficulty:'MEDIUM',split,source:expansionSource,templateFamily:'industry-information-'+industry+'-'+split};
 }
 for(const [intent,industry,phrases] of expansionIntents)for(const phrase of phrases.split('|')){
  for(const action of ['show','check'])yield {text:'do not '+action+' '+phrase,intent:null,status:'UNKNOWN',difficulty:'NEGATIVE_CONFLICT',split:'test',source:expansionSource,templateFamily:'industry-negation-'+industry};
  yield {text:phrase,intent:null,status:'UNKNOWN',difficulty:'HARD',split:'test',source:expansionSource,templateFamily:'industry-missing-action-'+industry};
 }
 for(const term of industryTerms.filter(t=>t.type==='CATEGORY'))for(const [prefix,suffix,split] of wrappers){
  for(const verb of ['find','search for','look for'])yield {text:prefix+verb+' '+term.alias+suffix,intent:'PRODUCT_SEARCH',status:'RESOLVED',entities:{category:term.value},difficulty:'MEDIUM',split,source:expansionSource,templateFamily:'industry-search-'+term.industry+'-'+split};
  for(const [verb,target,intent] of [['add','to my cart','ADD_TO_CART'],['remove','from my cart','REMOVE_FROM_CART'],['add','to my wishlist','ADD_TO_WISHLIST']] as const)for(const [quantity,value] of [['two',2],['three',3]] as const)yield {text:prefix+verb+' '+quantity+' '+term.alias+' '+target+suffix,intent,status:'RESOLVED',entities:{category:term.value,quantity:value},difficulty:'MEDIUM',split,source:expansionSource,templateFamily:'industry-cart-'+term.industry+'-'+split};
 }
}
