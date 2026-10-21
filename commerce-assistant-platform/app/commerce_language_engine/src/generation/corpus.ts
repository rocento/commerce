import {withDictionaryRecognition} from '../recognition-rules.ts';
import {compatibleCase} from '../rocento-capabilities.ts';
import {expansionCases} from './data-expansion.ts';
import {searchCases} from './search-cases.ts';
import {transferCases} from './transfer-cases.ts';
import {authoredCoverageCases,compositionalCoverageCases} from './coverage-cases.ts';
import {structureCases} from './structure-cases.ts';
import {conversationalCases} from './conversation-cases.ts';
import {adjudicateCase} from './corpus-adjudication.ts';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {catalog} from '../catalog.ts';
import {normalize} from '../normalize.ts';
import type {CorpusCase,Dictionary} from '../types.ts';

export const frames = [
 {id:'direct',split:'train',render:(s:string)=>s},
 {id:'polite-prefix',split:'train',render:(s:string)=>'please '+s},
 {id:'ability-question',split:'train',render:(s:string)=>'can you '+s},
 {id:'request-clause',split:'train',render:(s:string)=>'i would like you to '+s},
 {id:'polite-suffix',split:'development',render:(s:string)=>s+' please'},
 {id:'would-question',split:'development',render:(s:string)=>'would you '+s},
 {id:'help-request',split:'test',render:(s:string)=>'could you help me '+s},
 {id:'kind-request',split:'test',render:(s:string)=>'kindly '+s},
] as const;
export function caseKey(c:CorpusCase):string {
 const identity:unknown[]=[normalize(c.text),c.context?.previousIntent??null,[...(c.context?.states??[])].sort(),c.context?.collection??null];
 // Keep historical unscoped sampling stable while distinguishing scoped senses.
 if(c.context?.industry)identity.push(c.context.industry);
 return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function* generateCorpus(d:Dictionary):Generator<CorpusCase> {
 for(const c of d.corpus)yield c;
 for(const c of expansionCases())yield c;
 yield* searchCases();
 yield* transferCases();
 for(const c of authoredCoverageCases())yield c;
 yield* compositionalCoverageCases(d);
 for(const c of conversationalCases)yield c;
 for(const c of structureCases())yield c;
 const groups=new Map(d.groups.map(g=>[g.code,g]));
 // A bounded, grammatical verb inventory avoids invalid permutations such as "what warranty".
 const commandVerbs=new Set(['show','show me','check','find','list','read','download','get','create','add','remove','delete','change','update','cancel','start','select','choose','request','report','track','view','open','apply','use','redeem','print','resend','schedule','book','extend','restore','save','share','rename','set','retry','explain','enable','disable','accept','reject','upload','join','leave','resume','skip','reopen','close','escalate','verify','play','archive','unarchive','export','merge','replace','move','pause','stop','clear']);
 for(const i of d.intents) {
  if(i.family==='Conversation'||i.states.length)continue;
  const required=i.conditions.filter(c=>c.kind==='REQUIRED');if(required.length!==2)continue;
  const actions=groups.get(required[0].group)!.terms.filter(t=>commandVerbs.has(t));
  const objects=groups.get(required[1].group)!.terms;
  for(const action of actions)for(const object of objects)for(const frame of frames) {
   yield {text:frame.render(action+' '+object),intent:i.code==='CART_ITEM_COUNT'?'CART_TOTAL':i.code,status:['SELECT_DELIVERY_SLOT','CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST'].includes(i.code)?'NEEDS_CONTEXT':'RESOLVED',difficulty:frame.split==='train'?'EASY':'MEDIUM',split:frame.split,templateFamily:frame.id,source:'intent-command-v2'};
  }
 }
 // Meaningful constrained search compositions. Attribute choices belong to the category.
 // Price grid exercises operators/decimals/currency formatting; it is not independent semantic breadth.
 const prices=[5,10,20,25,40,50,75,99,100,150,200,250,500,750,1000,1500,2000,3000,5000,99.95];
 const operators=[{phrase:'under',operator:'<'},{phrase:'at most',operator:'<='},{phrase:'above',operator:'>'}];
 const verbs=['find','show me','look for','search'];
 for(const item of catalog) {
  const attributes:{words:string;entities:Record<string,unknown>;suffix:string}[]=[{words:'',entities:{},suffix:''}];
  for(const color of item.colors??[])attributes.push({words:color+' ',entities:{color},suffix:''});
  for(const material of item.materials??[])attributes.push({words:material+' ',entities:{material},suffix:''});
  for(const color of item.colors??[])for(const size of item.sizes??[])attributes.push({words:color+' ',entities:{color,size},suffix:' size '+size});
  for(const size of item.sizes??[])if(!item.colors?.length)attributes.push({words:'',entities:{size},suffix:' size '+size});
  for(const alias of item.aliases.slice(0,2))for(const attrs of attributes)for(const price of prices)for(const op of operators)for(const verb of verbs)for(const frame of frames) {
   if(attrs.words.trim()&&(normalize(alias).split(' ').includes(attrs.words.trim())||item.aliases.some(a=>normalize(a)===normalize(attrs.words+alias))))continue;
   yield {text:frame.render(`${verb} ${attrs.words}${alias}${attrs.suffix} ${op.phrase} $${price}`),intent:'PRODUCT_SEARCH',difficulty:'MEDIUM',entities:{category:item.category,...attrs.entities,price:{operator:op.operator,value:price,currency:'USD'}},split:frame.split,templateFamily:'catalog-'+frame.id,source:'constrained-catalog-v2'};
  }
 }
 for(const t of d.transitions) {
  const terms=groups.get(t.group)!.terms;
  for(const term of terms)for(const frame of frames.filter(f=>['direct','polite-prefix','polite-suffix'].includes(f.id))) {
   // Removal context still requires the actual remove action.
   const text=frame.render(t.intent==='REMOVE_FROM_CART'?'remove the '+term:term);
   yield {text,intent:t.intent,context:{previousIntent:t.previousIntent,states:t.states},difficulty:'CONTEXT_REQUIRED',split:frame.split,templateFamily:'context-'+frame.id,source:'transition-v2'};
  }
 }
 for(const i of d.intents.filter(i=>!i.states.length&&i.conditions.length>=2)) {
  const action=groups.get(i.conditions[0].group)!.terms.find(t=>commandVerbs.has(t));
  const object=groups.get(i.conditions[1].group)!.terms[0];
  if(!action)continue;
  yield {text:`do not ${action} ${object}`,intent:null,status:'UNKNOWN',difficulty:'NEGATIVE_CONFLICT',split:'development',templateFamily:'negated-action',source:'contrastive-v2'};
  yield {text:`never ${action} ${object}`,intent:null,status:'UNKNOWN',difficulty:'NEGATIVE_CONFLICT',split:'test',templateFamily:'never-action',source:'contrastive-v2'};
 }
 for(const [a,b] of d.conflicts) {
  const first=d.intents.find(i=>i.code===a)!,second=d.intents.find(i=>i.code===b)!;
  if(first.conditions[1]?.group!==second.conditions[1]?.group)continue;
  const object=groups.get(first.conditions[1].group)!.terms[0];
  const x=groups.get(first.conditions[0].group)!.terms[0],y=groups.get(second.conditions[0].group)!.terms[0];
  yield {text:`${x} and ${y} ${object}`,intent:null,status:'AMBIGUOUS',difficulty:'AMBIGUOUS',split:'test',templateFamily:'opposite-actions',source:'contrastive-v2'};
 }
 for(const [text,intent] of [['trak my order','TRACK_ORDER'],['wheres mi ordar','TRACK_ORDER'],['find shooes','PRODUCT_SEARCH']])yield {text,intent,difficulty:'TYPO_NOISE',split:'test',templateFamily:'controlled-typo',source:'contrastive-v2'};
 // Destructive typo recovery must clarify, even when the intended verb seems likely.
 yield {text:'cancle my order',intent:null,status:'NEEDS_CONTEXT',difficulty:'TYPO_NOISE',split:'test',templateFamily:'protected-destructive-typo',source:'contrastive-v2'};
 for(const text of ['tell me a joke','write a poem about shoes','what is the weather','purple elephants sing jazz','order','cancel','asdf qwer zxcv'])yield {text,intent:null,status:'UNKNOWN',difficulty:'HARD',split:'test',templateFamily:'out-of-domain',source:'contrastive-v2'};
}

export function collectCorpus(d:Dictionary,searchLimit=100000) {
 return withDictionaryRecognition(d,()=>{
 const seen=new Map<string,CorpusCase>();let duplicates=0;const labelConflicts:{text:string;labels:(string|null)[]}[]=[];
 let searchCount=0;
 // A deterministic per-category reservoir covers the whole iterator, not just its first prices/attributes.
 const searchByCategory=new Map<string,CorpusCase[]>();
 const encountered=new Map<string,number>();
 const supported=new Set(d.intents.map(i=>i.code));
 for(const original of generateCorpus(d)) {
  const c=adjudicateCase(original).next;
  if(!compatibleCase(c,supported))continue;
  if(c.source==='constrained-catalog-v2') {
   const category=c.entities!.category as string;
   const bucket=searchByCategory.get(category)??[];
   const quota=Math.ceil(searchLimit/catalog.length);
   const hash=caseKey(c);const value=parseInt(hash.slice(0,8),16);
   const count=(encountered.get(category)??0)+1;encountered.set(category,count);
   if(bucket.length<quota)bucket.push(c);
   else {const slot=value%count;if(slot<quota)bucket[slot]=c;}
   searchByCategory.set(category,bucket);continue;
  }
  add(c);
 }
 // Interleave categories so a rounded quota cannot exhaust the limit before
 // the final category. Stable bucket order keeps generation reproducible.
 const buckets=[...searchByCategory.values()];
 for(let index=0;searchCount<searchLimit&&buckets.some(bucket=>index<bucket.length);index++) {
  for(const bucket of buckets){if(searchCount>=searchLimit)break;const c=bucket[index];if(c){add(c);searchCount++;}}
 }
 function add(c:CorpusCase) {
  const key=caseKey(c),previous=seen.get(key);
  if(previous){duplicates++;if(previous.intent!==c.intent||(previous.status??'RESOLVED')!==(c.status??'RESOLVED')||previous.entities&&c.entities&&!isDeepStrictEqual(previous.entities,c.entities))labelConflicts.push({text:c.text,labels:[previous.intent,c.intent]});return;}
  seen.set(key,c);
 }
 if(labelConflicts.length)throw new Error('Conflicting generated labels: '+JSON.stringify(labelConflicts.slice(0,20)));
 return {cases:[...seen.values()],duplicates,searchCount};
 });
}
