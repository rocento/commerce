/** Operator-only first installation. Existing databases are never migrated or seeded here. */
import pg from 'pg';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readDeploymentRelease} from './deployment-release.ts';
import {importBaselineRelease,bootstrapRelease,type ReleaseClient} from '../src/release-lifecycle.ts';

const identifier=(value:string)=>'"'+value.replaceAll('"','""')+'"';
// Lifecycle helpers own transactions. Map their boundaries to savepoints so the
// complete schema, import and activation commit atomically in our outer transaction.
function nestedClient(client:pg.Client):ReleaseClient {
 return {query:((text:string,...args:unknown[])=>{
  const boundary:Record<string,string>={BEGIN:'SAVEPOINT initial_release',COMMIT:'RELEASE SAVEPOINT initial_release',ROLLBACK:'ROLLBACK TO SAVEPOINT initial_release'};
  return client.query(boundary[text]??text,...args as []);
 }) as ReleaseClient['query']};
}
export async function installEmpty(options:{databaseUrl:string;adminDatabase:string;data?:URL}) {
 const target=new URL(options.databaseUrl);
 if(!['postgres:','postgresql:'].includes(target.protocol))throw new Error('Expected a PostgreSQL DATABASE_URL');
 const database=decodeURIComponent(target.pathname.slice(1));
 if(!database||!options.adminDatabase||database===options.adminDatabase||['postgres','template0','template1'].includes(database))throw new Error('A separate explicit language database and administrative database are required');
 const adminUrl=new URL(target);adminUrl.pathname='/'+encodeURIComponent(options.adminDatabase);
 const admin=new pg.Client({connectionString:adminUrl.href,connectionTimeoutMillis:5000});
 let client:pg.Client|undefined;
 await admin.connect();
 try {
  // Serialize database creation across deployment processes on this server.
  await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))",['language-first-install:'+database]);
  const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount;
  // Verify a missing database's bundle before creating even an empty database.
  let packaged=exists?undefined:await readDeploymentRelease(options.data);
  if(packaged?.release?.payload.format!==2&&!exists)throw new Error('First installation requires a verified version 2 release bundle');
  if(!exists)await admin.query('CREATE DATABASE '+identifier(database));
  client=new pg.Client({connectionString:target.href,connectionTimeoutMillis:5000});await client.connect();
  await client.query('BEGIN');
  try {
   await client.query('SELECT pg_advisory_xact_lock(57439)');
   const populated=(await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%') OR
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace) OR
    EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace) OR
    EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace) OR
    EXISTS(SELECT 1 FROM pg_extension WHERE extname<>'plpgsql') AS populated`)).rows[0].populated;
   if(populated){await client.query('ROLLBACK');return {status:'existing-database-unchanged'};}
   packaged??=await readDeploymentRelease(options.data);
   const release=packaged.release;
   if(release?.payload.format!==2)throw new Error('First installation requires a verified version 2 release bundle');
   const payload=release.payload;
   await client.query('CREATE TABLE public.schema_migrations(filename text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   const directory=new URL('../migrations/',import.meta.url);
   const files=(await readdir(directory)).filter(file=>file.endsWith('.sql')).sort();
   if(!files.length)throw new Error('Language migrations are missing');
   for(const file of files){
    const sql=await readFile(new URL(file,directory),'utf8');
    const body=sql.replace(/^\s*BEGIN\s*;?/i,'').replace(/COMMIT\s*;?\s*$/i,'');
    await client.query(body);
    await client.query('INSERT INTO public.schema_migrations(filename,sha256) VALUES($1,$2)',[file,createHash('sha256').update(sql).digest('hex')]);
   }
   const nested=nestedClient(client);
   await importBaselineRelease(nested,{...payload.identity,dictionary:payload.artifact,corpus:payload.corpus,corpusArchive:Buffer.from(payload.corpusArchive,'base64'),manifest:{...payload.manifest,bundleChecksum:release.checksum}});
   await bootstrapRelease(nested,{releaseId:payload.identity.releaseId,actor:'deployment-first-install',reason:'Initialize empty language database from verified packaged release'});
   await client.query('COMMIT');
   return {status:'installed',releaseId:payload.identity.releaseId,migrations:files.length};
  }catch(error){await client.query('ROLLBACK');throw error;}
 }finally {if(client)await client.end();await admin.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.env.CLE_SHARED_DATABASE==='true')throw new Error('First installation requires operator credentials, never shared runtime credentials');
 const databaseUrl=process.env.DATABASE_URL,adminDatabase=process.env.LANGUAGE_ENGINE_ADMIN_DATABASE;
 if(!databaseUrl||!adminDatabase)throw new Error('Explicit DATABASE_URL and LANGUAGE_ENGINE_ADMIN_DATABASE are required');
 const data=process.env.CLE_DEPLOY_DATA_DIR?pathToFileURL(resolve(process.env.CLE_DEPLOY_DATA_DIR)+'/'):undefined;
 console.log(JSON.stringify(await installEmpty({databaseUrl,adminDatabase,data})));
}
