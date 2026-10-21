import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileKnowledge,canonicalKnowledge,knowledgeHash,parseLanguageKnowledge,knowledgeTokens,knowledgeTokenSpans,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
import {compile} from '../src/compiler.ts';
const base=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const pack:LanguageKnowledgePack={schemaVersion:1,id:'test-shopping',revision:1,language:'en',source:'Reviewed test fixtures',concepts:[
 {id:'activity.classes',kind:'activity',canonical:'online classes',aliases:['online lessons']},
 {id:'person.mother',kind:'person',canonical:'mother',aliases:['mom','mum'],metadata:{personRole:'recipient'}},
 {id:'color.red',kind:'color',canonical:'red',aliases:['bright red']},
],rules:[
 {id:'for-activity',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:80},
 {id:'for-recipient',marker:'for',targetKind:'person',relation:'recipient',scope:'product',priority:80,targetMetadata:{personRole:'recipient'}},
 {id:'color-modifier',marker:'modifier',targetKind:'color',relation:'color',scope:'product',priority:60},
]};
test('knowledge compiler indexes complete phrases without adding unscoped entity aliases',()=>{
 const index=compileKnowledge(pack);assert.equal(index.byFirstToken.get('online')?.[0]?.tokens.join(' '),'online classes');assert.equal(index.byFirstToken.get('mom')?.[0]?.concept.id,'person.mother');
 const result=projectKnowledge({...base,languageKnowledge:undefined},pack),compiled=compile(result.dictionary);
 assert.ok(compiled.languageKnowledge);assert.deepEqual(result.dictionary.entity_terms,base.entity_terms);assert.deepEqual(result.dictionary.groups,base.groups);assert.deepEqual(result.dictionary.intents,base.intents);
 assert.equal(compiled.languageKnowledge.byFirstToken.has('red'),true);
});
test('reordered concepts, aliases and rules have deterministic candidate content and digest',()=>{
 const shuffled={...pack,concepts:[...pack.concepts].reverse().map(c=>({...c,aliases:[...c.aliases].reverse()})),rules:[...pack.rules].reverse()};
 assert.equal(knowledgeHash(canonicalKnowledge(pack)),knowledgeHash(canonicalKnowledge(shuffled)));
 assert.deepEqual(projectKnowledge({...base,languageKnowledge:undefined},pack).dictionary,projectKnowledge({...base,languageKnowledge:undefined},shuffled).dictionary);
});
test('validation rejects unsupported fields, expressions, unreachable rules and collisions',()=>{
 assert.throws(()=>parseLanguageKnowledge({...pack,execute:'arbitrary code'}),/fields/);
 assert.throws(()=>parseLanguageKnowledge({...pack,rules:[]}),/bounds/);
 assert.throws(()=>parseLanguageKnowledge({...pack,rules:[{...pack.rules[0],marker:'for.*'}]}),/rule/);
 assert.throws(()=>parseLanguageKnowledge({...pack,rules:[{...pack.rules[0],targetKind:'country',relation:'origin_country'}]}),/Unreachable/);
 assert.throws(()=>parseLanguageKnowledge({...pack,rules:[...pack.rules,{...pack.rules[0],id:'conflicting'}]}),/Conflicting/);
 assert.throws(()=>parseLanguageKnowledge({...pack,concepts:[...pack.concepts,{id:'activity.duplicate',kind:'activity',canonical:'Online Classes',aliases:[]}]}),/same-kind/);
 assert.throws(()=>parseLanguageKnowledge({...pack,concepts:[...pack.concepts,{id:'person.duplicate',kind:'person',canonical:'red',aliases:[]}]}),/Unreviewed/);
});
test('reviewed cross-kind ambiguity preserves both senses in one index bucket',()=>{
 const ambiguity={...pack,concepts:[...pack.concepts.map(c=>c.id==='color.red'?{...c,metadata:{ambiguous:true}}:c),{id:'person.red',kind:'person' as const,canonical:'red',aliases:[],metadata:{ambiguous:true}}]};
 const matches=compileKnowledge(ambiguity).byFirstToken.get('red');assert.deepEqual(matches?.map(m=>m.concept.kind),['color','person']);
});
test('same revision cannot silently change data and older revisions cannot replace active knowledge',()=>{
 const dictionary=projectKnowledge({...base,languageKnowledge:undefined},pack).dictionary;
 assert.equal(projectKnowledge(dictionary,pack).unchanged,true);
 assert.throws(()=>projectKnowledge(dictionary,{...pack,source:'Changed'}),/new revision/);
 assert.throws(()=>projectKnowledge({...dictionary,languageKnowledge:{...pack,revision:2}},pack),/backwards/);
 assert.throws(()=>projectKnowledge(dictionary,{...pack,id:'unrelated'}),/consolidation/);
});

test('canonical punctuation uses the same tokens as source phrases without splitting possessives or in-word hyphens',()=>{
 const countries={...pack,concepts:[...pack.concepts,{id:'country.CD',kind:'country' as const,canonical:'Congo - Kinshasa',aliases:['Congo Kinshasa']}],rules:[...pack.rules,{id:'from-country',marker:'from',targetKind:'country' as const,relation:'origin_country' as const,scope:'product' as const,priority:80}]};
 const index=compileKnowledge(countries),matches=index.byFirstToken.get('congo')!;
 assert.equal(matches.length,1,'Punctuation aliases of the same concept share one token sequence');
 assert.deepEqual(matches[0].tokens,knowledgeTokens('Congo - Kinshasa'));assert.deepEqual(matches[0].tokens,['congo','kinshasa']);
 assert.deepEqual(knowledgeTokens("mother’s rose-gold necklace"),["mother's",'rose-gold','necklace']);
 const spans=knowledgeTokenSpans('Congo - Kinshasa');assert.equal('Congo - Kinshasa'.slice(spans[1].start,spans[1].end),'Kinshasa');
 assert.throws(()=>compileKnowledge({...countries,concepts:[...countries.concepts,{id:'country.duplicate',kind:'country',canonical:'Congo Kinshasa',aliases:[]}]}),/same-kind/);
});
