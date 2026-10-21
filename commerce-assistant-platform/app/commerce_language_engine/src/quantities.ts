import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {packageUnits} from './product-concepts.ts';
import {normalize} from './normalize.ts';
// Number syntax belongs to slot extraction, not a sentence lookup dictionary.
const numbers=():Record<string,number>=>recognitionMemo('quantities.numbers',()=>(languageValue<Record<string,number>>('quantities.numbers.value.1')));
export function readNumber(tokens:string[],start=0):{value:number;end:number}|null {
 const word=tokens[start];if(!word)return null;
 // Retain invalid numeric quantities for the existing slot validators. Treating
 // them as absent would turn "-7 apples" into a product name with default quantity.
 // Match the complete token so numeric model names such as 3.5mm stay untouched.
 if(languagePattern('quantities.readNumber.pattern.1').test(word)){
  const value=Number(word);return Number.isFinite(value)?{value,end:start+1}:null;
 }
 if(word.includes('-')){const parts=word.split('-');if(parts.length===2&&numbers()[parts[0]]>=20&&numbers()[parts[1]]<10)return {value:numbers()[parts[0]]+numbers()[parts[1]],end:start+1};}
 if(word===languageValue<string>('quantities.readNumber.value.1'))return {value:12,end:start+1};
 if(numbers()[word]===undefined)return null;
 let value=numbers()[word],end=start+1;
 if(tokens[end]===languageValue<string>('quantities.readNumber.value.2')&&value>=1&&value<=9){value*=100;end++;if(tokens[end]===languageValue<string>('quantities.readNumber.value.3'))end++;const remainder=readNumber(tokens,end);if(remainder&&remainder.value<100){value+=remainder.value;end=remainder.end;}}
 else if(value>=20&&value%10===0&&numbers()[tokens[end]]>0&&numbers()[tokens[end]]<10){value+=numbers()[tokens[end]];end++;}
 if(tokens[end]===languageValue<string>('quantities.readNumber.value.4')){value*=12;end++;}
 return {value,end};
}
export function quotedNumericProduct(text:string):boolean {
 return languagePattern('quantities.quotedNumericProduct.pattern.1').test(text);
}
export function quantityPrefix(tokens:string[]) {
 let start=0;let selection:string|undefined;
 while(languageValue<string[]>('quantities.quantityPrefix.value.1').includes(tokens[start])){if(tokens[start]===languageValue<string>('quantities.quantityPrefix.value.2'))selection='ANY_MATCHING';start++;}
 if(tokens[start]===languageValue<string>('quantities.quantityPrefix.value.3')&&tokens[start+1]===languageValue<string>('quantities.quantityPrefix.value.4')&&tokens[start+2]===languageValue<string>('quantities.quantityPrefix.value.5'))return {quantity:2,end:start+3,selection};
 if(tokens[start]===languageValue<string>('quantities.quantityPrefix.value.6')&&tokens[start+1]===languageValue<string>('quantities.quantityPrefix.value.7')&&tokens[start+2]===languageValue<string>('quantities.quantityPrefix.value.8'))return {quantity:2,end:start+3,selection};
 if(tokens[start]===languageValue<string>('quantities.quantityPrefix.value.9')&&tokens[start+1]===languageValue<string>('quantities.quantityPrefix.value.10')&&tokens[start+2]===languageValue<string>('quantities.quantityPrefix.value.11'))return {quantity:6,end:start+3,selection};
 if(tokens[start]===languageValue<string>('quantities.quantityPrefix.value.12')&&tokens[start+1]===languageValue<string>('quantities.quantityPrefix.value.13'))return {quantity:12,end:start+2,selection};
 const number=readNumber(tokens,start);
 if(number){
  const second=languageValue<string[]>('quantities.second.value.1').includes(tokens[number.end])?readNumber(tokens,number.end+1):null;
  if(second)return {quantityRange:{min:Math.min(number.value,second.value),max:Math.max(number.value,second.value)},end:second.end,selection};
  return {quantity:number.value,end:number.end,selection};
 }
 if(languageValue<string[]>('quantities.quantityPrefix.value.14').includes(tokens[start]))return {quantity:1,end:start+1,selection};
 return {end:start,selection};
}

/** Existing cart grammar can retain a single explicit packaged-item clause. */
export function packagedQuantity(text:string):{quantity:number;unit:string;size?:string}|undefined {
  const tokens=normalize(text).split(' ');const parsed=quantityPrefix(tokens);
  if(parsed.quantity===undefined||parsed.quantityRange)return;
  let end=parsed.end;const size=languageValue<string[]>('quantities.size.value.1').includes(tokens[end])?tokens[end++]:undefined;
  const unit=packageUnits()[tokens[end]];
  if(!unit||tokens.length<=end+1)return;
  return {quantity:parsed.quantity,unit,...(size?{size}:{})};
}
