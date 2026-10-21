import {rocentoDictionary} from '../src/rocento-capabilities.ts';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {loadDictionary} from '../src/database.ts';
import {compile} from '../src/compiler.ts';
const start=performance.now();const d=rocentoDictionary(process.argv.includes('--offline')?JSON.parse(await readFile('data/generated.json','utf8')):await loadDictionary());const result=compile(d);
await mkdir('data',{recursive:true});const {corpus:_corpus,...runtimeDictionary}=d;await writeFile('data/compiled.json.tmp',JSON.stringify({...runtimeDictionary,corpus:[],schemaVersion:result.schemaVersion}));await rename('data/compiled.json.tmp','data/compiled.json');await writeFile('data/compiler-report.json',JSON.stringify({schemaVersion:result.schemaVersion,compileMs:performance.now()-start,diagnostics:result.diagnostics},null,2));console.log('Compiled '+d.intents.length+' intents (schema v'+result.schemaVersion+'); '+result.diagnostics.length+' shared-term/duplicate diagnostics. See data/compiler-report.json.');
