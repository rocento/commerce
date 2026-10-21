/** Authoring fixtures for the Node/Python boundary; independent of reserved validation. */
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-phase2-v1.json',import.meta.url),'utf8'));
const engine=compile({...JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8')),languageKnowledge:pack});
const cases=[
 'Find scarf made from cotton without green',
 'Find necklace without brass and nickel',
 'Find scarf without green and yellow',
 'Find laptop for bookkeeping and my budget is from $180 to $720',
 'Find laptop for bookkeeping with my budget is between $180 and $720',
 'Find laptop for bookkeeping with my spending limit is $720',
 'Find laptop for my mentor and my godmother for podcasting and invoicing',
];
console.log(JSON.stringify({pack,cases:cases.map(text=>({text,result:resolve(engine,text)}))}));
