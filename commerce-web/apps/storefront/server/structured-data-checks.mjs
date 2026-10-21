import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredDataScript } from './structured-data.mjs';
function fixture() {
 const origin='https://shop.example.test/',url=origin+'products/apples';
 const p={name:'تفاح </script><script>alert(1)</script>',description:'Fresh & crisp',price:'2.93',currency:'USD',offer_eligible:true};
 return {status:200,origin,site_name:'Merchant',canonical:{json_ld:url},product:p,family:[],related_canonicals:{},structured_data:{'@context':'https://schema.org','@graph':[{'@type':'Organization','@id':origin+'#merchant',name:'Merchant',url:origin},{'@type':'Product','@id':url+'#product',url,name:p.name,description:p.description,offers:{'@type':'Offer',price:p.price,priceCurrency:p.currency,url,seller:{'@id':origin+'#merchant'}}}]}};
}
test('JSON-LD survives hostile Unicode text without creating script elements',()=>{const s=fixture(),html=structuredDataScript(s);assert.equal(html.match(/<script/g).length,1);assert.equal(html.match(/<\/script>/g).length,1);const parsed=JSON.parse(html.split('type="application/ld+json">')[1].split('</script>')[0]);assert.deepEqual(parsed,s.structured_data);});
test('material price currency seller URL name and availability contradictions fail closed',()=>{
 for(const change of [p=>p.name='other',p=>p.url='https://other.example/',p=>p.offers.price='9.99',p=>p.offers.priceCurrency='EUR',p=>p.offers.seller['@id']='other',p=>p.offers.availability='https://schema.org/InStock']) {const s=fixture();change(s.structured_data['@graph'][1]);assert.throws(()=>structuredDataScript(s));}
 const s=fixture();s.product.offer_eligible=false;assert.throws(()=>structuredDataScript(s));
});
test('missing and error structured data do not create fictitious product claims',()=>{assert.equal(structuredDataScript({structured_data:null}),'');const s=fixture();s.status=404;assert.throws(()=>structuredDataScript(s));});
