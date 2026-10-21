import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compile} from '../src/compiler.ts';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {questionOverlapPairs,reviewContentHash} from '../src/rule-governance.ts';
import {explainKnowledge} from '../src/knowledge-explanation.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';

export async function governKnowledge(args:string[]){
 const {positionals,values}=parseArgs({args,allowPositionals:true,options:{base:{type:'string'},pack:{type:'string'},output:{type:'string'},reviewer:{type:'string'},method:{type:'string'},text:{type:'string'}}});
 const command=positionals[0];
 if(positionals.length!==1||!['validate','review','explain'].includes(command)||!values.base||!values.pack)throw new Error('Use validate|review|explain --base DICTIONARY --pack PACK; review requires --reviewer --method human|ai_assisted --output NEW_PACK; explain requires --text');
 const base=JSON.parse(await readFile(values.base,'utf8')),pack=canonicalKnowledge(JSON.parse(await readFile(values.pack,'utf8')));
 const projected=projectKnowledge(base,pack).dictionary;
 const {corpus:_corpus,generationFingerprint:_old,...content}=projected;
 projected.generationFingerprint=knowledgeHash(content);
 const compiled=compile(projected);
 if(command==='explain'){if(!values.text)throw new Error('--text required');return explainKnowledge(compiled,values.text);}
 if(!pack.ruleGovernance)throw new Error('Pack has no governance records');
 if(command==='review'){
  if(!values.output||!values.reviewer?.trim()||!['human','ai_assisted'].includes(values.method??''))throw new Error('Explicit reviewer, review method and new output path required');
  for(const row of pack.ruleGovernance){row.status='reviewed';row.review={reviewer:values.reviewer,method:values.method as 'human'|'ai_assisted',reviewedAt:new Date().toISOString(),contentSha256:reviewContentHash(row)};}
  compile({...base,languageKnowledge:pack});
  await writeFile(values.output,JSON.stringify(pack,null,2)+'\n',{flag:'wx'});
 }
 return {valid:true,packId:pack.id,revision:pack.revision,sha256:knowledgeHash(pack),rules:pack.ruleGovernance.length,examples:pack.ruleGovernance.reduce((n,r)=>n+r.examples.length,0),counterexamples:pack.ruleGovernance.reduce((n,r)=>n+r.counterexamples.length,0),overlapPairs:questionOverlapPairs(pack),reviewed:pack.ruleGovernance.every(r=>r.status==='reviewed'),scope:'Matching fixtures and rule contracts; no live or held-out evaluation.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await governKnowledge(process.argv.slice(2)),null,2));
