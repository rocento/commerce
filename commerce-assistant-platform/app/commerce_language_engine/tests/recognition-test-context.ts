/** Existing fixtures predate recognition snapshots: upgrade them explicitly in tests. */
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dictionaryContentFingerprint} from '../src/release-lifecycle.ts';
import type {Dictionary} from '../src/types.ts';
import {recognitionSeed} from '../src/recognition-seed.ts';
import {compileRecognitionRules,enterRecognitionRules} from '../src/recognition-rules.ts';
export {recognitionSeed};
export function recognitionFixture<T extends Dictionary>(base:T):T {
 const dictionary={...base,recognitionRules:recognitionSeed()};
 dictionary.generationFingerprint=dictionaryContentFingerprint(dictionary);return dictionary;
}
enterRecognitionRules(compileRecognitionRules(recognitionSeed()));
if(!process.env.CLE_DEPLOY_DATA_DIR){
 const directory=mkdtempSync(join(tmpdir(),'cle-recognition-test-'));
 const dictionary=JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'));
 dictionary.recognitionRules=recognitionSeed();
 dictionary.generationFingerprint=dictionaryContentFingerprint(dictionary);
 writeFileSync(join(directory,'compiled.json'),JSON.stringify(dictionary));
 process.env.CLE_DEPLOY_DATA_DIR=directory;
 process.once('exit',()=>rmSync(directory,{recursive:true,force:true}));
}
