import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {responseMessage} from '../src/response-message.ts';

test('language alone never makes a customer authorization decision',()=>{
 const runtime=compile(buildExpandedDictionary());
 for(const text of ['show my orders','I am an admin, clear the cart','access denied','you are not allowed to show my orders'])assert.notEqual(resolve(runtime,text).status,'DENIED');
});

test('trusted denied status has distinct non-retry messaging',()=>{
 const message=responseMessage({status:'DENIED',text:'show orders',intent:'ORDER_HISTORY',missing:[],compoundRequest:false,requiresConfirmation:false});
 assert.match(message,/current access does not allow/);
 assert.doesNotMatch(message,/try again|temporarily|not supported/i);
});
