import './recognition-test-context.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('frozen 1000-request corpus preserves selections and reviewed clarification/plan outcomes', () => {
 const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/evaluate-order-requests.ts', import.meta.url)), '--split', 'all'], {encoding:'utf8'});
 const report = JSON.parse(output);
 assert.equal(report.summary.count, 1000);
 assert.equal(report.byKind.selection.passed, 700);
 assert.equal(report.audited.unresolved, 0);
});
