import {enterRecognitionRules} from '../src/recognition-rules.ts';
import {loadRuntime} from '../src/runtime.ts';
import {normalize} from '../src/normalize.ts';
const runtime=await loadRuntime();enterRecognitionRules(runtime.recognition);const d=runtime.dictionary;const [kind,...args]=process.argv.slice(2);const query=args.join(' ');if(!query)throw new Error('Supply an intent, group or term');const result=kind==='intent'?d.intents.filter(i=>i.code===query):kind==='group'?d.groups.filter(g=>g.code===query):d.groups.filter(g=>g.terms.some(t=>normalize(t).includes(normalize(query))));console.log(JSON.stringify(result,null,2));if(!result.length)process.exitCode=1;
