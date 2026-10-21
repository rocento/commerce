import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-phase2-v2.json',import.meta.url),'utf8'));
const engine=compile({...JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8')),languageKnowledge:pack});
const texts=['Find bread for my family','Find bread for our household and team','Find bread for families','Find scarf for my uncle or my brother','Find cable compatible with my iPhone 13','Find cable that works with iPhone 13','Find bread for my family and for teams'];
console.log(JSON.stringify({pack,cases:texts.map(text=>({text,result:resolve(engine,text)}))}));
