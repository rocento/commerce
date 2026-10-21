import {readDeploymentRelease} from './deployment-release.ts';

const {compiled,release}=await readDeploymentRelease();
const identity=release?.payload.format===2?release.payload.identity:undefined;
console.log(JSON.stringify({status:'pass',fingerprint:compiled.generationFingerprint,bundle:release?'validated':'absent',releaseId:identity?.releaseId,runtimeSha256:identity?.runtimeSha256}));
