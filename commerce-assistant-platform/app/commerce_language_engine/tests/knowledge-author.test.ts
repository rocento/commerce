import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {editAliases,type KnowledgeEdit} from '../scripts/knowledge-author.ts';
const base=buildExpandedDictionary();base.languageKnowledge=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-release-v10.json',import.meta.url),'utf8'));
function change():KnowledgeEdit{return {schemaVersion:1,expectedPackSha256:withDictionaryRecognition(base,()=>knowledgeHash(canonicalKnowledge(base.languageKnowledge))),nextRevision:11,actor:'test-author',reason:'Reviewed alias replacement',source:'first-party fixture',reviewer:'test-reviewer',reviewMethod:'ai_assisted',reviewedAt:'2026-10-10T00:00:00Z',edits:[{conceptId:'person.teacher',add:['schoolteacher'],remove:['tutor']}]};}
test('preview edits a copy, refreshes review hashes, and keeps original immutable',()=>{
 const before=JSON.stringify(base);const result=editAliases(base,change());assert.equal(JSON.stringify(base),before);
 const c=result.pack.concepts.find(c=>c.id==='person.teacher')!;assert.ok(c.aliases.includes('schoolteacher'));assert.ok(!c.aliases.includes('tutor'));assert.deepEqual(result.diff.concepts.changed,['person.teacher']);assert.equal(result.pack.revision,11);
});
test('stale hashes and incorrect revisions fail closed',()=>{assert.throws(()=>editAliases(base,{...change(),expectedPackSha256:'0'.repeat(64)}),/changed/);assert.throws(()=>editAliases(base,{...change(),nextRevision:12}),/increment/);});
test('typos, duplicate edits and missing review identity never silently change a draft',()=>{
 for(const edits of [[{conceptId:'missing',add:['new alias']}],[{conceptId:'person.teacher',remove:['missing']}],[{conceptId:'person.teacher',add:['teacher']}],[...change().edits,...change().edits]])assert.throws(()=>editAliases(base,{...change(),edits}));
 assert.throws(()=>editAliases(base,{...change(),reviewer:''}),/Invalid/);
});
test('undeclared cross-concept collisions remain rejected by the pack validator',()=>{
 assert.throws(()=>editAliases(base,{...change(),edits:[{conceptId:'person.teacher',add:['mother']}]}),/ambig|collision|meaning/i);
});
test('unknown edit fields cannot silently turn a requested operation into another one',()=>{
 assert.throws(()=>editAliases(base,{...change(),publish:true} as KnowledgeEdit),/Invalid/);
 assert.throws(()=>editAliases(base,{...change(),edits:[{...change().edits[0],canonical:'changed'}]} as unknown as KnowledgeEdit),/Invalid/);
});
