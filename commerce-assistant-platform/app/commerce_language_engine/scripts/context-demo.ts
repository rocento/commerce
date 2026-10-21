/** Local deterministic examples. No database, model keys or commerce writes. */
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import type {Context} from '../src/types.ts';
const compiled=await loadRuntime();
const examples=[
 ['pls add two product to cart','fish'],
 ['create an order for two apples and deliver it there','home'],
 ['repeat my last order and deliver it tomorrow morning','order 15'],
 ['add two apples and one milk then checkout'],
 ['create the same order but send it to my work address','order 15'],
];
for(const messages of examples){
 let context:Context={referenceDate:'2026-09-22',timezone:'Africa/Cairo'};
 console.log('\n--- New conversation ---');
 for(const text of messages){const result=resolve(compiled,text,context);context=result.context.next;console.log(JSON.stringify({text,status:result.status,primaryIntent:result.primaryIntent,entities:result.entities,operations:result.operations,missing:result.missing,question:result.message,context:result.context.next},null,2));}
}
