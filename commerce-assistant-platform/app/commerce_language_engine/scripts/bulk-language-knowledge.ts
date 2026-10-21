import {recognitionSeed} from '../src/recognition-seed.ts';
import {compileRecognitionRules,enterRecognitionRules} from '../src/recognition-rules.ts';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {boundedRead,prepareBulkBundle,uploadBulkBundle,inspectBulkImport,finalizeBulkImport,cancelBulkImport} from '../src/knowledge-bulk.ts';
enterRecognitionRules(compileRecognitionRules(recognitionSeed()));
const {values,positionals}=parseArgs({allowPositionals:true,options:{pack:{type:'string'},bundle:{type:'string'},id:{type:'string'},'expected-fingerprint':{type:'string'},'batch-size':{type:'string'},'max-chunks':{type:'string'}}});
const command=positionals[0];
if(positionals.length!==1||!['prepare','upload','inspect','finalize','cancel'].includes(command))throw new Error('Use prepare, upload, inspect, finalize or cancel; activation is separate');
if(command==='prepare'){
 if(!values.pack||!values.bundle)throw new Error('prepare requires --pack and a new --bundle directory');
 const manifest=await prepareBulkBundle(JSON.parse((await boundedRead(values.pack,32*1024*1024)).toString('utf8')),values.bundle,Number(values['batch-size']??250));
 console.log(JSON.stringify({packSha256:manifest.packSha256,concepts:manifest.concepts,chunks:manifest.chunks.length,activated:false}));
}else{
 if(!process.env.DATABASE_URL)throw new Error('Explicit operator DATABASE_URL is required');
 if(command==='upload'&&(!values.bundle||!values['expected-fingerprint']))throw new Error('upload requires --bundle and --expected-fingerprint');
 if(command!=='upload'&&!values.id)throw new Error('An import --id is required');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:120000});
 try{await client.connect();const result=command==='upload'?await uploadBulkBundle(client,values.bundle!,values['expected-fingerprint']!,Number(values['max-chunks']??10000)):command==='inspect'?await inspectBulkImport(client,values.id!):command==='finalize'?await finalizeBulkImport(client,values.id!):await cancelBulkImport(client,values.id!);console.log(JSON.stringify(result,null,2));}finally{await client.end();}
}

