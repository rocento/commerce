import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {requestEnvelope} from '../src/request-envelope.ts';

const compiled=await loadRuntime();

test('greetings and background do not turn return conditions into courtesy suffixes',()=>{
 for(const prefix of ['Hi, ','Quick question: ','I am comparing options. ','Before I decide, ']){
  const text=`${prefix}Can I return Acme Notebook if it is not right for me?`;
  assert.equal(requestEnvelope(text),undefined,text);
  const result=resolve(compiled,text);
  assert.equal(result.intent,'RETURN_POLICY',text);assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.entities.productText,'Acme Notebook',text);
  assert.equal(result.requiresConfirmation,false,text);assert.deepEqual(result.operations,[],text);
 }
});

test('substantive negative and conditional endings survive affirmative request framing',()=>{
 for(const clause of ['if it is right for me','unless it is not right for me','without choosing for me','if it isn’t right for me']){
  assert.equal(requestEnvelope(`Please show milk ${clause}`),`show milk ${clause}`,clause);
 }
 assert.equal(requestEnvelope('Could you show milk for me?'),'show milk');
});
