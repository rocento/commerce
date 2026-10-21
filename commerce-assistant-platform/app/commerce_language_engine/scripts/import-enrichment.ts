import {compileRecognitionRules,enterRecognitionRules} from '../src/recognition-rules.ts';
/** Import only into the explicitly named isolated local review database. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {migrate,saveDictionary,withDb,closeDb,databaseUrl} from '../src/database.ts';
import {compile} from '../src/compiler.ts';
import {loadRelease} from '../src/release-lifecycle.ts';
import {resolve} from '../src/engine.ts';
import {caseKey} from '../src/generation/corpus.ts';
import {englishVocabularySource} from '../src/generation/reviewed-english.ts';
import type {Dictionary,CorpusCase} from '../src/types.ts';
const url=new URL(databaseUrl);
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/commerce_language_enrichment_v1')throw new Error('This importer is restricted to the isolated local enrichment database.');
const out=new URL('../data/enrichment/',import.meta.url);
const report=JSON.parse(await readFile(new URL('report.json',out),'utf8'));
const dictionary:Dictionary=JSON.parse(await readFile(new URL('dictionary.json',out),'utf8'));
enterRecognitionRules(compileRecognitionRules(dictionary.recognitionRules));
if(report.releaseBlockingFailures.length||report.regressions)throw new Error('Enrichment release gate failed');
if(createHash('sha256').update(JSON.stringify(dictionary)).digest('hex')!==report.fingerprint)throw new Error('Dictionary/report fingerprint mismatch');
const rows=(await readFile(new URL('cases.jsonl',out),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
const examples:CorpusCase[]=rows.filter(r=>r.pass&&r.intent&&!r.held).map(r=>({text:r.text,intent:r.intent,status:'RESOLVED',difficulty:'MEDIUM',split:'development',templateFamily:r.family,source:englishVocabularySource}));
const corpus=[...new Map([...dictionary.corpus,...examples].map(c=>[caseKey(c),c])).values()];
await migrate();
const candidate=await saveDictionary(dictionary,corpus,{...report,version:dictionary.version,source:englishVocabularySource,corpusCases:corpus.length});
const loaded:Dictionary=(await withDb(c=>loadRelease(c,candidate.releaseId))).dictionary;const runtime=compile(loaded);
for(const example of examples){const result=resolve(runtime,example.text);if(result.intent!==example.intent||result.status!==example.status)throw new Error('Database round-trip failed: '+example.text);}
const terms=loaded.groups.reduce((n,g)=>n+g.terms.filter(t=>g.termMetadata?.[t]?.source===englishVocabularySource).length,0);
if(terms!==report.addedTerms)throw new Error('Database term provenance mismatch');
const result={releaseId:candidate.releaseId,activated:false,database:url.pathname.slice(1),addedTerms:terms,verifiedExamples:examples.length,storedCorpus:corpus.length,fingerprint:loaded.generationFingerprint,status:'pass',productionModified:false};
await writeFile(new URL('database-validation.json',out),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

await closeDb();
