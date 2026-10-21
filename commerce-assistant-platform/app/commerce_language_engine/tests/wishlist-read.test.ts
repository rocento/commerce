import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';

for(const [name,compiled] of [
 ['generated vocabulary',compile(buildExpandedDictionary())],
 ['packaged runtime',await loadRuntime()],
] as const){
 test(`${name}: wishlist listing verbs reach the same read intent`,()=>{
  for(const text of ['my wishlists','wishlists','my wish lists','wish lists','my wish list','show my wishlists','view my wishlists','open my wish lists','list out my wishlists','show a list of my wishlists','please show my wishlists','My Wishlists!','list my wishlist','view my wishlist','show my wishlist','open my wishlist','list my favorites','please list my wishlist','list out my wishlist','show a list of my wishlist']){
   const result=resolve(compiled,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'VIEW_WISHLIST',text);
   assert.equal(result.requiresConfirmation,false,text);
  }
 });
 test(`${name}: negated listing does not request a wishlist read`,()=>{
  for(const text of ['do not list my wishlist','never list my favorites','do not show my wishlists','never list my wish lists','remove apples from my wishlists','clear my wishlists','show my wishlists and clear my cart']){
   assert.notEqual(resolve(compiled,text).intent,'VIEW_WISHLIST',text);
  }
 });
}
