// Local read-only resolver bridge. Each JSONL record is a separate conversation.
import {createInterface} from 'node:readline';
import {createReadStream} from 'node:fs';
import {once} from 'node:events';
import {loadRuntime} from '../../commerce-assistant-platform/app/commerce_language_engine/src/runtime.ts';
import {resolve} from '../../commerce-assistant-platform/app/commerce_language_engine/src/engine.ts';

const compiled = await loadRuntime();
const lines = createInterface({input: createReadStream(process.argv[2]), crlfDelay: Infinity});
let count = 0;
const shard=Number(process.argv[3]??0), shards=Number(process.argv[4]??1);
let rowIndex=0;
for await (const line of lines) {
  if(rowIndex++ % shards!==shard)continue;
  const example = JSON.parse(line);
  let context = {referenceDate: '2026-09-23', timezone: 'Africa/Cairo'};
  const turns = [];
  for (const text of example.messages) {
    const start = performance.now();
    const result = resolve(compiled, text, context);
    const elapsedMs = performance.now() - start;
    context = result.context.next;
    const {debug, alternatives, matchedSemanticGroups, evidence, negativeEvidence,
      context: ignoredContext, graph, relationships, clauses, actions, references,
      slots, ...compact} = result;
    turns.push({result: compact, elapsed_ms: elapsedMs});
  }
  if (!process.stdout.write(JSON.stringify({id: example.id, turns}) + '\n')) {
    await once(process.stdout, 'drain');
  }
  if (++count % 5000 === 0) process.stderr.write(`Worker ${shard+1}/${shards}: resolved ${count} conversations\n`);
}
