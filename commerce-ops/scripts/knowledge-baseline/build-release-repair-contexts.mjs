import {cpSync,mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,basename} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-release-repair-20261010'));
const build=join(out,'build/ai-service'),language=join(build,'app/commerce_language_engine');
const pythonSource=process.argv[3]?resolve(process.argv[3]):(basename(out)==='final'?join(root,'output/enterprise-knowledge-release-repair-20261010/build/ai-service'):join(root,'ai-service'));
if(existsSync(build))throw Error('Build context already exists');
mkdirSync(language,{recursive:true});
for(const name of ['src','migrations','scripts','public','package.json','package-lock.json','Dockerfile','.dockerignore'])cpSync(join(out,'engine',name),join(language,name),{recursive:true});
cpSync(join(out,'rehearsal/candidate-data'),join(language,'data'),{recursive:true});
for(const name of ['app','knowledge'])cpSync(join(pythonSource,name),join(build,name),{recursive:true,filter:path=>!['node_modules','__pycache__','.DS_Store','commerce_language_engine'].includes(basename(path))});
for(const name of ['Dockerfile','.dockerignore','requirements.lock'])cpSync(join(pythonSource,name),join(build,name));
const hash=b=>createHash('sha256').update(b).digest('hex');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]).sort();
for(const [component,directory] of [['language',language],['python',build]]){
 const files=Object.fromEntries(walk(directory).map(path=>[relative(directory,path),hash(readFileSync(path))]));
 writeFileSync(join(out,component+'-build-manifest.json'),JSON.stringify(files,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({component,files:Object.keys(files).length}));
}
