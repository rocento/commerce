// Freeze only the language engine and evaluation inputs, without credentials.
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {resolve, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-phase0-20261010'));
const engine=join(root,'commerce-assistant-platform/app/commerce_language_engine');
const target=join(out,'engine');
if(existsSync(join(out,'snapshot-manifest.json')))throw new Error('Snapshot already exists; use a new output directory.');
const hash=body=>createHash('sha256').update(body).digest('hex');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]).sort();}
const names=['src','migrations','package.json','package-lock.json','data/compiled.json','scripts/evaluate-shopper-csv.ts','scripts/shopper-csv-evaluation.ts'];
const sourceFiles=names.flatMap(name=>['src','migrations'].includes(name)?files(join(engine,name)):[join(engine,name)]);
const before=Object.fromEntries(sourceFiles.map(p=>[relative(engine,p),hash(readFileSync(p))]));
mkdirSync(target,{recursive:true});
for(const name of names){mkdirSync(resolve(target,name,'..'),{recursive:true});cpSync(join(engine,name),join(target,name),{recursive:true});}
for(const [name,digest] of Object.entries(before)){
 if(hash(readFileSync(join(engine,name)))!==digest||hash(readFileSync(join(target,name)))!==digest)throw new Error('Source changed while copying: '+name);
}
const corpusRoot=join(root,'output/live-shopper-eval-20261008');
const sourceNames=['live-shopping-assistant-4000-english.csv','cases.json','methodology.json','assess.py','corpus.py','observations.jsonl','assessed.json','product-details.json',...['grocery','jewelry','electronics','pharmacy'].map(s=>s+'-catalog.json')];
const sources=sourceNames.map(name=>{const p=join(corpusRoot,name),body=readFileSync(p);return {path:relative(root,p),sha256:hash(body),bytes:body.length};});
const artifact=JSON.parse(readFileSync(join(target,'data/compiled.json')));
writeFileSync(join(out,'snapshot-manifest.json'),JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),scope:'Frozen local language code and artifact; original evaluation inputs remain read-only and are hash-verified.',engineFiles:before,sources,artifact:{generationFingerprint:artifact.generationFingerprint,dictionaryVersion:artifact.version,knowledgeRevision:artifact.languageKnowledge?.revision},limits:['No current commerce database snapshot; catalog files represent the historical evaluation capture.','No claim that local source and deployed executable source match until runtime identities are compared.']},null,2)+'\n');
console.log(JSON.stringify({out,files:sourceFiles.length,sources:sources.length,artifactFingerprint:artifact.generationFingerprint}));
