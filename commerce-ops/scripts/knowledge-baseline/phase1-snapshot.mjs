// Freeze the candidate independently of the active local/production release.
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './lib.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-phase1-20261010'));
if(existsSync(join(out,'snapshot-manifest.json')))throw new Error('Snapshot exists; choose a new output directory');
const source=join(root,'commerce-assistant-platform/app/commerce_language_engine'),target=join(out,'engine');
const names=['src','migrations','package.json','package-lock.json','scripts/evaluate-shopper-csv.ts','scripts/shopper-csv-evaluation.ts'];
mkdirSync(target,{recursive:true});
for(const name of names){mkdirSync(resolve(target,name,'..'),{recursive:true});cpSync(join(source,name),join(target,name),{recursive:true});}
mkdirSync(join(target,'data'),{recursive:true});cpSync(join(out,'candidate.json'),join(target,'data/compiled.json'));
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]).sort();
const files=Object.fromEntries(walk(target).map(path=>[relative(target,path),sha256(readFileSync(path))]));
for(const [name,hash] of Object.entries(files))if(name!=='data/compiled.json'&&hash!==sha256(readFileSync(join(source,name))))throw new Error('Source changed while freezing: '+name);
const candidate=JSON.parse(readFileSync(join(out,'candidate.json')));
writeFileSync(join(out,'snapshot-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'Local governed candidate; no production mutation',files,artifact:{fingerprint:candidate.generationFingerprint,revision:candidate.languageKnowledge.revision},baseline:'output/enterprise-knowledge-phase0-20261010',heldOutExecuted:false},null,2)+'\n');
console.log(JSON.stringify({out,files:Object.keys(files).length,revision:candidate.languageKnowledge.revision}));
