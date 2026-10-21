import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import {parseRequest,type ParsedFrame} from './request-parser.ts';
import type {Dictionary,Match} from './types.ts';

// An incomplete collection operation is a clarification opportunity, not a
// guessed cart intent. Reuse frame grammars without putting inferred words in
// the user's token matches or semantic evidence.
export function collectionContext(tokens:string[],dictionary:Dictionary,matches:Match[]) {
 return withDictionaryRecognition(dictionary,()=>{
 const productCue=matches.some(m=>!m.negated&&(m.group==='OBJECT_PRODUCT'||m.group==='REFERENCE_IT'));
 if(!productCue||matches.some(m=>m.negated||m.group==='NON_COMMERCE_REQUEST'||m.group.startsWith('OBJECT_')&&m.group!=='OBJECT_PRODUCT'&&!matches.some(product=>product.group==='OBJECT_PRODUCT'&&product.start===m.start&&product.end===m.end)))return [];
 const options:ParsedFrame[]=[];
 for(const schema of dictionary.actionFrames??[]) {
  const suffix=normalize(schema.prepositions[0]+' '+schema.targets[0]).split(' ');
  const frames=parseRequest([...tokens,...suffix],{...dictionary,actionFrames:[schema]});
  for(const frame of frames){
   if(frame.negated||frame.instructional||frame.excludedObject||frame.end<=tokens.length)continue;
   // Only a command (possibly with a polite wrapper), not a quoted or multi-action fragment.
   const prefix=tokens.slice(0,frame.start);
   const wrappers=new Set([languageValue<string>('collection-context.wrappers.value.1'),...(dictionary.requestPrefixes??[]).flatMap(p=>normalize(p).split(' '))]);
   if(prefix.some(t=>!wrappers.has(t)))continue;
   if(matches.some(m=>m.group.startsWith('ACTION_')&&m.start>=frame.start+normalize(frame.action).split(' ').length))continue;
   options.push({...frame,end:tokens.length,contextual:true});
  }
 }
 return options;

 });
}
