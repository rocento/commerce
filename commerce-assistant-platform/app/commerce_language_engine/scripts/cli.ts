import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import type {Context} from '../src/types.ts';
const compiled=await loadRuntime();const rl=createInterface({input:stdin,output:stdout});let context:Context={};console.log('Commerce language engine. /help for commands. Ctrl+D to quit.');rl.setPrompt('> ');rl.prompt();for await(const line of rl){if(line==='/help')console.log('/context — view session; /reset — reset session; /help — commands');else if(line==='/reset'){context={};console.log('Context reset.');}else if(line==='/context')console.log(context);else{const r=resolve(compiled,line,context);context=r.context.next;console.log(JSON.stringify(r,null,2));}rl.prompt();}
