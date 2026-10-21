import {structureCases} from '../src/generation/structure-cases.ts';
import assert from 'node:assert/strict';
import {acceptance} from '../tests/acceptance-corpus.ts';
import {conversationalCases} from '../src/generation/conversation-cases.ts';
import {writeFile} from 'node:fs/promises';
import {loadDictionary,withDb} from '../src/database.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {normalize} from '../src/normalize.ts';
import {gunzipSync} from 'node:zlib';
const seed=compile(buildExpandedDictionary()),db=compile(await loadDictionary());
const roundTripCases=[...seed.dictionary.corpus,...acceptance,...conversationalCases,...structureCases()];
assert.equal(db.dictionary.intents.reduce((n,i)=>n+(i.alternativeRules?.length??0),0),seed.dictionary.intents.reduce((n,i)=>n+(i.alternativeRules?.length??0),0));
for(const test of roundTripCases){const a=resolve(seed,test.text,test.context),b=resolve(db,test.text,test.context);assert.equal(b.intent,a.intent);assert.equal(b.status,a.status);assert.deepEqual(b.entities,a.entities);}
assert.deepEqual(db.dictionary.actionFrames,seed.dictionary.actionFrames);
assert.deepEqual(db.dictionary.requestPrefixes,seed.dictionary.requestPrefixes);
const tables=['lexicon.request_prefixes','lexicon.terms','action.frames','intent.definitions','intent.families','semantic.groups','semantic.terms','intent.rules','intent.rule_conditions','entity.types','entity.terms','entity.aliases','semantic.operators','lexicon.phrase_patterns','context.states','intent.transition_rules','intent.conflicts','industry.packs','utterance.generated','evaluation.results','utterance.generation_runs'];
const counts=await withDb(async c=>{const result:Record<string,number>={};for(const t of tables)result[t]=Number((await c.query(`SELECT count(*) FROM ${t}`)).rows[0].count);return result;});await writeFile('data/database-counts.json',JSON.stringify(counts,null,2));
const projection=await withDb(async c=>({
 semantic:(await c.query('SELECT g.code,l.normalized_term FROM semantic.terms s JOIN semantic.groups g ON g.id=s.semantic_group_id JOIN lexicon.terms l ON l.id=s.lexicon_term_id ORDER BY g.code,l.normalized_term')).rows,
 entities:(await c.query("SELECT t.code AS type,l.normalized_term AS alias,v.canonical_value AS value,coalesce(p.code,'CORE') AS industry FROM entity.aliases a JOIN entity.terms v ON v.id=a.entity_value_id JOIN entity.types t ON t.id=v.entity_type_id JOIN lexicon.terms l ON l.id=a.lexicon_term_id LEFT JOIN industry.packs p ON p.id=coalesce(a.industry_id,v.industry_id) ORDER BY t.code,l.normalized_term,v.canonical_value,p.code NULLS FIRST")).rows
}));
const sorted=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
assert.deepEqual(sorted(projection.semantic),sorted(db.dictionary.groups.flatMap(g=>[...new Set(g.terms.map(normalize))].map(term=>({code:g.code,normalized_term:term})))));
assert.deepEqual(sorted(projection.entities),sorted(db.dictionary.entity_terms.map(a=>({type:a.type,alias:normalize(a.alias),value:a.value,industry:a.industry}))));
const release=await withDb(async c=>(await c.query("SELECT d.id,d.dictionary_version,d.artifact->'intents' AS intents,d.corpus_gzip,d.manifest FROM release.channels ch JOIN release.dictionaries d ON d.id=ch.release_id WHERE ch.channel='production'")).rows[0]);
assert.ok(release);assert.equal(release.dictionary_version,db.dictionary.version);assert.equal(release.intents.length,db.dictionary.intents.length);assert.ok(release.corpus_gzip.length>0);
const archivedCases=gunzipSync(release.corpus_gzip).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
assert.equal(archivedCases.length,Number(release.manifest.corpusCases));assert.ok(archivedCases.every((row:{text:string})=>typeof row.text==='string'));
const base=process.env.API_URL??'http://127.0.0.1:3177';
const request=async(value:unknown)=>fetch(base+'/api/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
const a=await request({text:'find shoes'});assert.equal(a.status,200);const ar=await a.json();assert.equal(ar.intent,'PRODUCT_SEARCH');
const b=await request({text:'the second one',context:ar.context.next});const br=await b.json();assert.equal(br.intent,'SELECT_PRODUCT');
const cr=await(await request({text:'add two',context:br.context.next})).json();assert.equal(cr.intent,'ADD_TO_CART');assert.equal(cr.entities.quantity,2);
assert.equal((await(await request({text:'show delivery slots'})).json()).intent,'VIEW_DELIVERY_SLOTS');
const structured=await(await request({text:'pls i need add any two fresh items in cart'})).json();
assert.equal(structured.status,'NEEDS_CONTEXT');assert.equal(structured.intent,'ADD_TO_CART');assert.equal(structured.entities.quantity,2);assert.equal(structured.entities.selection,'ANY_MATCHING');assert.equal(structured.entities.freshness,'fresh');
const health=await(await fetch(base+'/api/health')).json();
assert.equal(health.intents,seed.dictionary.intents.length);assert.equal(health.dictionaryVersion,seed.dictionary.version);
for(const value of [null,{}, {text:42},{text:'x'.repeat(4001)},{text:'hello',context:{states:['INVALID']}}])assert.equal((await request(value)).status,400);
assert.equal((await fetch(base+'/api/resolve',{method:'POST',body:'{'})).status,400);
assert.equal((await fetch(base+'/api/resolve',{method:'POST',body:'x'.repeat(33000)})).status,413);
assert.equal((await fetch(base+'/missing')).status,404);
console.log(roundTripCases.length+' database round-trip cases, API session, validation, body limits and 404 checks passed.');console.log(counts);
