import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {loadRuntime} from '../src/runtime.ts';
import {normalize} from '../src/normalize.ts';
import {resolve} from '../src/engine.ts';

const corpus = JSON.parse(readFileSync(new URL('../../../evals/wishlist-read/cases.json', import.meta.url), 'utf8')) as {cases: {id: string; text: string; family: string}[]};
const previous = JSON.parse(readFileSync(new URL('../../../evals/wishlist/cases.json', import.meta.url), 'utf8')) as {cases: {text: string}[]};
test('wishlist read corpus contains 1000 new normalized unique requests', () => {
  assert.equal(corpus.cases.length, 1000);
  const texts = corpus.cases.map(row => normalize(row.text));
  assert.equal(new Set(texts).size, 1000);
  const oldTexts = new Set(previous.cases.map(row => normalize(row.text)));
  assert.equal(texts.filter(text => oldTexts.has(text)).length, 0);
  assert.ok(texts.includes('where is my wishlist'));
});
for (const [name, runtime] of [
  ['generated', compile(buildExpandedDictionary())],
  ['packaged', await loadRuntime()],
] as const) {
  test(`${name}: all 1000 wishlist questions select one direct read`, () => {
    for (const row of corpus.cases) {
      const result = resolve(runtime, row.text);
      const label = `${row.id}: ${row.text}`;
      assert.equal(result.status, 'RESOLVED', label);
      assert.equal(result.intent, 'VIEW_WISHLIST', label);
      assert.equal(result.requiresConfirmation, false, label);
      assert.equal(result.intentCount, 1, label);
      assert.equal(result.intentCountStatus, 'EXACT', label);
      assert.deepEqual(result.requestedActionIssues, [], label);
      assert.deepEqual(result.requestedActions.map(action => action.intent), ['VIEW_WISHLIST'], label);
      assert.equal(result.entities.productText, undefined, label);
      assert.ok(!result.entities.items?.length && !result.actions?.length && !result.operations?.length, label);
    }
  });
}
