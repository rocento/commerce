import {readDeploymentRelease} from './deployment-release.ts';

// A filesystem artifact has no authoritative release UUID. Re-exporting must
// preserve an existing database-produced bundle instead of inventing provenance.
const {compiled,release}=await readDeploymentRelease();
if(!release||release.payload.format!==2)throw new Error('A versioned database release bundle is required. Stage an immutable candidate, then run export:db-release -- --release-id <uuid>.');
console.log(JSON.stringify({releaseId:release.payload.identity.releaseId,fingerprint:compiled.generationFingerprint,corpusCases:release.payload.corpus.length,status:'verified',bundle:'unchanged'}));
