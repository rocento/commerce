import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
// Currency names are linguistic aliases, never exchange rates or store defaults.
import {comparisonPhrasePattern,comparisonOperator} from './comparison-operators.ts';
export const currencyCode=()=>recognitionMemo('price-language.currencyCode',()=>(languageValue<string>('price-language.currencyCode.value.1')));
export const currencyNames=():Readonly<Record<string,string>>=>recognitionMemo('price-language.currencyNames',()=>(Object.freeze(languageValue<Readonly<Record<string,string>>>('price-language.currencyNames.value.1'))));
export const currencyName=()=>recognitionMemo('price-language.currencyName',()=>('(?:'+Object.keys(currencyNames()).sort((a,b)=>b.length-a.length).join('|')+')'));
const symbols=():Readonly<Record<string,string>>=>recognitionMemo('price-language.symbols',()=>({'$':'USD','€':'EUR','£':'GBP'}));
export function priceCurrency(text:string|undefined):string|undefined {
 if(!text)return;
 const key=text.toLowerCase().replace(languagePattern('price-language.key.pattern.1'),' ');
 return Object.hasOwn(symbols(),key)?symbols()[key]:Object.hasOwn(currencyNames(),key)?currencyNames()[key]:undefined;
}
// Require a numeric amount before treating ordinary product words as price syntax.
const number=()=>recognitionMemo('price-language.number',()=>(languageValue<string>('price-language.number.value.1')));
// Capture order is prefix, amount, suffix; all other consumers use non-capturing groups.
const amount=(capture:boolean)=>{
 const group=(pattern:string)=>'('+(capture?'':'?:')+pattern+')';
 return group('[$€£]|'+currencyName()+languageValue<string>('price-language.amount.value.1'))+languageValue<string>('price-language.amount.value.2')+group(number())+languageValue<string>('price-language.amount.value.3')+group(currencyName())+languageValue<string>('price-language.amount.value.4');
};
export const priceAmount=()=>recognitionMemo('price-language.priceAmount',()=>(amount(false)));
export const capturedPriceAmount=()=>recognitionMemo('price-language.capturedPriceAmount',()=>(amount(true)));
const boundary=()=>recognitionMemo('price-language.boundary',()=>(new RegExp(languageValue<string>('price-language.boundary.value.1')+comparisonPhrasePattern()+languageValue<string>('price-language.boundary.value.2')+priceAmount()+')')));

export function withoutPriceTail(text:string):string {
 const match=boundary().exec(text);
 return match?text.slice(0,match.index).trimEnd():text;
}

/** Intersect adjacent price comparisons; product clauses and alternatives keep their scope. */
export function conflictingPriceBounds(text:string):boolean {
 const matches=[...text.toLowerCase().matchAll(new RegExp(languageValue<string>('entities.p.value.1')+comparisonPhrasePattern()+languageValue<string>('entities.p.value.2')+capturedPriceAmount(),'g'))];
 for(let i=1;i<matches.length;i++){
  const a=matches[i-1],b=matches[i];
  if(text.slice(a.index!+a[0].length,b.index).trim().toLowerCase()!=='and')continue;
  const bounds=[a,b].map(m=>({op:comparisonOperator(m[1]),value:Number(m[3].replaceAll(',','')),currency:priceCurrency(m[2]||m[4])}));
  if(bounds[0].currency&&bounds[1].currency&&bounds[0].currency!==bounds[1].currency)continue;
  let low=-Infinity,high=Infinity,lowOpen=false,highOpen=false;
  for(const {op,value} of bounds){
   if(op==='>'||op==='>='||op==='='){if(value>low){low=value;lowOpen=op==='>';}else if(value===low)lowOpen ||= op==='>';}
   if(op==='<'||op==='<='||op==='='){if(value<high){high=value;highOpen=op==='<';}else if(value===high)highOpen ||= op==='<';}
  }
  if(low>high||low===high&&(lowOpen||highOpen))return true;
 }
 return false;
}
