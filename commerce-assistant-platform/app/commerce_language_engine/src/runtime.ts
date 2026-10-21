import {readFile} from 'node:fs/promises';
import {compile} from './compiler.ts';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function loadRuntime() {
 const data=process.env.CLE_DEPLOY_DATA_DIR?pathToFileURL(resolve(process.env.CLE_DEPLOY_DATA_DIR)+'/'):new URL('../data/',import.meta.url);
 const dictionary=JSON.parse(await readFile(new URL('compiled.json',data),'utf8'));
 dictionary.entity_terms??=dictionary.aliases;
 return compile(dictionary);
}
