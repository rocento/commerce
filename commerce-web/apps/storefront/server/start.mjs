import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicationServer } from './publication.mjs';
const artifacts = resolve(process.env.PUBLICATION_ARTIFACT_DIR || 'dist');
const entry = resolve(process.env.PUBLICATION_SSR_ENTRY || 'dist-server/entry-public-server.js');
const template = await readFile(resolve(artifacts, 'public.html'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(artifacts, 'publication-build.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
if (manifest.schema_version !== 1 || manifest.template !== hash(template) || manifest.server !== hash(await readFile(entry))) throw new Error('Mismatched publication artifacts; rebuild both entries');
const { render } = await import(pathToFileURL(entry).href);
const server = createPublicationServer({ origin: process.env.PUBLICATION_APPROVED_ORIGIN, installationId: process.env.PUBLICATION_INSTALLATION_ID,
  maxConcurrent: Number(process.env.PUBLICATION_MAX_INFLIGHT || 32),
  observationToken: process.env.PUBLICATION_OBSERVATION_TOKEN,
  gateway: process.env.PUBLICATION_GATEWAY || 'http://127.0.0.1:8080/', template, render, assetDirectory: artifacts });
server.listen(Number(process.env.PUBLICATION_PORT || 8081), process.env.PUBLICATION_BIND || '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
