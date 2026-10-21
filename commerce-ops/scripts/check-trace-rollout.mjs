// Compatibility entry point for commerce-ops/scripts/checks/check-trace-rollout.mjs.
export * from './checks/check-trace-rollout.mjs';
import {main} from './checks/check-trace-rollout.mjs';
import {pathToFileURL} from 'node:url';
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
