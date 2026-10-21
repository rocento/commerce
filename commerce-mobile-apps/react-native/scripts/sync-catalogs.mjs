// These are local preview catalogs shared with the Swift and Kotlin apps.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const destination = new URL('../src/core/data/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const number of [1, 2]) {
  const name = `catalog-${number}.json`;
  const source = readFileSync(new URL(`../../shared/catalog/${name}`, import.meta.url), 'utf8');
  const target = new URL(name, destination);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== source) throw new Error(`Stale ${name}; run npm run catalog:sync`);
  } else {
    writeFileSync(target, source);
  }
}
console.log('Shared preview catalogs are synchronized.');

const acceptance = new URL('../src/testing/commerce-flow.json', import.meta.url);
const fixture = readFileSync(new URL('../../shared/testing/commerce-flow.json', import.meta.url), 'utf8');
if (process.argv.includes('--check')) {
  if (readFileSync(acceptance, 'utf8') !== fixture) throw new Error('Stale commerce fixture; run npm run catalog:sync');
} else {
  mkdirSync(new URL('../src/testing/', import.meta.url), { recursive: true });
  writeFileSync(acceptance, fixture);
}
