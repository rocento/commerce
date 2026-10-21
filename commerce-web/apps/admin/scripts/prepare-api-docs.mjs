// Ship only the pinned viewer; the private contract is fetched from the gateway.
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = dirname(require.resolve('swagger-ui-dist/package.json'));
const output = resolve(root, 'public/api-reference/vendor');
for (const entry of await readdir(resolve(root, 'public'), { recursive: true })) {
  if (/openapi.*\.json$/i.test(entry)) throw new Error('Private API contracts must not be bundled in admin static assets.');
}
await mkdir(output, { recursive: true });
for (const name of ['swagger-ui-bundle.js', 'swagger-ui.css', 'swagger-ui-bundle.js.LICENSE.txt', 'LICENSE', 'NOTICE']) {
  await copyFile(resolve(vendor, name), resolve(output, name));
}
console.log('Prepared self-hosted merchant API viewer without a bundled specification.');
