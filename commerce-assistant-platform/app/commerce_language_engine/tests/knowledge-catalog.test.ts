import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchKnowledge,diffKnowledge,readOperatorSnapshot,runKnowledgeCatalog} from '../scripts/knowledge-catalog.ts';
import type {LanguageKnowledgePack} from '../src/language-knowledge.ts';
const pack:LanguageKnowledgePack={schemaVersion:1,id:'operator-test',revision:1,language:'en',source:'test',concepts:[{id:'activity.study',kind:'activity',canonical:'studying',aliases:['homework'],metadata:{domains:['commerce']}}],rules:[{id:'activity.for',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:80}]};
test('catalog searches aliases with bounded pages and exposes scoped rule provenance',()=>{
 const result=searchKnowledge(pack,'HOMEWORK','activity',1);assert.equal(result.total,1);assert.equal(result.rows[0].applicableRules[0].id,'activity.for');assert.deepEqual(searchKnowledge(pack,'','color').rows,[]);assert.deepEqual(searchKnowledge(pack,'',undefined,1,1).rows,[]);
 assert.throws(()=>searchKnowledge(pack,'x'.repeat(201)),/query/);assert.throws(()=>searchKnowledge(pack,'','unknown'),/kind/);assert.throws(()=>searchKnowledge(pack,'',undefined,101),/bounds/);
});
test('diff detects removed concepts, amended forms and rule changes',()=>{
 const next=structuredClone(pack);next.revision=2;next.concepts[0].aliases.push('school work');
 let result=diffKnowledge(pack,next);assert.deepEqual(result.concepts.changed,['activity.study']);assert.equal(result.forms.after-result.forms.before,1);
 next.concepts=[];assert.deepEqual(diffKnowledge(pack,next).concepts.removed,['activity.study']);
 next.rules[0].priority=81;assert.deepEqual(diffKnowledge(pack,next).rules.changed,['relationship:activity.for']);
 assert.throws(()=>diffKnowledge(pack,{...next,id:'another'}),/different/);
});
test('operator snapshot is transactionally read-only, parameterized and always rolled back',async()=>{
 const calls:{sql:string;parameters?:unknown[]}[]=[];
 const client={query:async(sql:string,parameters?:unknown[])=>{calls.push({sql,parameters});return {rows:sql.startsWith('SELECT id')?[{id:'fdd045f2-9dd6-41d0-8221-d0ebf88830b2',artifact:{},fingerprint:'test'}]:[]};}} as any;
 await readOperatorSnapshot(client,'fdd045f2-9dd6-41d0-8221-d0ebf88830b2');assert.match(calls[0].sql,/READ ONLY/);assert.deepEqual(calls[2].parameters,['fdd045f2-9dd6-41d0-8221-d0ebf88830b2']);assert.equal(calls.at(-1)!.sql,'ROLLBACK');
 calls.length=0;await assert.rejects(readOperatorSnapshot(client,"' OR true --"),/UUID/);assert.equal(calls.length,0);
 const failing={query:async(sql:string)=>{calls.push({sql});if(sql.startsWith('SELECT'))throw new Error('read failed');return {rows:[]};}} as any;
 await assert.rejects(readOperatorSnapshot(failing,undefined,5),/read failed/);assert.equal(calls.at(-1)!.sql,'ROLLBACK');
});
test('CLI rejects ambiguous source and mutation-like commands before I/O',async()=>{
 await assert.rejects(runKnowledgeCatalog(['activate']),/Use/);
 await assert.rejects(runKnowledgeCatalog(['search','--dictionary','x','--release-id','y']),/exactly one/);
 await assert.rejects(runKnowledgeCatalog(['imports','--pack','x']),/only/);
 await assert.rejects(runKnowledgeCatalog(['search','--dictionary','x','--limit=-1']),/integer/);
});
