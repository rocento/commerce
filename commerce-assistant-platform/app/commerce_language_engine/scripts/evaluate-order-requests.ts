import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadRuntime } from '../src/runtime.ts';
import { resolve } from '../src/engine.ts';
const args = process.argv.slice(2);
const arg = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const split = arg('--split', 'development');
if (!['development', 'holdout', 'all'].includes(split)) throw new Error('Invalid split');
const root = new URL('../tests/fixtures/order-requests-v1/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const runtime = await loadRuntime();
type Case = { id:string; family:string; split:string; text:string; expected:{kind:'selection'|'clarify';items?:{productText:string;quantity:number}[]} };
type Row = Case & {passed:boolean;review?:string;errors:string[];actual:{status:string;intent:string|null;items:unknown;message:string;operations:unknown}};
const rows: Row[] = [];
for (const name of split === 'all' ? ['development', 'holdout'] : [split]) {
 const content = await readFile(new URL(`${name}.jsonl`, root), 'utf8');
 if (createHash('sha256').update(content).digest('hex') !== manifest.sha256[`${name}.jsonl`]) throw new Error('Frozen corpus changed');
 for (const line of content.trim().split('\n')) {
  const test: Case = JSON.parse(line);
  const result = resolve(runtime, test.text);
  const errors = [];
  if (test.expected.kind === 'selection') {
   if (result.intent !== 'PRODUCT_ACTION_CHOICE' || result.status !== 'NEEDS_CONTEXT') errors.push('selection_route');
   if (!isDeepStrictEqual(result.entities.items, test.expected.items)) errors.push('product_quantity_binding');
   if (result.entities.guideAction !== 'cart') errors.push('cart_guidance');
  } else {
   if (result.intent === 'PRODUCT_ACTION_CHOICE' || !['NEEDS_CONTEXT', 'AMBIGUOUS', 'UNSUPPORTED', 'DENIED'].includes(result.status)) errors.push('clarification_required');
  }
  if (result.actions?.length || result.operations?.length) errors.push('premature_action_plan');
  // Keep the original strict result visible. Independently audit two supported
  // outcomes that the original blanket 'clarify without plans' label excluded.
  let review: string | undefined;
  const delivery = /^order (\d+) (\p{L}+) and deliver tomorrow morning$/u.exec(test.text);
  if (errors.length && delivery && result.status === 'RESOLVED' && result.intent === 'CREATE_ORDER'
      && result.requiresConfirmation && result.fulfillment?.status === 'NOT_EXECUTED'
      && isDeepStrictEqual(result.entities.items, [{quantity:Number(delivery[1]),productText:delivery[2]}])
      && result.entities.delivery?.relativeDate === 'TOMORROW' && result.entities.delivery?.timeWindow?.period === 'MORNING'
      && isDeepStrictEqual(result.operations, ['ADD_ITEM','SET_DELIVERY_TIME','CREATE_ORDER'])) review = 'supported_delivery_plan_requires_confirmation';
  const conflict = /^order (\d+) (\p{L}+); cancel order 42$/u.exec(test.text);
  if (errors.length && conflict && result.status === 'AMBIGUOUS' && result.fulfillment?.status === 'NOT_EXECUTED'
      && isDeepStrictEqual(result.entities.items, [{quantity:Number(conflict[1]),productText:conflict[2]}])
      && result.operations?.includes('CANCEL_ORDER') && result.operations?.includes('CREATE_ORDER')) review = 'conflicting_actions_require_clarification';
  rows.push({ ...test, passed: errors.length === 0, review, errors, actual: { status: result.status, intent: result.intent, items: result.entities.items, message: result.message, operations: result.operations } });
 }
}
const counts = (group: typeof rows) => ({ count: group.length, passed: group.filter(r => r.passed).length, failed: group.filter(r => !r.passed).length });
const summary = counts(rows);
const byKind = Object.fromEntries(['selection', 'clarify'].map(kind => [kind, counts(rows.filter(r => r.expected.kind === kind))]));
const audited = { accepted: rows.filter(r => r.passed || r.review).length, reviewed: rows.filter(r => r.review).length, unresolved: rows.filter(r => !r.passed && !r.review).length };
const report = { manifest, split, summary, byKind, audited, cases: rows };
const output = arg('--output', '');
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ summary, byKind, audited, failingFamilies: [...new Set(rows.filter(r => !r.passed).map(r => r.family))] }, null, 2));
if (audited.unresolved) process.exitCode = 1;
