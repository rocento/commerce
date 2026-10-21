// Intentionally no recognition-test-context import: operator commands start cold.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {languageValue} from '../src/recognition-rules.ts';
import {promoteRelease,bootstrapRelease,dictionaryContentFingerprint,type ReleaseClient} from '../src/release-lifecycle.ts';
const releaseId='fdd045f2-9dd6-41d0-8221-d0ebf88830b2';
function client():ReleaseClient {
 const dictionary=buildExpandedDictionary();
 dictionary.languageKnowledge=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-release-v10.json',import.meta.url),'utf8'));
 dictionary.generationFingerprint=dictionaryContentFingerprint(dictionary);
 return {query:async(sql:string)=>{
  if(sql.includes('FROM release.dictionaries d LEFT JOIN'))return {rows:[{id:releaseId,artifact:dictionary,dictionary_version:dictionary.version,fingerprint:dictionary.generationFingerprint,corpus_gzip:gzipSync(''),draft_id:releaseId}],rowCount:1};
  if(sql.includes('SELECT release_id FROM release.channels'))return {rows:[{release_id:releaseId}],rowCount:1};
  return {rows:[],rowCount:0};
 }} as unknown as ReleaseClient;
}
test('cold promotion validates governed knowledge in its candidate context before enforcing evidence',async()=>{
 assert.throws(()=>languageValue('cart-clear-language.clear.value.1'),/explicit dictionary rule context/);
 await assert.rejects(promoteRelease(client(),{releaseId,evaluationId:releaseId,expectedActiveReleaseId:null,runtimeSha256:'a'.repeat(64),rubricVersion:'commerce-language-release-v1',contractVersion:'2',actor:'test',reason:'cold operator regression'}),/Promotion requires passing evaluation/);
 assert.throws(()=>languageValue('cart-clear-language.clear.value.1'),/explicit dictionary rule context/);
});
test('cold bootstrap validates governed knowledge before enforcing the empty-database gate',async()=>{
 await assert.rejects(bootstrapRelease(client(),{releaseId,actor:'test',reason:'cold operator regression'}),/Bootstrap is only allowed on an empty/);
 assert.throws(()=>languageValue('cart-clear-language.clear.value.1'),/explicit dictionary rule context/);
});
