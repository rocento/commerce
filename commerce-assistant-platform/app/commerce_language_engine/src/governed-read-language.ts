import {recognitionMemo} from './recognition-rules.ts';
import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {normalize} from './normalize.ts';
import type {Dictionary} from './types.ts';
import type {canonicalRead} from './read-language.ts';

type Read=NonNullable<ReturnType<typeof canonicalRead>>;
const cache=()=>recognitionMemo('governed-read-language.cache',()=>new WeakMap<Dictionary,Map<string,Read|null>>());
/** A complete governed action/object phrase owns its domain. A noun such as
 * "ready for pickup" is not a product with a purpose, nor is "storage life"
 * a product named "life". Only exact reviewed lexicon compositions are admitted.
 */
export function governedRequest(dictionary:Dictionary,message:string):Read|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 if(message.length>4000||languagePattern('governed-read-language.governedRequest.pattern.1').test(message))return;
 const text=normalize(message);
 let index=cache().get(dictionary);
 if(!index){
  index=new Map();const groups=new Map(dictionary.groups.map(group=>[group.code,group]));
  for(const intent of dictionary.intents){
   if(intent.productArgument||intent.family==='Conversation')continue;
   const required=intent.conditions.filter(condition=>condition.kind==='REQUIRED'&&condition.active!==false);
   const action=required.find(condition=>condition.group.startsWith('ACTION_'));
   const object=required.find(condition=>condition.group.startsWith('OBJECT_'));
   if(!action||!object||required.length!==2)continue;
   const canonical=`${groups.get(action.group)?.terms[0]??''} ${groups.get(object.group)?.terms[0]??''}`;
   for(const verb of groups.get(action.group)?.terms??[])for(const noun of groups.get(object.group)?.terms??[]){
    for(const article of languageValue<string[]>('governed-read-language.governedRequest.value.1')){
     const key=normalize(`${verb} ${article}${noun}`),prior=index.get(key);
     if(prior===null||prior&&prior.intent!==intent.code){index.set(key,null);continue;}
     index.set(key,{text:canonical,intent:intent.code});
    }
   }
  }
  cache().set(dictionary,index);
 }
 return index.get(text)??undefined;

 });
}

export function governedRead(dictionary:Dictionary,message:string):Read|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 const request=governedRequest(dictionary,message);
 const intent=request&&dictionary.intents.find(intent=>intent.code===request.intent);
 return intent&&!['TRACK_ORDER','REORDER'].includes(intent.code)&&!intent.requiresConfirmation&&['INFORMATION','INTERPRET'].includes(intent.actionType??'')?request:undefined;

 });
}
