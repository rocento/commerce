/** Exact, typed lexical lookup. A match is wording, never merchant evidence. */
import {knowledgeTokens,type KnowledgeIndex,type KnowledgeKind} from './language-knowledge.ts';
export function lexicalConcept(index:KnowledgeIndex|undefined,kind:KnowledgeKind,text:string){
 const words=knowledgeTokens(text);if(!index||!words.length)return;
 const matches=(index.byFirstToken.get(words[0])??[]).filter(entry=>entry.concept.kind===kind&&entry.tokens.length===words.length&&entry.tokens.every((word,i)=>word===words[i]));
 return new Set(matches.map(x=>x.concept.id)).size===1?matches[0]?.concept:undefined;
}
