import './recognition-test-context.ts';
/** Real HTTP transport and disposable PostgreSQL failure/recovery boundaries. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import pg from 'pg';

const exec=promisify(execFile);
const database=process.env.ENGLISH_VOCABULARY_TEST_DATABASE_URL;

test('HTTP request fragmentation preserves UTF-8 product names and raw byte limits', {timeout:15000}, async()=>{
 const child=spawn(process.execPath,['src/server.ts'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 try{
  const url=await new Promise<string>((resolve,reject)=>{
   let output='',errors='';const timer=setTimeout(()=>reject(new Error('engine startup timed out: '+errors)),5000);
   child.stderr.on('data',chunk=>{errors+=String(chunk);});
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',code=>{clearTimeout(timer);reject(new Error(`engine exited ${code}: ${errors}`));});
   child.stdout.on('data',chunk=>{output+=String(chunk);const match=/http:\/\/127\.0\.0\.1:\d+/.exec(output);if(match){clearTimeout(timer);resolve(match[0]);}});
  });
  const send=(bytes:Buffer,split?:number)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
   const req=request(url+'/api/resolve',{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length}},res=>{
    const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
    res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
   });
   req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('HTTP test timed out')));
   if(split===undefined)req.end(bytes);
   else{req.write(bytes.subarray(0,split));void delay(30).then(()=>req.end(bytes.subarray(split)));}
  });
  for(const product of ['café','crème brûlée','tea 🍵']){
   const bytes=Buffer.from(JSON.stringify({text:`find "${product}"`}));
   const whole=await send(bytes);assert.equal(whole.status,200);
   const boundary=bytes.findIndex(byte=>byte>=0xc0)+1;
   const split=await send(bytes,boundary);assert.equal(split.status,200);
   const {latencyMs:wholeLatency,...wholeResult}=whole.body;
   const {latencyMs:splitLatency,...splitResult}=split.body;
   assert.equal(typeof wholeLatency,'number');assert.equal(typeof splitLatency,'number');
   assert.deepEqual(splitResult,wholeResult,`split UTF-8 code point changed ${product}`);
  }
  assert.equal((await send(Buffer.from(JSON.stringify({text:'x'.repeat(4001)})))).status,400);
  assert.equal((await send(Buffer.alloc(32769,120))).status,413);
  assert.equal((await send(Buffer.from(JSON.stringify({text:'show my cart'})))).status,200);
  assert.equal((await send(Buffer.from('{'))).status,400);
 }finally{if(child.exitCode===null){child.kill();await once(child,'exit');}}
});

test('PostgreSQL recovery and durable sessions preserve transaction and ownership boundaries',{skip:!database,timeout:60000},async t=>{
 const admin=new pg.Client({connectionString:database});await admin.connect();
 const name='language_recovery_'+randomUUID().replaceAll('-','');
 let created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const target=new URL(database!);target.pathname='/'+name;
  const run=(source:string)=>exec(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:target.href,CLE_DB_POOL_MAX:'1'},timeout:30000});
  await run(`import {migrate,saveDictionary,closeDb} from './src/database.ts';import {buildExpandedDictionary} from './src/generation/dictionary.ts';try{await migrate();const dictionary=buildExpandedDictionary();await saveDictionary(dictionary,dictionary.corpus,{}, {bootstrap:true});}finally{await closeDb();}`);
  await t.test('SQL failure does not poison subsequent borrowers',async()=>{
   await run(`
    import assert from 'node:assert/strict';import pg from 'pg';
    import {loadDictionary,withDb,closeDb} from './src/database.ts';
    const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
    try{
     await admin.query('ALTER TABLE release.channels RENAME TO channels_recovery_test');
     try{await assert.rejects(loadDictionary(),/does not exist/);}
     finally{await admin.query('ALTER TABLE release.channels_recovery_test RENAME TO channels');}
     assert.equal(await withDb(async c=>(await c.query('SELECT 1 AS healthy')).rows[0].healthy),1);
     assert.ok((await loadDictionary()).intents.length>0);
    }finally{await closeDb();await admin.end();}
   `);
  });
  await t.test('invalid corpus decoding does not retain a stale snapshot',async()=>{
   await run(`
    import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
    import {loadDictionary,closeDb} from './src/database.ts';
    const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
    try{
     const original=(await admin.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0].release_id;
     const invalid=randomUUID();
     await admin.query("INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) SELECT $1,dictionary_version,fingerprint||'-invalid',schema_version,artifact,$2,manifest FROM release.dictionaries WHERE id=$3",[invalid,Buffer.from('invalid gzip'),original]);
     // Deliberate storage corruption in this disposable superuser database.
     // Normal writes are blocked by the release activation trigger.
     await admin.query('SET session_replication_role = replica');
     await admin.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[invalid]);
     try{await assert.rejects(loadDictionary(),/header|gzip|compression/i);}
     finally{await admin.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[original]);}
     assert.ok((await loadDictionary()).intents.length>0,'fixed release must become visible without restarting the pool');
    }finally{await admin.query('SET session_replication_role = origin');await closeDb();await admin.end();}
   `);
  });
  await t.test('durable sessions isolate tenants, reject duplicate revisions and expire',async()=>{
   await run(`
    import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
    import {PendingSessionRepository,MissingSession,StaleSessionRevision} from './src/pending-session.ts';
    import {loadRuntime} from './src/runtime.ts';
    const clients=[new pg.Client({connectionString:process.env.DATABASE_URL}),new pg.Client({connectionString:process.env.DATABASE_URL})];
    await Promise.all(clients.map(c=>c.connect()));
    try{
     const dictionary=(await loadRuntime()).dictionary,repos=clients.map(c=>new PendingSessionRepository(c,dictionary,60));
     const tenant=randomUUID(),other=randomUUID(),session=randomUUID();
     await repos[0].create(tenant,session,{pendingRequest:'add two apples to cart'});
     assert.equal((await repos[0].load(tenant,session)).context.pendingRequest,'add two apples to cart');
     await assert.rejects(repos[1].load(other,session),MissingSession);
     await assert.rejects(repos[1].update(other,session,1,{}),MissingSession);
     await assert.rejects(repos[1].cancel(other,session,1),MissingSession);
     const results=await Promise.allSettled(repos.map(repo=>repo.update(tenant,session,1,{collection:'cart'})));
     assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
     assert.ok(results.some(result=>result.status==='rejected'&&result.reason instanceof StaleSessionRevision));
     assert.equal((await repos[0].load(tenant,session)).revision,2);
     await assert.rejects(repos[0].cancel(tenant,session,1),StaleSessionRevision);
     await repos[0].cancel(tenant,session,2);
     await assert.rejects(repos[1].load(tenant,session),MissingSession);
     await assert.rejects(repos[1].update(tenant,session,2,{}),MissingSession);
     assert.equal(await repos[0].purgeExpired(),1);
     const expired=randomUUID();await repos[0].create(tenant,expired,{});
     await clients[0].query("UPDATE context.sessions SET expires_at=now()-interval '1 second' WHERE session_id=$1",[expired]);
     await assert.rejects(repos[1].load(tenant,expired),MissingSession);
     await assert.rejects(repos[1].update(tenant,expired,1,{}),MissingSession);
     assert.equal(await repos[0].purgeExpired(),1);
     assert.equal((await clients[0].query('SELECT count(*) AS count FROM context.sessions')).rows[0].count,'0');
    }finally{await Promise.all(clients.map(c=>c.end()));}
   `);
  });
 }finally{if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});
