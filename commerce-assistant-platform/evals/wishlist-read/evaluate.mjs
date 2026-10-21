import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {compile} from '../../app/commerce_language_engine/src/compiler.ts';
import {buildExpandedDictionary} from '../../app/commerce_language_engine/src/generation/dictionary.ts';
import {loadRuntime} from '../../app/commerce_language_engine/src/runtime.ts';
import {resolve} from '../../app/commerce_language_engine/src/engine.ts';

const corpusBytes = readFileSync(new URL('./cases.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const runtimes = [
  ['generated', compile(buildExpandedDictionary())],
  ['packaged', await loadRuntime()],
];
const runtimeReports = [];
for (const [name, runtime] of runtimes) {
  const byFamily = {};
  const failures = [];
  for (const row of corpus.cases) {
    const result = resolve(runtime, row.text, row.context ?? {});
    const reasons = [];
    if (result.status !== 'RESOLVED' || result.intent !== 'VIEW_WISHLIST') reasons.push('Expected resolved wishlist read');
    if (result.requiresConfirmation) reasons.push('Read requested confirmation');
    if (result.intentCount !== 1 || result.intentCountStatus !== 'EXACT') reasons.push('Read not fully consumed');
    if (result.requestedActions?.length !== 1 || result.requestedActions[0].intent !== 'VIEW_WISHLIST') reasons.push('Unexpected customer actions');
    if (result.entities.productText || result.entities.items?.length || result.actions?.length || result.operations?.length) reasons.push('Read acquired product/write semantics');
    const family = byFamily[row.family] ??= {total: 0, passed: 0};
    family.total++;
    if (!reasons.length) family.passed++;
    else failures.push({id: row.id, text: row.text, reasons, actual: {status: result.status, intent: result.intent, entities: result.entities}});
  }
  runtimeReports.push({name, dictionaryVersion: runtime.dictionary.version, dictionarySha256: createHash('sha256').update(JSON.stringify(runtime.dictionary)).digest('hex'), total: corpus.cases.length, passed: corpus.cases.length - failures.length, byFamily, failures});
}
const report = {
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  sourceSha256: Object.fromEntries(['engine.ts', 'wishlist-language.ts', 'wishlist-read-language.ts', 'saved-collection-language.ts'].map(name => [name, createHash('sha256').update(readFileSync(new URL(`../../app/commerce_language_engine/src/${name}`, import.meta.url))).digest('hex')])),
  nodeVersion: process.version,
  total: corpus.cases.length,
  runtimes: runtimeReports,
  limitations: 'Synthetic English phrase coverage. Direct SSE response tests use mocked authorized commerce APIs and reject any model call. Production deployment is not verified by this evaluation.',
};
writeFileSync(process.argv[2] ?? new URL('./results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (runtimeReports.some(report => report.passed !== report.total)) process.exitCode = 1;
