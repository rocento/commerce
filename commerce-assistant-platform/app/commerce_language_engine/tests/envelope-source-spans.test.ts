import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const dictionary=buildExpandedDictionary();
dictionary.languageKnowledge=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-release-v10.json',import.meta.url),'utf8'));
const engine=compile(dictionary);
for(const prefix of ['Please ','Kindly ','  Please '])test('source spans survive envelope '+JSON.stringify(prefix),()=>{
 const text=prefix+'find laptop for online classes under $75';
 const r=resolve(engine,text);
 assert.equal(r.status,'RESOLVED');
 const relations=r.entities.shoppingContext?.relations;
 assert.ok(relations?.length);
 for(const row of relations)assert.equal([...text].slice(row.start,row.end).join(''),row.text);
 assert.equal(r.entities.price?.value,75);
});
