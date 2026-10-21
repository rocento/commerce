// Explicit authoring examples, not an independent held-out benchmark.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'output/enterprise-knowledge-expansion-20261010');
const examples=[
 ['I need a microphone for recording audiobooks and my budget is $75','intended_use','audiobook recording'],
 ['Find a camera for macro photography under $500','intended_use','macro photography'],
 ['I need a camera for photographing products and my budget is $600','intended_use','product photography'],
 ['Find a keyboard for my lab partner for debugging software','recipient','lab partner'],
 ['Find supplies for hand sewing','intended_use','hand sewing'],
 ['Find paint for painting with watercolours','intended_use','watercolor painting'],
 ['Find tools for restoring furniture','intended_use','furniture restoration'],
 ['Find flour for baking sourdough bread','intended_use','sourdough baking'],
 ['Find a machine for frothing milk','intended_use','milk frothing'],
 ['Find supplies for wrapping presents','intended_use','gift wrapping'],
 ['Find shoes for playing badminton','intended_use','badminton'],
 ['Find equipment for making fresh juice','intended_use','juicing'],
 ['Find supplies for propagating plants','intended_use','plant propagation'],
 ['Find headphones for mixing live audio','intended_use','live audio mixing'],
 ['Find a scarf for my stepmum','recipient','stepmother'],
 ['Find shoes for my bridesmaids','recipient','bridesmaid'],
 ['Find a scarf for my foster parents','recipient','foster parent'],
 ['Find a necklace for my dog sitter','recipient','dog sitter'],
 ['Find cloth made of microfibre','material','microfiber'],
 ['Find a scarf made of merino-wool','material','merino wool'],
 ['Find a pan made of carbon steel','material','carbon steel'],
 ['Find a bowl made of borosilicate glass','material','borosilicate glass'],
];
async function runtime(dir){const source=join(dir,'engine/src');const [{loadRuntime},{resolve:interpret}]=await Promise.all(['runtime.ts','engine.ts'].map(f=>import(pathToFileURL(join(source,f)))));return {compiled:await loadRuntime(),interpret};}
const before=await runtime(join(root,'output/enterprise-knowledge-phase2-fixes-20261010')),after=await runtime(out);
const run=r=>examples.map(([text,relation,value],i)=>{const result=r.interpret(r.compiled,text);const passed=result.status==='RESOLVED'&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent)&&(result.entities.shoppingContext?.relations??[]).some(x=>x.relation===relation&&x.value===value);return {id:'EXPANSION-'+String(i+1).padStart(3,'0'),text,expected:{relation,value},passed,status:result.status,intent:result.intent,productText:result.entities.productText,price:result.entities.price,relations:result.entities.shoppingContext?.relations??[]};});
const baseline=run(before),candidate=run(after);
const report={scope:'AI-authored development examples after vocabulary authoring; not independent held-out labels, live recommendations or production accuracy.',baselineFingerprint:before.compiled.dictionary.generationFingerprint,candidateFingerprint:after.compiled.dictionary.generationFingerprint,counts:{cases:examples.length,baselinePassed:baseline.filter(r=>r.passed).length,candidatePassed:candidate.filter(r=>r.passed).length,improved:candidate.filter((r,i)=>r.passed&&!baseline[i].passed).length,regressed:candidate.filter((r,i)=>!r.passed&&baseline[i].passed).length},baseline,candidate};
writeFileSync(join(out,'authored-examples.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report.counts));
