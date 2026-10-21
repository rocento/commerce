import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compileRecognitionRules,withRecognitionRules,languageValue,languagePattern} from '../src/recognition-rules.ts';
import {recognitionSeed} from '../src/recognition-seed.ts';
import {upgradeRecognitionDictionary} from '../src/recognition-authoring.ts';
import {dictionaryContentFingerprint} from '../src/release-lifecycle.ts';
const clear='cart-clear-language.clear.value.1';
function custom(){const d=buildExpandedDictionary();d.recognitionRules!.revision++;d.recognitionRules!.entries[clear]={kind:'value',value:'(?:purge|clear(?: out)?|empty(?: out)?|reset|wipe(?: out)?)'};return d;}
test('changing only published recognition data adds a phrase and leaves other releases unchanged',()=>{
 const original=buildExpandedDictionary(),a=compile(original),changed=custom(),b=compile(changed);
 assert.notEqual(resolve(a,'purge my cart').intent,'CLEAR_CART');
 assert.equal(resolve(b,'purge my cart').intent,'CLEAR_CART');
 assert.equal(resolve(b,'purge my cart').requiresConfirmation,true);
 assert.notEqual(resolve(b,'do not purge my cart').intent,'CLEAR_CART');
 assert.notEqual(resolve(b,'purge my cart except milk').status,'RESOLVED');
 assert.notEqual(resolve(a,'purge my cart').intent,'CLEAR_CART');
 assert.notEqual(dictionaryContentFingerprint(original),dictionaryContentFingerprint(changed));
 changed.recognitionRules!.entries[clear]={kind:'value',value:'nevermatch'};
 assert.equal(resolve(b,'purge my cart').intent,'CLEAR_CART');
});
test('missing, malformed or incompatible rule snapshots fail closed before resolution',()=>{
 const d=buildExpandedDictionary();delete d.recognitionRules;assert.throws(()=>compile(d),/complete versioned/);
 const missing=recognitionSeed();delete missing.entries[clear];assert.throws(()=>compileRecognitionRules(missing),/Missing or incompatible/);
 const wrong=recognitionSeed();wrong.entries[clear]={kind:'value',value:42};assert.throws(()=>compileRecognitionRules(wrong),/Invalid recognition value/);
 const invalid=recognitionSeed();invalid.entries['search-language.from.pattern.1']={kind:'pattern',source:'[',flags:''};assert.throws(()=>compileRecognitionRules(invalid),/Invalid recognition pattern/);
 const fragment=recognitionSeed();fragment.entries[clear]={kind:'value',value:'['};assert.throws(()=>compileRecognitionRules(fragment),/Invalid recognition fragment/);
 const capture=recognitionSeed();capture.entries['read-language.order.pattern.1']={kind:'pattern',source:'^order$',flags:'i'};assert.throws(()=>compileRecognitionRules(capture),/capture contract/);
 const template=recognitionSeed();template.entries['search-language.command.template.1']={kind:'template',parts:[]};assert.throws(()=>compileRecognitionRules(template),/Invalid recognition template/);
});
test('concurrent and nested recognition contexts do not leak words or RegExp state',async()=>{
 const a=compileRecognitionRules(recognitionSeed()),b=compileRecognitionRules(custom().recognitionRules!);
 await Promise.all([a,b].map((runtime,index)=>withRecognitionRules(runtime,async()=>{
  const before=languageValue<string>(clear);await delay(index?5:15);assert.equal(languageValue(clear),before);
  withRecognitionRules(index?a:b,()=>assert.notEqual(languageValue(clear),before));assert.equal(languageValue(clear),before);
  const key='normalize.normalize.pattern.1',one=languagePattern(key),two=languagePattern(key);one.lastIndex=9;assert.equal(two.lastIndex,0);
 })));
});
test('legacy upgrades are explicit, preserve other knowledge, and require increasing edit revisions',()=>{
 const d=buildExpandedDictionary();delete d.recognitionRules;d.generationFingerprint='legacy';
 const upgraded=upgradeRecognitionDictionary(d);assert.equal(d.recognitionRules,undefined);assert.equal(d.generationFingerprint,'legacy');assert.equal(upgraded.generationFingerprint,undefined);
 const {recognitionRules,generationFingerprint,...rest}=upgraded;const {generationFingerprint:old,...before}=d;assert.deepEqual(rest,before);
 const rules=recognitionSeed();rules.entries[clear]={kind:'value',value:'purge'};assert.throws(()=>upgradeRecognitionDictionary(upgraded,rules),/higher revision/);
 rules.revision++;assert.doesNotThrow(()=>compile(upgradeRecognitionDictionary(upgraded,rules)));
});
