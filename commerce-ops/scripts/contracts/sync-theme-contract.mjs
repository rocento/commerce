import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../../commerce-api/theme-contract.json', import.meta.url);
const target = new URL('../../commerce-web/packages/api-client/src/theme-contract.json', import.meta.url);
const content = readFileSync(source, 'utf8');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content) throw new Error('Run node scripts/sync-theme-contract.mjs');
} else writeFileSync(target, content);
