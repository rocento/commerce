import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
for(const [name,c] of [['generated',compile(buildExpandedDictionary())],['packaged',await loadRuntime()]] as const){
 test(`${name}: bestseller periods remain explicit`,()=>{
  for(const period of ['today','last week','last month','last year']){
   for(const message of [`what best seller items ${period} ?`,`best seller ${period}`,`show me best selling products ${period}`]){
    const r=resolve(c,message);assert.equal(r.status,'RESOLVED',message);assert.equal(r.intent,'PRODUCT_RECOMMEND');assert.equal(r.entities.salesPeriod,period.replace(' ','_'));
   }
  }
  for(const message of ['Recommend best-selling products','show me best sellers','pls recommend bestselling items']){
   const r=resolve(c,message);assert.equal(r.status,'RESOLVED');assert.equal(r.entities.salesPeriod,'last_month');assert.equal(r.entities.productText,'*');
  }
  const general=resolve(c,'Recommend a product for today');assert.equal(general.status,'RESOLVED');assert.equal(general.entities.productText,'*');assert.equal(general.entities.salesPeriod,undefined);
 });
 test(`${name}: ranking cannot discard constraints or execute a compound action`,()=>{
  for(const message of ['do not show best sellers today','best sellers today under $10','best sellers today and add them to cart','best seller last 7 days','"best sellers today"'])assert.equal(resolve(c,message).entities.salesPeriod,undefined,message);
 });
}
