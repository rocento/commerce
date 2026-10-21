import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readDeploymentRelease} from './deployment-release.ts';
import {closeDb,migrate} from '../src/database.ts';
import {verifyDatabaseRuntime} from './shared-runtime.ts';

// Startup is read-only for both dedicated and shared databases. Publishing is an
// operator command, never a side effect of restarting an old container.
if(process.argv.includes('--migrate-only')){
 if(process.env.CLE_SHARED_DATABASE==='true')throw new Error('Shared runtime credentials cannot run migrations. Use the shared database operator.');
 if(!process.env.DATABASE_URL)throw new Error('Explicit DATABASE_URL is required for migrations.');
 try{await migrate();console.log('Language Engine database migrations complete; no release activated.');}finally{await closeDb();}
}else{
 const data=process.env.CLE_DEPLOY_DATA_DIR?pathToFileURL(resolve(process.env.CLE_DEPLOY_DATA_DIR)+'/'):undefined;
 const {compiled,release}=await readDeploymentRelease(data);
 if(release?.payload.format!==2)throw new Error('Startup requires a version 2 deployment bundle pinned to an immutable release UUID. Export the exact release before deployment.');
 const verified=await verifyDatabaseRuntime(compiled,{shared:process.env.CLE_SHARED_DATABASE==='true',releaseId:release.payload.identity.releaseId,allowLegacyBaselineTransition:process.env.CLE_ALLOW_LEGACY_BASELINE_TRANSITION==='true'});
 if(process.argv.includes('--verify-only')){await closeDb();console.log('Language Engine runtime release verified; database unchanged.');}
 else {process.env.CLE_RUNTIME_RELEASE_ID=verified.releaseId;await import('../src/server.ts');}
}
