/** Export or stage recognition data; this command never activates a release. */
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withDb,closeDb} from '../src/database.ts';
import {loadRelease} from '../src/release-lifecycle.ts';
import {stageRecognitionRules} from '../src/recognition-authoring.ts';
import type {RecognitionRules} from '../src/recognition-rules.ts';
export async function runRecognitionCommand(args:string[]){
 const {positionals,values}=parseArgs({args,allowPositionals:true,options:{'release-id':{type:'string'},'expected-active':{type:'string'},rules:{type:'string'},output:{type:'string'}}});
 const command=positionals[0];
 if(positionals.length!==1||!['export','stage','upgrade'].includes(command)||!values['release-id'])throw new Error('Usage: recognition.ts <export|stage|upgrade> --release-id <uuid> [--output <json>] [--rules <json>] [--expected-active <uuid|none>]');
 if(!process.env.DATABASE_URL)throw new Error('Explicit DATABASE_URL is required');
 if(command==='export'){
  if(!values.output)throw new Error('--output is required');
  const base=await withDb(c=>loadRelease(c,values['release-id']!));
  if(!base.dictionary.recognitionRules)throw new Error('Legacy release requires an explicit recognition upgrade');
  await writeFile(values.output,JSON.stringify(base.dictionary.recognitionRules,null,2)+'\n',{mode:0o600});
  return {releaseId:base.releaseId,output:values.output,revision:base.dictionary.recognitionRules.revision};
 }
 if(!values['expected-active'])throw new Error('--expected-active is required');
 if(command==='stage'&&!values.rules)throw new Error('--rules is required for stage');
 if(command==='upgrade'&&values.rules)throw new Error('Use stage for supplied recognition rules');
 const rules=values.rules?JSON.parse(await readFile(values.rules,'utf8')) as RecognitionRules:undefined;
 return {activated:false,...await withDb(c=>stageRecognitionRules(c,{baseReleaseId:values['release-id']!,expectedActiveReleaseId:values['expected-active']==='none'?null:values['expected-active']!,rules}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runRecognitionCommand(process.argv.slice(2)),null,2));}finally{await closeDb();}}
