import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'output/enterprise-knowledge-expansion-20261010'),engine=join(root,'commerce-assistant-platform/app/commerce_language_engine');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(existsSync(join(out,'snapshot-manifest.json')))throw new Error('Snapshot already frozen; choose a new evidence run for later changes');
mkdirSync(join(out,'engine/data'),{recursive:true});
for(const name of ['src','migrations','package.json','package-lock.json','scripts/evaluate-shopper-csv.ts','scripts/shopper-csv-evaluation.ts']){
 mkdirSync(resolve(out,'engine',name,'..'),{recursive:true});cpSync(join(engine,name),join(out,'engine',name),{recursive:true});
}
cpSync(join(out,'candidate.json'),join(out,'engine/data/compiled.json'));
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]).sort();
const files=Object.fromEntries(walk(join(out,'engine')).map(p=>[relative(join(out,'engine'),p),hash(readFileSync(p))]));
const preserved={};
for(const folder of ['enterprise-knowledge-phase0-20261010','enterprise-knowledge-phase1-20261010','enterprise-knowledge-phase2-20261010','enterprise-knowledge-phase2-fixes-20261010','enterprise-knowledge-phase3-20261010']){
 for(const name of readdirSync(join(root,'output',folder)).filter(f=>f.endsWith('.json'))){const path=join('output',folder,name);preserved[path]=hash(readFileSync(join(root,path)));}
}
const csv='output/live-shopper-eval-20261008/live-shopping-assistant-4000-english.csv';preserved[csv]=hash(readFileSync(join(root,csv)));
const sourcePaths=['commerce-assistant-platform/app/commerce_language_engine/src/knowledge-bulk.ts','commerce-assistant-platform/app/commerce_language_engine/src/product-meaning.ts','commerce-assistant-platform/app/commerce_language_engine/scripts/bulk-language-knowledge.ts','commerce-assistant-platform/app/commerce_language_engine/scripts/prepare-vocabulary-expansion.ts','commerce-assistant-platform/app/commerce_language_engine/scripts/stage-vocabulary-expansion-local.ts','commerce-assistant-platform/app/commerce_language_engine/data/knowledge/phase2-expansion-curated.json','commerce-assistant-platform/app/commerce_language_engine/data/knowledge/shopping-en-phase2-v3.json','commerce-assistant-platform/app/commerce_language_engine/data/knowledge/WORDNET-LICENSE.txt','commerce-assistant-platform/app/commerce_language_engine/tests/knowledge-bulk.test.ts','commerce-assistant-platform/app/commerce_language_engine/tests/vocabulary-expansion.test.ts','commerce-assistant-platform/app/commerce_language_engine/migrations/031_knowledge_bulk_imports.sql','deploy/assistant/shared-language-tenants.sql'];
const sources=Object.fromEntries(sourcePaths.map(p=>[p,hash(readFileSync(join(root,p)))]));
writeFileSync(join(out,'snapshot-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'English vocabulary expansion, inactive revision 9; no production release or Phase 0 reserved execution',files,sources,preserved},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({runtimeFiles:Object.keys(files).length,preservedArtifacts:Object.keys(preserved).length}));
