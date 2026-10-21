// Temporary fixes for GHSA-vfj7-8cjw-p6xm and GHSA-86w9-cpqp-85rv.
// Exact source hashes make upgrades fail closed until these patches are reviewed.
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const patches = require('./dependency-patches.json');
const hash = value => createHash('sha256').update(value).digest('hex');

const writes = patches.map(patch => {
  const path = resolve(__dirname, '../node_modules', patch.path);
  const current = readFileSync(path, 'utf8');
  if (hash(current) === patch.after) return null;
  if (hash(current) !== patch.before) throw new Error(`Review dependency patch drift: ${patch.path}`);
  const next = current.split(patch.old).join(patch.replacement);
  if (hash(next) !== patch.after) throw new Error(`Invalid dependency patch: ${patch.path}`);
  return { path, next };
});
for (const write of writes) if (write) writeFileSync(write.path, write.next);
console.log('Dependency security patches verified');
