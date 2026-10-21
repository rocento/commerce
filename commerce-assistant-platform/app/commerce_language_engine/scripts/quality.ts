import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withDb,closeDb} from '../src/database.ts';
import {validateDataset,importDataset,loadDataset,captureFeedback,reviewFeedback} from '../src/reviewed-evaluation.ts';

export async function qualityCommand(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{file:{type:'string'},'dataset-id':{type:'string'}}});
 const [command]=positionals;
 if(positionals.length!==1||!['dataset-validate','dataset-import','dataset-inspect','feedback-capture','feedback-review'].includes(command))throw new Error('Usage: quality.ts <dataset-validate|dataset-import|dataset-inspect|feedback-capture|feedback-review> --file input.json (or --dataset-id UUID)');
 if(command==='dataset-inspect'){
  if(!process.env.DATABASE_URL||!values['dataset-id'])throw new Error('Explicit DATABASE_URL and --dataset-id required');
  return withDb(async c=>{const d=await loadDataset(c,values['dataset-id']!);return {datasetId:d.id,code:d.code,revision:d.revision,sha256:d.sha256,count:d.cases.length,reviewedBy:d.reviewedBy};});
 }
 if(!values.file)throw new Error('--file required');
 const input=JSON.parse(await readFile(values.file,'utf8'));
 if(command==='dataset-validate'){const d=validateDataset(input);return {valid:true,code:d.code,revision:d.revision,count:d.cases.length};}
 if(!process.env.DATABASE_URL)throw new Error('Explicit operator DATABASE_URL required');
 if(command==='dataset-import')return withDb(c=>importDataset(c,input));
 if(command==='feedback-capture')return withDb(c=>captureFeedback(c,input));
 return withDb(c=>reviewFeedback(c,input));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log(JSON.stringify(await qualityCommand(process.argv.slice(2)),null,2));}finally{await closeDb();}
}
