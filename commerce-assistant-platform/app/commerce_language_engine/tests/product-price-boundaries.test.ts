import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: reviewed price boundaries and independent variations`,()=>{
  for(const [text,product,operator,value,currency] of [
   ['show me cat food up to $3674','cat food','<=',3674,'USD'],
   ['I need toilet paper costing more than $2721','toilet paper','>',2721,'USD'],
   ['I need swim goggles under USD 4835','swim goggles','<',4835,'USD'],
   ["I'm trying to find veltronic modules for less than $2299.",'veltronic modules','<',2299,'USD'],
   ['Could you find copper fasteners priced at most GBP 31.75?','copper fasteners','<=',31.75,'GBP'],
   ['show me linen napkins for no more than EUR 84','linen napkins','<=',84,'EUR'],
   ['I need notebooks costing at least EGP 250','notebooks','>=',250,'EGP'],
   ['find welding gloves up to USD 1,234.50','welding gloves','<=',1234.5,'USD'],
   ['find coffee over AED 40','coffee','>',40,'AED'],
  ] as const){
   const r=resolve(c,text);
   assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
   assert.equal(r.entities.productText,product,text);
   assert.deepEqual(r.entities.price,{operator,value,currency},text);assert.equal(r.text,text);
  }
 });
 test(`${name}: price words inside product identities remain intact`,()=>{
  for(const product of ['under armour shoes','over the rainbow mugs','above ground pools','up to date planner','more than words poster','under-200 cables']){
   const r=resolve(c,`find ${product}`);
   assert.equal(r.entities.productText,product,product);assert.equal(r.entities.price,undefined,product);
  }
 });
}
