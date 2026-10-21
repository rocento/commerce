import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {quantityPrefix} from './quantities.ts';
import type {Token} from './semantic-clauses.ts';
import type {Delivery,Item,SemanticContext} from './semantic-types.ts';
import {findReferenceRule} from './reference-resolution.ts';
import type {ReferenceRule} from './types.ts';

const generic=()=>recognitionMemo('semantic-entities.generic',()=>(languagePattern('semantic-entities.generic.pattern.1')));
const pronoun=()=>recognitionMemo('semantic-entities.pronoun',()=>(languagePattern('semantic-entities.pronoun.pattern.1')));
export function itemsFrom(tokens:Token[],referenceIndex?:Map<string,ReferenceRule[]>): Item[] {
  let words=tokens.map(t=>t.quoted?'"'+t.value+'"':t.value);
  while(languageValue<string[]>('semantic-entities.itemsFrom.value.1').includes(words[0]))words.shift();
  // Destination/date modifiers cannot become part of a product's name.
  const stop=words.findIndex((w,i)=>languageValue<string[]>('semantic-entities.stop.value.1').includes(w)&&(
    languageValue<string[]>('semantic-entities.stop.value.2').includes(w)||words.slice(i+1,i+4).some(v=>languageValue<string[]>('semantic-entities.stop.value.3').includes(v))));
  if(stop>=0)words=words.slice(0,stop);
  const segments:string[][]=[];let current:string[]=[];
  for(let i=0;i<words.length;i++) {
    const word=words[i];
    const next=quantityPrefix(words.slice(i+1));
    // Quoted coordinated names remain one token; explicit quantity prefixes bind each list item.
    // Number conjunctions such as "one hundred and two" belong to their quantity prefix.
    const numericPrefix=quantityPrefix(current);
    const unquantifiedList=numericPrefix.quantity===undefined&&numericPrefix.quantityRange===undefined&&current.length>0&&current.every(w=>!w.includes(' '))&&words[i+1]!==undefined;
    const numberContinues=word===languageValue<string>('semantic-entities.numberContinues.value.1')&&current[current.length-1]===languageValue<string>('semantic-entities.lexical.value.1')&&next.quantity!==undefined;
    if(word===','||(word===languageValue<string>('semantic-entities.itemsFrom.value.2')&&!numberContinues&&current.length>numericPrefix.end&&(next.quantity!==undefined||unquantifiedList))) {if(current.length)segments.push(current);current=[];}
    else current.push(word);
  }
  if(current.length)segments.push(current);
  return segments.slice(0,51).map(segment=>{
    const q=quantityPrefix(segment);let body=segment.slice(q.end);
    if(body[0]===languageValue<string>('semantic-entities.itemsFrom.value.3'))body.shift();
    let unit:string|undefined;
    if(languageValue<string[]>('semantic-entities.itemsFrom.value.4').includes(body[0])){unit=body.shift();if(body[0]===languageValue<string>('semantic-entities.itemsFrom.value.5'))body.shift();}
    const text=body.map(w=>w.replace(languagePattern('semantic-entities.text.pattern.1'),'')).join(' ').trim();
    const reference=pronoun().exec(text)?.[1];
    let matched=referenceIndex?findReferenceRule(text,referenceIndex,'ENTITY')??findReferenceRule(text,referenceIndex,'RESULT_SET'):undefined;
    // A ranking adjective followed by a product is a search, not a prior-result reference.
    if(matched?.rule.constraints.selectionStrategy==='CHEAPEST'&&text.replace(languagePattern('semantic-entities.itemsFrom.pattern.1'), '')!==text&&!languagePattern('semantic-entities.itemsFrom.pattern.2').test(text))matched=undefined;
    const referenceText=matched?.surface.toUpperCase()??reference?.toUpperCase();
    return {...(q.quantity!==undefined?{quantity:q.quantity}:{}),...(unit?{unit}:{}),...(matched?.rule.constraints.selectionStrategy?{selectionStrategy:String(matched.rule.constraints.selectionStrategy)}:{}),...(referenceText?{reference:referenceText}:text&&!generic().test(text)?{productText:text}:languageValue<{ reference: string; }>('semantic-entities.itemsFrom.value.6')),...(q.quantityRange?languageValue<{ reference: string; }>('semantic-entities.itemsFrom.value.7'):{})};
  });
}
export function validDate(value:string):boolean {
  return languagePattern('semantic-entities.validDate.pattern.1').test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
}
export function deliveryFrom(text:string,context:SemanticContext,referenceIndex?:Map<string,ReferenceRule[]>):{delivery:Delivery;missing:string[];reference?:string} {
  const lower=text.toLowerCase();const delivery:Delivery={};const missing:string[]=[];let reference:string|undefined;
  if(languagePattern('semantic-entities.deliveryFrom.pattern.1').test(lower))delivery.addressReference='HOME';
  else if(languagePattern('semantic-entities.deliveryFrom.pattern.2').test(lower))delivery.addressReference='WORK';
  else if((referenceIndex?findReferenceRule(lower,referenceIndex,'LOCATION'):undefined)|| languagePattern('semantic-entities.deliveryFrom.pattern.3').test(lower)) {
    reference=findReferenceRule(lower,referenceIndex??new Map(),'LOCATION')?.surface.toUpperCase()??'THERE';
    if(context.deliveryAddressReference)delivery.addressReference=context.deliveryAddressReference;
    else missing.push('delivery.addressReference');
  } else if(languagePattern('semantic-entities.deliveryFrom.pattern.4').test(lower))missing.push('delivery.addressReference');
  const relative=languagePattern('semantic-entities.relative.pattern.1').exec(lower)?.[1];
  if(relative){
    delivery.relativeDate=relative.toUpperCase().replaceAll(' ','_');
    if(context.referenceDate&&validDate(context.referenceDate)){
      const date=new Date(context.referenceDate+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+(relative===languageValue<string>('semantic-entities.lexical.value.2')?1:relative===languageValue<string>('semantic-entities.lexical.value.3')?2:0));delivery.date=date.toISOString().slice(0,10);
    }
  }
  if(languagePattern('semantic-entities.deliveryFrom.pattern.5').test(lower)){delete delivery.addressReference;missing.push('delivery.addressReference');}
  const explicit=languagePattern('semantic-entities.explicit.pattern.1').exec(lower)?.[0];
  if(explicit){if(validDate(explicit))delivery.date=explicit;else missing.push('delivery.date');}
  const period=languagePattern('semantic-entities.period.pattern.1').exec(lower)?.[1];
  if(period)delivery.timeWindow={period:period.toUpperCase()};
  const range=languagePattern('semantic-entities.range.pattern.1').exec(lower);
  if(range){
    function clock(value:string,meridiem?:string):string|null {const [h,m='00']=value.split(':');let hour=Number(h);if(Number(m)>59||hour>23||meridiem&&(hour<1||hour>12))return null;if(meridiem)hour=hour%12+(meridiem===languageValue<string>('semantic-entities.lexical.value.4')?12:0);return `${String(hour).padStart(2,'0')}:${m}`;}
    if(!range[2]&&!range[4]&&!range[1].includes(':')&&!range[3].includes(':'))missing.push('delivery.timeWindow');
    else {const start=clock(range[1],range[2]??range[4]),end=clock(range[3],range[4]??range[2]);if(start&&end&&start<end)delivery.timeWindow={start,end};else missing.push('delivery.timeWindow');}
  }
  if(context.timezone)delivery.timezone=context.timezone;
  return {delivery,missing,reference};
}
