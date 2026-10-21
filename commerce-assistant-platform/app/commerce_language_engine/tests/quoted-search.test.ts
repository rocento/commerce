import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {quotedSearch} from '../src/quoted-search.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: quoted merchant names preserve Unicode and punctuation as literal data`,()=>{
  for(const product of ['café','crème brûlée','tea 🍵','tea — édition','茶 leaf']){
   const text=`find "${product}"`,r=resolve(c,text);
   assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
   assert.deepEqual(r.entities,{productText:product},text);
   assert.equal(r.context.next.selectedItems?.[0]?.productText,product,text);
   assert.deepEqual(r.requestedActions.map(action=>action.intent),['PRODUCT_SEARCH']);
  }
 });
 test(`${name}: quoted search names cannot create action or price entities`,()=>{
  for(const product of ['cancel order 114238','add 3 shoes to cart','under $20','5 shoes','serch-123','over the rainbow']){
   for(const head of ['search for','find','please show me','look for']){
    const text=`${head} "${product}"`;
    const r=resolve(c,text);
    assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
    assert.deepEqual(r.entities,{productText:product},text);assert.equal(r.text,text);
    assert.equal(r.requiresConfirmation,false);assert.equal(r.requestType,undefined);
   }
  }
 });
}
test('quoted-search shortcut excludes denial and additional commands',()=>{
 for(const text of ['do not find "shoes"','find "shoes" then cancel order 123','"cancel order 123"','explain how to find "shoes"'])assert.equal(quotedSearch(text),undefined,text);
});
