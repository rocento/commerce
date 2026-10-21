// npm reports versions, not our reviewed source patches. Keep its full report,
// reject every new advisory, and verify mitigated files have their exact hashes.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const patches = require('./dependency-patches.json');
const { reviewAudit } = require('./audit-policy.cjs');
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], { encoding: 'utf8' });
if (result.error || ![0, 1].includes(result.status)) throw result.error || new Error(result.stderr || 'npm audit failed');
const audit = JSON.parse(result.stdout);
const advisories = reviewAudit(audit);
for (const patch of patches) {
  const content = readFileSync(resolve(__dirname, '../node_modules', patch.path));
  if (createHash('sha256').update(content).digest('hex') !== patch.after) throw new Error(`Missing security patch: ${patch.path}`);
}
console.log(JSON.stringify({ upstreamAudit: audit.metadata.vulnerabilities, verifiedLocalMitigations: [...advisories] }, null, 2));
console.log(advisories.length
  ? 'All reported advisories have verified local source mitigations. Upstream audit is not clean.'
  : 'Upstream audit has no reported vulnerabilities; local patches verified.');
