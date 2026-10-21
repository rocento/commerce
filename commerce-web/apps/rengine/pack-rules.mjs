// Package only rule definitions. Credentials and deployment configuration are never read.
import {readFile, writeFile} from 'node:fs/promises';
const dictionary=JSON.parse(await readFile(new URL('../../../commerce-assistant-platform/app/commerce_language_engine/data/compiled.json',import.meta.url),'utf8'));
if(!/^[a-f0-9]{64}$/.test(dictionary.generationFingerprint)||!Array.isArray(dictionary.intents))throw new Error('Invalid compiled rule artifact');
await writeFile(new URL('./rulebook.json',import.meta.url),JSON.stringify({generationFingerprint:dictionary.generationFingerprint,intents:dictionary.intents}));
console.log(`Packaged ${dictionary.intents.length} intent definitions for ${dictionary.generationFingerprint}`);
