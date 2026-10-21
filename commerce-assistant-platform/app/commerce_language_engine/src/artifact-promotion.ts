export type PromotionCandidate={
 dictionaryVersion:number;generationFingerprint:string;runtimePromotion?:string;
 provenance?:{source?:string;sampleCount?:number};
 evaluationGate?:{passed?:boolean;brierScoreRegressed?:boolean};
 criticalIntentPrecision?:Record<string,{precision:number;samples:number}>;
};

/** Conservative automated gate; synthetic or incomplete evidence never promotes. */
export function promotionBlockers(candidate:PromotionCandidate,expected:{dictionaryVersion:number;generationFingerprint:string},criticalIntents:string[]):string[]{
 const blockers:string[]=[];
 if(candidate.dictionaryVersion!==expected.dictionaryVersion||candidate.generationFingerprint!==expected.generationFingerprint)blockers.push('artifact_dictionary_mismatch');
 if(candidate.provenance?.source!=='production-feedback'||!Number.isInteger(candidate.provenance.sampleCount)||candidate.provenance.sampleCount!<1000)blockers.push('insufficient_production_feedback');
 if(candidate.evaluationGate?.passed!==true||candidate.evaluationGate.brierScoreRegressed===true)blockers.push('heldout_calibration_gate_failed');
 if(candidate.runtimePromotion==='DISABLED')blockers.push('artifact_explicitly_disabled');
 for(const intent of criticalIntents){const evidence=candidate.criticalIntentPrecision?.[intent];if(!evidence||evidence.samples<100||evidence.precision<0.99)blockers.push(`critical_precision_gate_failed:${intent}`);}
 return blockers;
}
