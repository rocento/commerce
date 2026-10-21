import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {evidenceRequirements} from './evidence-requirements.ts';
import type {RequestConstraint} from './semantic-types.ts';

/** Preserve source positions while removing one detached request courtesy.
 * The comma and nonempty remainder distinguish it from a substantive condition.
 */
export function courtesyCoreText(text:string):string|undefined {
 const prefix=languagePattern('request-constraints.prefix.pattern.1').exec(text);
 return prefix?' '.repeat(prefix[0].length)+text.slice(prefix[0].length):undefined;
}

/** Keep unsupported qualifiers explicit before flat or semantic interpretation.
 * Blank their spans (rather than deleting them) to preserve clause offsets.
 * A recognized qualifier never becomes permission to run the remaining action.
 */
export function requestConstraints(text:string):{coreText:string;constraints:RequestConstraint[]} {
 const quoted=[...text.matchAll(languagePattern('request-constraints.quoted.pattern.1'))].map(m=>[m.index!,m.index!+m[0].length]);
 const isQuoted=(at:number)=>quoted.some(([start,end])=>at>=start&&at<end);
 const constraints:RequestConstraint[]=[];
 let coreText=text;
 const add=(start:number,end:number,kind:RequestConstraint['kind'],operator:RequestConstraint['operator'],value:string)=>{
  const literal=text.slice(start,end);
  const scope:RequestConstraint['scope']=kind==='EXCLUSION'?'PRODUCT':languagePattern('request-constraints.scope.pattern.1').test(value)?'LINE_TOTAL':languagePattern('request-constraints.scope.pattern.2').test(value)?'BASKET_TOTAL':languagePattern('request-constraints.scope.pattern.3').test(value)?'UNIT_PRICE':languagePattern('request-constraints.scope.pattern.4').test(value)?'DELIVERY':'REQUEST';
  constraints.push({kind,scope,operator,text:literal,value:value.trim().replace(languagePattern('request-constraints.add.pattern.1'),''),start:[...text.slice(0,start)].length,end:[...text.slice(0,end)].length,state:'UNSUPPORTED'});
  coreText=coreText.slice(0,start)+' '.repeat(end-start)+coreText.slice(end);
 };
 // Instructional questions do not become conditional commands.
 if(!languagePattern('request-constraints.requestConstraints.pattern.1').test(text)){
  const condition=[...text.matchAll(languagePattern('request-constraints.condition.pattern.1'))].find(m=>{
   if(isQuoted(m.index!))return false;
   // A bounded, detached courtesy phrase is not a fact to verify. Do not
   // erase "only if possible", "if possible before Friday", or a subsequent
   // real condition; the latter must still be found by this same scan.
   const before=text.slice(0,m.index!),after=text.slice(m.index!+m[0].length);
   const courtesy=m[1].toLowerCase()===languageValue<string>('request-constraints.lexical.value.1')&&!before.trim()&&languagePattern('request-constraints.courtesy.pattern.1').test(after);
   return !courtesy;
  });
  if(condition){
   const start=condition.index!,prefix=text.slice(0,start).trim();
   const comma=text.indexOf(',',start+condition[0].length);
   const end=!prefix&&comma>=0?comma+1:text.length;
   add(start,end,'CONDITION',condition[1].toLowerCase()===languageValue<string>('request-constraints.lexical.value.2')?'UNLESS':'IF',text.slice(start+condition[0].length,!prefix&&comma>=0?comma:end));
  }
 }
 const evidence=evidenceRequirements(text);
 const exclusion=[...coreText.matchAll(languagePattern('request-constraints.exclusion.pattern.1'))].find(m=>{
  if(isQuoted(m.index!))return false;
  if(m[1].toLowerCase()===languageValue<string>('request-constraints.lexical.value.3')&&(languagePattern('request-constraints.exclusion.pattern.2').test(text.slice(0,m.index!))||!text.slice(0,m.index!).trim()||languagePattern('request-constraints.exclusion.pattern.3').test(text.slice(m.index!+m[0].length))))return false;
  const point=[...text.slice(0,m.index!)].length;
  // These already have a domain-specific, evidence-backed clarification bridge.
  return !evidence.some(e=>point>=e.start&&point<e.end);
 });
 if(exclusion){
  const start=exclusion.index!,end=constraints.find(c=>c.kind==='CONDITION')?text.length-(text.length-coreText.trimEnd().length):text.length;
  if(end>start)add(start,end,'EXCLUSION','EXCLUDE',text.slice(start+exclusion[0].length,end));
 }
 return {coreText,constraints};
}

export function constraintQuestion(constraints:RequestConstraint[]):string {
 const condition=constraints.find(c=>c.kind==='CONDITION');
 const exclusion=constraints.find(c=>c.kind==='EXCLUSION');
 if(condition){
  const subject=condition.scope==='BASKET_TOTAL'?'the basket total':condition.scope==='LINE_TOTAL'?'the line total':condition.scope==='UNIT_PRICE'?'the price per item':condition.scope==='DELIVERY'?'delivery':'this condition';
  return languageTemplate('request-constraints.constraintQuestion.template.1', [subject, condition.text.slice(0,200), exclusion?' or the requested exclusion':'', subject]);
 }
 return languageTemplate('request-constraints.constraintQuestion.template.2', [exclusion?.value.slice(0,200)??'']);
}
