/** Explicit bootstrap data; DB drafts are the source for subsequent releases. */
import seed from '../../seeds/expanded-dictionary.en.json' with {type:'json'};
import {withSeedDictionary} from '../recognition-seed.ts';
import type {Dictionary} from '../types.ts';
export function buildExpandedDictionary():Dictionary{return withSeedDictionary(seed as unknown as Dictionary);}
