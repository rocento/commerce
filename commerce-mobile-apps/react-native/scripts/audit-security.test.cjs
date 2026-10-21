const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewAudit } = require('./audit-policy.cjs');
const known = { name: 'braces', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm' };
const audit = vulnerabilities => ({ vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } });
test('audit permits only explicitly mitigated advisory chains', () => {
  assert.deepEqual(reviewAudit(audit({ metro: { via: ['braces'] }, braces: { via: [known] } })), [known.url]);
  assert.deepEqual(reviewAudit(audit({})), []);
  assert.deepEqual(reviewAudit(audit({ metro: { via: ['transformer'] }, transformer: { via: ['metro', 'braces'] }, braces: { via: [known] } })), [known.url]);
  assert.throws(() => reviewAudit(audit({ braces: { via: [{ ...known, url: 'https://github.com/advisories/NEW' }] } })), /Unmitigated/);
  assert.throws(() => reviewAudit(audit({ braces: { via: [{ ...known, name: 'different-package' }] } })), /Unmitigated/);
});
test('audit rejects incomplete results and unanchored advisory cycles', () => {
  assert.throws(() => reviewAudit({ error: 'registry unavailable' }), /Incomplete/);
  assert.throws(() => reviewAudit(audit({ metro: { via: ['missing'] } })), /Unresolved/);
  assert.throws(() => reviewAudit(audit({ metro: { via: ['metro'] } })), /Unresolved/);
  assert.throws(() => reviewAudit(audit({ braces: { via: [{}] } })), /Unmitigated/);
  assert.throws(() => reviewAudit({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 1 } } }), /Inconsistent/);
});
