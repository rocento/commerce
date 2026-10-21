import {writeFile,mkdir} from 'node:fs/promises';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {entityTypes,industries} from '../src/knowledge.ts';
import {commerceReadFragments} from '../src/commerce-fragments.ts';
const c=await loadRuntime();
const out=new URL('../../../../artifacts/language-fragments/',import.meta.url);await mkdir(out,{recursive:true});
const policies:Record<string,string>={
 PRODUCT:'Require an explicit search or selected product for unknown product names.',CATEGORY:'Exact dictionary aliases may start a read-only search; retain ambiguous interpretations.',
 BRAND:'Require product/search context; do not rewrite brand names.',COLOR:'Require a product/search constraint context.',SIZE:'Require a product and preserve units and model identifiers.',MATERIAL:'Require a product/search constraint context.',
 PRICE:'Selected-product price read; numeric bounds require a search context.',CURRENCY:'Attach only to a monetary request; never infer currency conversion or purchase.',QUANTITY:'Require an explicit action and product; existing invalid-quantity guards apply.',
 DATE:'Require order, delivery, or search context.',TIME:'Require an explicit delivery/store-hours context.',DELIVERY_DATE:'Require checkout/delivery context; do not book from a bare date.',DELIVERY_SLOT:'Require a verified delivery-slot selection; do not invent availability.',
 LOCATION:'Require delivery/store context; do not treat an arbitrary place as a command.',ADDRESS_REFERENCE:'Saved-address fragments list addresses; adding or changing requires explicit action.',STORE:'Known store-hours fragments are reads; a store name alone needs context.',
 ORDER_REFERENCE:'First/oldest/earliest order fragments use customer-scoped reads; explicit order numbers retain existing precedence.',PRODUCT_REFERENCE:'Selected-product read follow-ups use verified UI selection; other references require context.',ORDINAL:'Require a typed collection; bare first/second does not authorize a write.',PROMOTION_CODE:'Require explicit coupon action; preserve the code literally.',
};
for(const type of entityTypes)if(!policies[type])throw new Error('Missing policy for '+type);
const results:object[]=[];let failures=0,searches=0,ambiguous=0;
const aliases=new Map<string,{values:Set<string>;industries:Set<string>}>();
for(const e of c.dictionary.entity_terms.filter(e=>e.type==='CATEGORY')){const item=aliases.get(e.alias)??{values:new Set(),industries:new Set()};item.values.add(e.value);item.industries.add(e.industry??'CORE');aliases.set(e.alias,item);}
for(const [alias,item] of aliases){
 if(item.values.size!==1||!/^[a-zA-Z][a-zA-Z\s-]*$/.test(alias))continue;
 if(commerceReadFragments().some(e=>(e.aliases as readonly string[]).includes(alias)))continue;
 const explicit=resolve(c,'find '+alias);
 for(const prefix of ['','please ','pls '])for(const suffix of ['',' /','?','...']){
  const text=prefix+alias+suffix,r=resolve(c,text);
  const pass=explicit.status==='RESOLVED'?r.status==='RESOLVED'&&r.intent==='PRODUCT_SEARCH'&&r.entities.productText===alias:r.status!=='RESOLVED';
  if(!pass)failures++;
  if(r.status==='RESOLVED')searches++;else ambiguous++;
  results.push({text,industries:[...item.industries],status:r.status,intent:r.intent,pass});
 }
}
const report={entityTypes:entityTypes.length,policies,industries,categories:aliases.size,cases:results.length,searches,retainedUnresolved:ambiguous,failures,provenance:'Synthetic combinations of existing generic dictionary aliases. Not real customer transcripts.',limits:['Policies describe which fragments are admitted and which still require context; they do not claim universal entity resolution.','No new backend capabilities or product facts.','No production database change.']};
await writeFile(new URL('cases.jsonl',out),results.map(r=>JSON.stringify(r)).join('\n')+'\n');await writeFile(new URL('report.json',out),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({cases:results.length,searches,retainedUnresolved:ambiguous,failures}));if(failures)process.exitCode=1;
