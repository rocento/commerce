import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile('dist/publication-build.json', JSON.stringify({ schema_version: 1, template: await digest('dist/public.html'), server: await digest('dist-server/entry-public-server.js') }) + '\n');
