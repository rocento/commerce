/** Deterministic, bounded English expansion; source senses never become catalog facts. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalKnowledge,knowledgeHash,knowledgeTokens,type KnowledgeConcept,type KnowledgeKind} from '../src/language-knowledge.ts';
import {assertKnowledgeUpgrade,assertKnowledgeReviewed} from '../src/rule-governance.ts';
const root=resolve(import.meta.dirname,'../../../..'),out=join(root,'output/enterprise-knowledge-expansion-20261010');
const data=resolve(import.meta.dirname,'../data/knowledge');
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const source=await readFile(join(out,'sources/data.noun'));
const sourceHash=hash(source);
if(sourceHash!=='2cad22fe43461ee7ae61a564ae6a518c57445c8597e53542caddb5c26a6a5d94')throw new Error('WordNet source checksum mismatch');
const base=canonicalKnowledge(JSON.parse(await readFile(join(data,'shopping-en-phase2-v2.json'),'utf8'))),pack=structuredClone(base);
const curated=JSON.parse(await readFile(join(data,'phase2-expansion-curated.json'),'utf8'));
pack.revision=9;pack.source='Phase 2 expansion: restricted WordNet 3.1 noun senses and first-party English shopper wording. AI-assisted policy review; not independent item-by-item review or product evidence.\n'+await readFile(join(data,'WORDNET-LICENSE.txt'),'utf8');
const key=(s:string)=>knowledgeTokens(s).join(' '),owners=new Map<string,KnowledgeConcept[]>(),changed=new Set<string>();
function index(c:KnowledgeConcept){for(const form of [c.canonical,...c.aliases]){const k=key(form),list=owners.get(k)??[];if(!list.includes(c))list.push(c);owners.set(k,list);}}
pack.concepts.forEach(index);
const rejected:{source:string;id:string;form?:string;reason:string}[]=[];
function reviewed(c:KnowledgeConcept,sourceId:string){
 c.metadata??={};delete c.metadata.lexicalReview;
 c.metadata.lexicalReview={source:sourceId,author:'codex',reviewer:'codex',method:'ai_assisted',status:'reviewed',reviewedAt:curated.reviewedAt,formsSha256:knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:[...c.aliases].sort()}),contentSha256:knowledgeHash({...c,aliases:[...c.aliases].sort()})};
}
for(const kind of ['activity','person','material','occasion'] as KnowledgeKind[])for(const [canonical,...aliases] of curated[kind] as string[][]){
 const previous=(owners.get(key(canonical))??[]).find(c=>c.kind===kind);
 if(!previous&&owners.has(key(canonical))){rejected.push({source:curated.source,id:canonical,reason:'existing-cross-kind-canonical'});continue;}
 const c:KnowledgeConcept=previous??{id:kind+'.'+canonical.toLowerCase().replace(/[^a-z0-9]+/g,'_'),kind,canonical,aliases:[],metadata:{requiresContext:true,domains:['commerce'],usage:'explicit_relationship_only',...(kind==='person'?{personRole:'recipient'}:{})}};
 for(const alias of aliases){const matches=owners.get(key(alias))??[];
  if(matches.some(owner=>owner!==c)){rejected.push({source:curated.source,id:c.id,form:alias,reason:'existing-other-concept-alias'});continue;}
  if(![c.canonical,...c.aliases].some(form=>key(form)===key(alias)))c.aliases.push(alias);
 }
 if(!previous)pack.concepts.push(c);c.metadata={...c.metadata,domains:c.metadata?.domains??['commerce'],usage:c.metadata?.usage??'explicit_relationship_only'};index(c);changed.add(c.id);reviewed(c,curated.source);
}
type Noun={id:string;lex:string;words:string[];parents:string[]};
const nouns=new Map<string,Noun>(),meanings=new Map<string,Set<string>>();
for(const line of source.toString('utf8').split('\n')){
 if(!/^\d/.test(line))continue;const f=line.split('|')[0].trim().split(/\s+/),count=parseInt(f[3],16),p=4+count*2;
 const row:Noun={id:f[0],lex:f[1],words:Array.from({length:count},(_,i)=>f[4+2*i].replaceAll('_',' ')),parents:[]};
 for(let i=0;i<Number(f[p]);i++)if(['@','@i'].includes(f[p+1+i*4]))row.parents.push(f[p+2+i*4]);
 nouns.set(row.id,row);for(const word of row.words){const k=key(word),set=meanings.get(k)??new Set();set.add(row.id);meanings.set(k,set);}
}
// Exact reviewed sense IDs, not a substring or a generic "all nouns" import.
const roots:Record<string,string>={
 '03055525':'clothing','03385713':'footgear','03385972':'footwear','03410635':'furniture',
 '03533443':'home appliance','04523967':'utensil','04459089':'tool',
 '03283159':'electronic equipment','04291873':'sporting goods','03806455':'musical instrument',
 '03971038':'plaything','03602662':'jewelry','03117803':'cosmetic','03314753':'fabric',
 '07571428':'solid food','07581905':'foodstuff','07897775':'beverage',
 '04310495':'staple gun','04310635':'stapler',
};
const memo=new Map<string,string[]>();
function ancestry(id:string,seen=new Set<string>()):string[]{if(memo.has(id))return memo.get(id)!;if(seen.has(id))return [];const next=new Set(seen).add(id),matches=[...new Set([...(roots[id]?[id]:[]),...(nouns.get(id)?.parents??[]).flatMap(p=>ancestry(p,next))])].sort();memo.set(id,matches);return matches;}
const sourceId='princeton-wordnet-3.1-shopping-subset-v1';let selected=0;
for(const noun of nouns.values()){
 const anchors=ancestry(noun.id);if(!['06','13'].includes(noun.lex)||!anchors.length)continue;selected++;
 const forms:string[]=[];
 for(const form of noun.words){let reason='';
  if(!/^[a-z][a-z '\u2019-]*$/.test(form)||form.length>200||key(form).split(' ').length>20)reason='not-plain-English-common-noun-form';
  else if((meanings.get(key(form))?.size??0)!==1)reason='multiple-WordNet-noun-senses';
  else if(owners.has(key(form)))reason='existing-concept-surface';
  if(reason){rejected.push({source:sourceId,id:noun.id,form,reason});continue;}
  if(!forms.some(x=>key(x)===key(form)))forms.push(form);
 }
 if(!forms.length){rejected.push({source:sourceId,id:noun.id,reason:'no-unambiguous-new-forms'});continue;}
 const c:KnowledgeConcept={id:'product.wn31_'+noun.id,kind:'product',canonical:forms[0],aliases:forms.slice(1),metadata:{requiresContext:true,domains:noun.lex==='13'?['grocery']:['commerce'],usage:'lexical_annotation_only',provenance:{source:sourceId,sourceSha256:sourceHash,synset:noun.id+'-n',lexicographer:noun.lex==='13'?'noun.food':'noun.artifact',roots:anchors},reviewScope:'AI-assisted extraction-policy and sampled lexical review; no independent per-entry adjudication'}};
 reviewed(c,sourceId);pack.concepts.push(c);index(c);
}
const canonical=canonicalKnowledge(pack);assertKnowledgeUpgrade(base,canonical);assertKnowledgeReviewed(canonical);
const bytes=JSON.stringify(canonical,null,2)+'\n';await writeFile(join(data,'shopping-en-phase2-v3.json'),bytes);
const counts=(p:typeof pack)=>({concepts:p.concepts.length,forms:p.concepts.reduce((n,c)=>n+1+c.aliases.length,0),uniqueForms:new Set(p.concepts.flatMap(c=>[c.canonical,...c.aliases].map(key))).size,byKind:Object.fromEntries([...new Set(p.concepts.map(c=>c.kind))].map(k=>[k,p.concepts.filter(c=>c.kind===k).length]))});
const report={schemaVersion:1,revision:pack.revision,base:counts(base),candidate:counts(canonical),packSha256:knowledgeHash(canonical),fileSha256:hash(bytes),bytes:Buffer.byteLength(bytes),rulesUnchanged:knowledgeHash(base.ruleGovernance)===knowledgeHash(pack.ruleGovernance),source:{id:sourceId,url:'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz',archiveSha256:'3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a',nounSha256:hash(source),license:'WordNet; see WORDNET-LICENSE.txt',roots,selectedSenses:selected,importedSenses:pack.concepts.filter(c=>c.id.startsWith('product.wn31_')).length},curatedTouched:changed.size,rejected:rejected.length,rejectedByReason:Object.fromEntries([...new Set(rejected.map(r=>r.reason))].map(reason=>[reason,rejected.filter(r=>r.reason===reason).length])),activated:false,scope:'Vocabulary candidate only. No product availability, suitability, clinical or compatibility evidence. Human review and release gates remain open.'};
await mkdir(out,{recursive:true});await writeFile(join(out,'vocabulary-report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(out,'exclusions.jsonl'),rejected.map(r=>JSON.stringify(r)).join('\n')+'\n');
console.log(JSON.stringify(report,null,2));
