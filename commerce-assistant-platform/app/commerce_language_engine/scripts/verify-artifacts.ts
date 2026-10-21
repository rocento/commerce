import {readFile} from 'node:fs/promises';
import {compile} from '../src/compiler.ts';
import {promotionBlockers} from '../src/artifact-promotion.ts';

const dictionary=JSON.parse(await readFile('data/compiled.json','utf8'));
const generation=JSON.parse(await readFile('data/generation-report.json','utf8'));
if(dictionary.version!==generation.version||dictionary.generationFingerprint!==generation.fingerprint)throw new Error('Compiled dictionary and generated corpus version/fingerprint do not match.');
compile(dictionary);
let calibration='not_present';
try{
 const candidate=JSON.parse(await readFile('data/confidence-calibration.json','utf8'));
 if(candidate.runtimePromotion!=='DISABLED'){
  const blockers=promotionBlockers(candidate,{dictionaryVersion:dictionary.version,generationFingerprint:generation.fingerprint},['CREATE_ORDER','CHECKOUT','CANCEL_ORDER']);
  if(blockers.length)throw new Error('Confidence calibration promotion rejected: '+blockers.join(', '));
  calibration='promotion_candidate_passed';
 }else calibration='diagnostic_only';
}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
console.log(JSON.stringify({status:'pass',dictionaryVersion:dictionary.version,generationFingerprint:generation.fingerprint,compiler:'pass',confidenceCalibration:calibration}));
