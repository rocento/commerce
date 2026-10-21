import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {projectKnowledge,importLanguageKnowledge} from '../src/knowledge-store.ts';
import {knowledgeHash} from '../src/language-knowledge.ts';
import pg from 'pg';
const {values}=parseArgs({options:{pack:{type:'string'},base:{type:'string'},output:{type:'string'},report:{type:'string'},database:{type:'boolean',default:false},apply:{type:'boolean',default:false},'expected-fingerprint':{type:'string'}}});
if(!values.pack)throw new Error('--pack is required');
const protectedPaths=[values.pack,...(!values.database?[values.base??'data/compiled.json']:[])].map(p=>resolve(p));
for(const target of [values.output,values.report].filter((v):v is string=>!!v))if(protectedPaths.includes(resolve(target)))throw new Error('Output must not overwrite an input');
if(values.output&&values.report&&resolve(values.output)===resolve(values.report))throw new Error('Candidate and report need separate paths');
const input=JSON.parse(await readFile(values.pack,'utf8'));
async function atomic(path:string,value:unknown){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,path);}finally{await rm(temp,{force:true});}}
let report:unknown;
if(values.database){
 if(values.base||values.output)throw new Error('Database candidates are stored as inactive immutable releases; export the exact candidate with export:db-release -- --release-id <uuid> before evaluation and promotion');
 if(!process.env.DATABASE_URL||!values['expected-fingerprint'])throw new Error('Explicit DATABASE_URL and --expected-fingerprint are required');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000});
 try{await client.connect();report=await importLanguageKnowledge(client,input,{apply:values.apply,expectedFingerprint:values['expected-fingerprint']});}finally{await client.end();}
}else{
 if(values.apply||values['expected-fingerprint'])throw new Error('--apply and --expected-fingerprint require --database');
 const bytes=await readFile(values.base??'data/compiled.json','utf8'),base=JSON.parse(bytes),result=projectKnowledge(base,input);
 const {generationFingerprint:_old,corpus:_corpus,...content}=result.dictionary;
 const fingerprint=result.unchanged?base.generationFingerprint:knowledgeHash(content),artifact={...content,corpus:[],generationFingerprint:fingerprint};
 if(values.output)await atomic(values.output,artifact);
 report={schemaVersion:1,mode:'offline-candidate',activated:false,packSha256:result.packSha256,baseSha256:createHash('sha256').update(bytes).digest('hex'),baseFingerprint:base.generationFingerprint,candidateFingerprint:fingerprint,concepts:result.pack.concepts.length,rules:result.pack.rules.length,byKind:result.byKind};
}
if(values.report)await atomic(values.report,report);
console.log(JSON.stringify(report,null,2));
