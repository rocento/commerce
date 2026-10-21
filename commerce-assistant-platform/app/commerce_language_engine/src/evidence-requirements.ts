import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Bounded requirement recognition; these spans describe requests, never product facts. */
export function evidenceRequirements(text:string) {
 const rules:[string,RegExp][]=[
  ['medical_treatment',languagePattern('evidence-requirements.rules.pattern.1')],
  ['allergy_safety',languagePattern('evidence-requirements.rules.pattern.2')],
  ['pregnancy_suitability',languagePattern('evidence-requirements.rules.pattern.3')],
  ['device_compatibility',languagePattern('evidence-requirements.rules.pattern.4')],
  ['named_device_compatibility',languagePattern('evidence-requirements.rules.pattern.5')],
  ['manufacturing_method',languagePattern('evidence-requirements.rules.pattern.6')],
  ['ingredient_exclusion',languagePattern('evidence-requirements.rules.pattern.7')],
  ['delivery_deadline',languagePattern('evidence-requirements.rules.pattern.8')],
  ['household_value',languagePattern('evidence-requirements.rules.pattern.9')],
 ];
 const quoted=[...text.matchAll(languagePattern('evidence-requirements.quoted.pattern.1'))].map(m=>[m.index!,m.index!+m[0].length]);
 return rules.flatMap(([kind,pattern])=>[...text.matchAll(pattern)].filter(m=>
  !quoted.some(([start,end])=>m.index!>=start&&m.index!<end)
 ).map(m=>({kind,text:m[0],start:[...text.slice(0,m.index!)].length,end:[...text.slice(0,m.index!+m[0].length)].length}))).sort((a,b)=>a.start-b.start).slice(0,10);
}
