import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** A reviewed style sentence is never evidence of a product or a new intent. */
import {knowledgeTokens,type KnowledgeIndex} from './language-knowledge.ts';
import {shoppingDiscourse,shoppingUtterance} from './utterance-language.ts';

type Candidate={status:string;intent:string|null;requestType?:unknown;entities:Record<string,unknown>};
export type DiscourseIssue='response_as_product'|'unparsed_sentences'|'malformed_product_phrase';
const contains=(sentence:string,product:string)=>{
 const source=knowledgeTokens(sentence),wanted=knowledgeTokens(product);
 return wanted.length>0&&source.some((_,at)=>wanted.every((token,offset)=>source[at+offset]===token));
};

const exactQuotedProduct=(text:string,product:string)=>{
 const wanted=knowledgeTokens(product).join(' ');
 return !!wanted&&[...text.matchAll(languagePattern('discourse-boundary.exactQuotedProduct.pattern.1'))].some(match=>knowledgeTokens(match[1]??match[2]??match[3]).join(' ')===wanted);
};
/** Interrogative/personal-command syntax is not an unquoted product noun phrase. */
function malformedProduct(text:string,product:string):boolean{
 if(exactQuotedProduct(text,product))return false;
 return languagePattern('discourse-boundary.malformedProduct.pattern.1').test(product)||
  languagePattern('discourse-boundary.malformedProduct.pattern.2').test(product)||
  languagePattern('discourse-boundary.malformedProduct.pattern.3').test(product)||
  languagePattern('discourse-boundary.malformedProduct.pattern.4').test(product);
}

/** Preserve the established recommendation grammar when no release roles exist. */
export function recommendationProductPhrase(text:string,product:string):string|undefined{
 const prompt=languagePattern('discourse-boundary.prompt.pattern.1').exec(text);
 if(!prompt)return;
 const full=knowledgeTokens(prompt[1]),all=knowledgeTokens(product);
 // The legacy scorer may already consume the final action verb as intent
 // evidence; require the remaining question words to be a complete suffix.
 for(const words of [full,full.slice(0,-1)]){
  if(all.length<=words.length||!words.every((word,i)=>all[all.length-words.length+i]===word))continue;
  const literal=new RegExp(languageValue<string>('discourse-boundary.literal.value.1')+words.join('\\s+')+languageValue<string>('discourse-boundary.literal.value.2'),'i').exec(product);
  const noun=literal&&product.slice(0,literal.index).trim();
  if(noun&&!malformedProduct(text,noun))return noun;
 }

}

/**
 * Reject a single resolved search when only a reviewed conversational sentence
 * supplied its product, or several substantive sentences remain unrepresented.
 * This is a coverage check, not a medical/personal-attribute classifier.
 */
export function discourseProductIssue(index:KnowledgeIndex|undefined,text:string,candidate:Candidate):DiscourseIssue|undefined{
 if(!['RESOLVED','NEEDS_CONTEXT'].includes(candidate.status)||candidate.requestType||!['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(candidate.intent??''))return;
 const products=[candidate.entities.productText,...(Array.isArray(candidate.entities.items)?candidate.entities.items.map(item=>item?.productText):[])].filter((value):value is string=>typeof value==='string'&&!!value.trim());
 if(products.some(product=>malformedProduct(text,product)))return 'malformed_product_phrase';
 const discourse=shoppingDiscourse(index,text);
 if(!discourse?.sentenceRoles.length||!discourse.remaining.length)return;
 if(products.some(product=>discourse.sentenceRoles.some(role=>contains(role.text,product))&&!discourse.remaining.some(part=>contains(part.text,product))))return 'response_as_product';
 // Complete contextual reads consume one substantive sentence. Multiple clauses
 // need their own interpretation; an isolated scored noun does not cover them.
 if(discourse.remaining.length>1&&!shoppingUtterance(index,text)?.budget)return 'unparsed_sentences';
}
