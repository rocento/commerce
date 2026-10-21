import type {Candidate} from './types.ts';

export const defaultScoring = {
 weights: {required:4, relationship:5, optional:1, generic:0.25, context:3},
 penalties: {contradiction:6, negatedAction:8, missingRequired:5},
 temperature:2, minScore:6, minConfidence:0.70, minScoreMargin:2,
 minProbabilityMargin:0.15, targetStrongScore:12, targetMargin:5,
};
export type ScoringConfig = typeof defaultScoring;
export type ScoringOptions = Partial<Omit<ScoringConfig,'weights'|'penalties'>> & {
 weights?:Partial<ScoringConfig['weights']>; penalties?:Partial<ScoringConfig['penalties']>;
};
export function scoringConfig(options:ScoringOptions={}):ScoringConfig {
 const config={...defaultScoring,...options,weights:{...defaultScoring.weights,...options.weights},penalties:{...defaultScoring.penalties,...options.penalties}};
 for(const [key,value] of Object.entries({...config,...config.weights,...config.penalties})) {
  if(typeof value==='object')continue;
  if(!Number.isFinite(value)||value<0)throw new Error(`Invalid scoring value: ${key}`);
 }
 for(const key of ['temperature','targetStrongScore','targetMargin'] as const)if(config[key]===0)throw new Error(`Invalid scoring value: ${key}`);
 for(const key of ['minConfidence','minProbabilityMargin'] as const)if(config[key]>1)throw new Error(`Invalid scoring value: ${key}`);
 return config;
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export function scoreConfidence(candidates:Candidate[],config:ScoringConfig) {
 const top=candidates[0]?.score??0;
 const exponentials=candidates.map(c=>Math.exp((c.score-top)/config.temperature));
 const total=exponentials.reduce((a,b)=>a+b,0);
 candidates.forEach((candidate,i)=>{candidate.probability=exponentials[i]/total;});
 const probability=candidates[0]?.probability??0;
 const scoreMargin=candidates.length?top-(candidates[1]?.score??0):0;
 const probabilityMargin=probability-(candidates[1]?.probability??0);
 const evidenceStrength=clamp(top/config.targetStrongScore);
 const separationConfidence=clamp(scoreMargin/config.targetMargin);
 const confidence=clamp(probability*evidenceStrength*separationConfidence);
 return {score:top,probability,confidence,scoreMargin,probabilityMargin,evidenceStrength,separationConfidence};
}
