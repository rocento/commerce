import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Recognition only: these definitions never enter the executable dictionary. */
import {normalize} from './normalize.ts';

type Recognition = {code:string; actions:string[]; objects:string[]};
const inventory=()=>languageValue<Recognition[]>('unsupported.inventory.value.1');
const escape=(value:string)=>value.replace(languagePattern('unsupported.escape.pattern.1'),'\\$&');
const rules=()=>recognitionMemo('unsupported.rules',()=>(inventory().flatMap(rule=>rule.actions.flatMap(action=>rule.objects.map(object=>({
 code:rule.code,
 // Require an explicit action and its object in the same command. Merely
 // mentioning a gift card (e.g. a gift card holder search) is insufficient.
 pattern:new RegExp(languageTemplate('unsupported.rules.template.1', [escape(normalize(action)), escape(normalize(object))])),
}))))));

export function unsupportedIntents(text:string):string[] {
 const found=new Set<string>();
 // Each clause must independently express a positive request. Quoted examples,
 // negation, hypothetical instructions, and ambiguous alternatives abstain.
 for(const raw of text.split(languagePattern('unsupported.unsupportedIntents.pattern.1'))){
  const clause=normalize(raw).replace(languagePattern('unsupported.clause.pattern.1'), '');
  if(!clause||languagePattern('unsupported.unsupportedIntents.pattern.2').test(raw)||languagePattern('unsupported.unsupportedIntents.pattern.3').test(clause))continue;
  for(const rule of rules())if(rule.pattern.test(clause))found.add(rule.code);
 }
 return [...found].sort();
}
