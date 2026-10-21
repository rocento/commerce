import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {englishVocabulary,englishVocabularySource,heldEnglishTerms} from '../src/generation/reviewed-english.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';

const dictionary=buildExpandedDictionary();
const baseline=structuredClone(dictionary);
for(const group of baseline.groups)group.terms=group.terms.filter(t=>group.termMetadata?.[t]?.source!==englishVocabularySource);
const before=compile(baseline),after=compile(dictionary);
type Case={text:string;intent?:string;mustNotResolve?:boolean;family:string;held?:boolean};
const cases:Case[]=[];
for(const e of englishVocabulary)for(const term of e.terms){
 for(const prefix of ['', 'please ', 'pls ', 'can you ', 'could you ', 'would you ', 'please could you '])
  for(const suffix of ['', ' please', '?'])cases.push({text:prefix+e.verb+' '+term+suffix,intent:e.intent,family:'generated-positive',held:heldEnglishTerms.has(term)});
 for(const prefix of ['do not ',"don't ",'never '])cases.push({text:prefix+e.verb+' '+term,mustNotResolve:true,family:'negation'});
 // Brand/product-like text must retain the behavior of the unmodified engine.
 cases.push({text:`find "${term}"`,family:'quoted-product-preservation'});
}
// Separately authored sentences, not rendered from the alias templates. These
// are development holdouts, not claimed as unseen human/customer transcripts.
for(const [text,intent] of [
 ['Could you pull up my earlier purchases please?','ORDER_HISTORY'],
 ['I would like to see the addresses on my account.','ACCOUNT_ADDRESS_LIST'],
 ['Please show me the accepted payment types.','PAYMENT_METHODS'],
 ['Can you show us the rules for returns?','RETURN_POLICY'],
 ['Please check the cost of shipping.','DELIVERY_COST'],
 ['Let me see the shop operating hours.','STORE_HOURS'],
 ['Could you open the garment size guide?','PRODUCT_SIZE_GUIDE'],
 ['Please list the ingredient details.','PRODUCT_INGREDIENTS'],
 ['I want to contact the customer care team.','CONTACT_SUPPORT'],
 ['Can you check the status of my reimbursement?','REFUND_STATUS'],
])cases.push({text,intent,family:'separately-authored',held:[...heldEnglishTerms].some(term=>text.toLowerCase().includes(term))});
for(const text of ["I don't need shoes",'add -2 apples to cart','add 1.5 apples to cart','add apples to cart and remove bananas from cart','find Showw X200','find coffee under $20','find shoes over $40'])cases.push({text,family:'existing-behavior'});
let improved=0,regressions=0;
const results=cases.map(c=>{
 const a=resolve(before,c.text),b=resolve(after,c.text);
 const same=JSON.stringify([a.status,a.intent,a.entities])===JSON.stringify([b.status,b.intent,b.entities]);
 const pass=c.mustNotResolve?b.status!=='RESOLVED':c.intent?b.status==='RESOLVED'&&b.intent===c.intent:same;
 const wasPass=c.mustNotResolve?a.status!=='RESOLVED':c.intent?a.status==='RESOLVED'&&a.intent===c.intent:true;
 if(pass&&!wasPass)improved++;
 if(!pass&&wasPass)regressions++;
 return {...c,pass,before:{status:a.status,intent:a.intent},after:{status:b.status,intent:b.intent}};
});
const report={source:englishVocabularySource,language:'English',provenance:'Model-authored synthetic concept aliases and test cases; no private training data or customer transcripts.',concepts:englishVocabulary.length,addedTerms:dictionary.groups.reduce((n,g)=>n+g.terms.filter(t=>g.termMetadata?.[t]?.source===englishVocabularySource).length,0),cases:cases.length,passed:results.filter(r=>r.pass).length,improved,regressions,heldTerms:[...heldEnglishTerms],releaseBlockingFailures:results.filter(r=>!r.pass&&!r.held),failures:results.filter(r=>!r.pass),fingerprint:createHash('sha256').update(JSON.stringify(dictionary)).digest('hex'),limits:['Template variations are not independent human examples.','Development holdouts have been inspected; independent human review is still useful.','Vocabulary does not implement or authorize backend actions.']};
const out=new URL('../data/enrichment/',import.meta.url);await mkdir(out,{recursive:true});
await writeFile(new URL('report.json',out),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('cases.jsonl',out),results.map(r=>JSON.stringify(r)).join('\n')+'\n');
await writeFile(new URL('dictionary.json',out),JSON.stringify(dictionary));
console.log(JSON.stringify(report,null,2));
if(report.releaseBlockingFailures.length||report.regressions)process.exitCode=1;
