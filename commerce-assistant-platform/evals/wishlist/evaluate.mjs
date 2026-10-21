import {readFileSync,writeFileSync} from 'node:fs';
import {loadRuntime} from '../../app/commerce_language_engine/src/runtime.ts';
import {resolve} from '../../app/commerce_language_engine/src/engine.ts';
const c=await loadRuntime();const data=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url)));
const normalize=s=>String(s??'').toLowerCase().replace(/^(?:the|a|an) /,'').trim();
const writes=new Set(['ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST','CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST','ADD_TO_CART','REMOVE_FROM_CART','CLEAR_CART','CREATE_ORDER']);
const results=data.cases.map(row=>{
 const r=resolve(c,row.text,row.context);const e=row.expected;let reasons=[];let classification='PASS';
 if(e.behavior==='intent'){
  if(r.intent!==e.intent||!['RESOLVED','NEEDS_CONTEXT'].includes(r.status))reasons.push('Expected '+e.intent);
  if(e.product&&normalize(r.entities.productText)!==normalize(e.product))reasons.push('Product not preserved');
  if(e.quantity&&r.entities.quantity!==e.quantity)reasons.push('Quantity not preserved');
  if(e.intent.startsWith('CART_MOVE_')){
   const source=e.intent==='CART_MOVE_FROM_WISHLIST'?'wishlist':'cart';
   if(r.entities.sourceCollection!==source||r.entities.destination==source)reasons.push('Transfer direction missing or wrong');
  }
 }else if(e.behavior==='no_mutation'){
  if(r.status==='RESOLVED'&&(writes.has(r.intent)||r.actions?.length))reasons.push('Instructional/negated text resolved as actionable');
 }else if(e.behavior==='clear_wishlist'){
  if(r.intent!=='REMOVE_FROM_WISHLIST'||!['all','all items','everything'].includes(normalize(r.entities.productText)))reasons.push('No wishlist-only bulk-removal guidance');
 }else if(e.behavior==='clarify'){
  if(!['NEEDS_CONTEXT','UNSUPPORTED'].includes(r.status))reasons.push('Expected explicit clarification or unsupported guidance');
 }
 if(reasons.length)classification=r.status==='RESOLVED'&&writes.has(r.intent)&&e.behavior==='no_mutation'?'UNSAFE':'GAP';
 return {...row,classification,reasons,actual:{status:r.status,intent:r.intent,entities:r.entities,message:r.message}};
});
const byFamily={};for(const r of results){const b=byFamily[r.family]??={total:0,passed:0,gaps:0,unsafe:0};b.total++;b[r.classification==='PASS'?'passed':r.classification==='UNSAFE'?'unsafe':'gaps']++;}
const report={total:results.length,passed:results.filter(r=>r.classification==='PASS').length,unsafe:results.filter(r=>r.classification==='UNSAFE').length,byFamily,limitations:'Synthetic parser evaluation. PASS does not mean a cart/wishlist mutation executed; selections, login, validation, confirmation and server receipts are tested separately.',results};
const output=process.argv[2]??new URL('./results.json',import.meta.url);writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,results:undefined},null,2));
