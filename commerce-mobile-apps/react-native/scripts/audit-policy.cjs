// Every reported dependency must reach a specifically reviewed advisory. npm's
// transitive dependency graph may contain cycles; a cycle alone is not evidence.
const mitigations = new Map([
  ['https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', 'braces'],
  ['https://github.com/advisories/GHSA-86w9-cpqp-85rv', 'node-forge'],
]);
function reviewAudit(audit) {
  if (audit.error || !audit.vulnerabilities || !audit.metadata?.vulnerabilities) throw new Error('Incomplete npm audit response');
  const advisories = new Set();
  const anchors = new Set();
  const dependencies = new Map();
  for (const [name, entry] of Object.entries(audit.vulnerabilities)) {
    if (!entry || !Array.isArray(entry.via) || entry.via.length === 0) throw new Error(`Unresolved advisory chain: ${name}`);
    const references = [];
    for (const via of entry.via) {
      if (typeof via === 'string') references.push(via);
      else {
        if (!via || !mitigations.has(via.url) || mitigations.get(via.url) !== via.name) throw new Error(`Unmitigated dependency advisory: ${via?.url}`);
        advisories.add(via.url);
        anchors.add(name);
      }
    }
    dependencies.set(name, references);
  }
  for (const [name, references] of dependencies) {
    if (references.some(reference => !dependencies.has(reference))) throw new Error(`Unresolved advisory chain: ${name}`);
  }
  for (const name of dependencies.keys()) {
    const pending = [name];
    const visited = new Set();
    let mitigated = false;
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      if (anchors.has(current)) mitigated = true;
      pending.push(...dependencies.get(current));
    }
    if (!mitigated) throw new Error(`Unresolved advisory chain: ${name}`);
  }
  if (audit.metadata.vulnerabilities.total !== dependencies.size) throw new Error('Inconsistent npm audit totals');
  return [...advisories];
}
module.exports = { reviewAudit };
