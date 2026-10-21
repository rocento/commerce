import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-release-repair-20261010')),source=join(root,'commerce-assistant-platform/app/commerce_language_engine');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(existsSync(join(out,'runtime-snapshot.json')))throw Error('Already frozen; use a separately versioned run');
mkdirSync(join(out,'engine/data'),{recursive:true});
for(const name of ['src','migrations','scripts','package.json','package-lock.json','public','Dockerfile','.dockerignore'])cpSync(join(source,name),join(out,'engine',name),{recursive:true});
cpSync(join(out,'candidate.json'),join(out,'engine/data/compiled.json'));
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]).sort();
const files=Object.fromEntries(walk(join(out,'engine')).map(p=>[relative(join(out,'engine'),p),hash(readFileSync(p))]));
const prior=JSON.parse(readFileSync(join(root,'output/enterprise-knowledge-release-prep-20261010/runtime-snapshot.json'))),preserved={...prior.preserved};
for(const [name,expected] of Object.entries(preserved))if(hash(readFileSync(join(root,name)))!==expected)throw Error('Historical evidence changed: '+name);
for(const name of ['production-baseline.json','production-corpus.jsonl','verification.json','initial-archived-corpus.json','archived-diagnostics/all-failures.jsonl','rollback-backup.json','release-rehearsal.json','failed-gate-promotion-check.json']){
 const path=join('output/enterprise-knowledge-release-prep-20261010',name);preserved[path]=hash(readFileSync(join(root,path)));
}
for(const name of ['reviewed-corpus.jsonl','benchmark-patches.jsonl','benchmark-adjudication.json','benchmark-review.jsonl']){
 const path=join('output/enterprise-knowledge-release-repair-20261010/benchmark-v4',name);preserved[path]=hash(readFileSync(join(root,path)));
}
writeFileSync(join(out,'runtime-snapshot.json'),JSON.stringify({createdAt:new Date().toISOString(),files,preserved},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({files:Object.keys(files).length,preserved:Object.keys(preserved).length}));
