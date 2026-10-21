#!/usr/bin/env bash
# Read-only metadata and readiness checks; run on the production host as root.
set -euo pipefail
cd /opt/rocento
for store in grocery jewelry electronics pharmacy; do
  bash deploy/ec2/server/ec2-compose.sh "$store" exec -T commerce-language-engine node --input-type=module - "$store" <<'NODE'
import {runtimeSha256} from './src/runtime-identity.ts';
import {readFileSync} from 'node:fs';
const compiled=JSON.parse(readFileSync('./data/compiled.json','utf8'));
const response=await fetch('http://127.0.0.1:3000/api/ready');
if(!response.ok)throw new Error('Readiness failed: '+response.status);
console.log(JSON.stringify({store:process.argv[2],component:'language',nodeVersion:process.version,runtimeSha256:await runtimeSha256(),artifactFingerprint:compiled.generationFingerprint,knowledgeRevision:compiled.languageKnowledge?.revision,ready:await response.json()}));
NODE
done
docker stats --no-stream --format '{{json .}}' $(docker ps --filter name=commerce-language-engine --filter name=ai-service --filter name=rocento-ai-shared --format '{{.ID}}')
