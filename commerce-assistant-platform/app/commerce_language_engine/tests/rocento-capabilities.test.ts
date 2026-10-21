import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {rocentoDictionary,rocentoIntentCodes} from '../src/rocento-capabilities.ts';
import {collectCorpus} from '../src/generation/corpus.ts';
const d=buildExpandedDictionary();
test('Rocento profile excludes unsupported operations and dependent definitions',()=>{
 assert.deepEqual(new Set(d.intents.map(i=>i.code)),rocentoIntentCodes);
 for(const code of ['CREATE_SUBSCRIPTION','PAUSE_SUBSCRIPTION','CANCEL_SUBSCRIPTION','SUBSCRIPTION_SKIP','REDEEM_POINTS','APPLY_GIFT_CARD','PAYMENT_CARD_ADD','CREATE_PREORDER','RETURN_START','QUOTE_REQUEST'])assert.ok(!d.intents.some(i=>i.code===code));
 for(const t of d.transitions)assert.ok(rocentoIntentCodes.has(t.intent)&&rocentoIntentCodes.has(t.previousIntent));
 for(const p of d.patterns)assert.ok(rocentoIntentCodes.has(p.intent));
 for(const pair of d.conflicts)assert.ok(pair.every(code=>rocentoIntentCodes.has(code)));
 for(const c of collectCorpus(d,10).cases)assert.ok(!c.intent||rocentoIntentCodes.has(c.intent));
 assert.deepEqual(rocentoDictionary(d),d);
});
test('stale dictionaries cannot restore unsupported actions at compilation',()=>{
 const c=compile(buildKnowledge());
 assert.ok(!c.dictionary.intents.some(i=>i.family==='Subscription'||i.family==='Loyalty'));
 for(const text of ['start subscription','cancel my subscription','pause subscription','redeem points']){assert.equal(resolve(c,text).intent,null,text);assert.equal(resolve(c,text).status,'UNSUPPORTED',text);}
});
test('unsupported customer requests abstain while implemented features remain available',()=>{
 const c=compile(d);
 for(const text of ['cancel my subscription','skip the next subscription delivery','apply gift card','add payment card','place preorder','return my order','redeem points']){assert.equal(resolve(c,text).intent,null,text);assert.equal(resolve(c,text).status,'UNSUPPORTED',text);}
 for(const [text,intent] of [['show my orders','ORDER_HISTORY'],['show product reviews','PRODUCT_REVIEWS'],['show delivery slots','VIEW_DELIVERY_SLOTS'],['is pickup available','CHECK_PICKUP'],['open support ticket','CREATE_SUPPORT_REQUEST']])assert.equal(resolve(c,text).intent,intent,text);
});
