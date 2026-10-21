/** Bootstrap authoring input. Runtime dictionaries are immutable database releases. */
import seed from '../seeds/base-dictionary.en.json' with {type:'json'};
import {withSeedDictionary} from './recognition-seed.ts';
import type {Dictionary} from './types.ts';
export {states,industries,entityTypes} from './dictionary-schema.ts';
export function buildKnowledge():Dictionary{return withSeedDictionary(seed as unknown as Dictionary);}
