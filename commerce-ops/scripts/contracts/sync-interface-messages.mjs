import { readFile, writeFile } from 'node:fs/promises';

// Publish the checked-in source catalog, never merchant admin drafts.
const source = new URL('../../commerce-api/interface-messages.json', import.meta.url);
const target = new URL('../../commerce-web/apps/storefront/src/interface-messages.json', import.meta.url);
const text = await readFile(source, 'utf8');
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== text) throw new Error('Run node scripts/sync-interface-messages.mjs');
} else {
  await writeFile(target, text);
}
