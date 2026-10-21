import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
// Whole-value English grammar for search corrections. Cart quantity parsing is
// deliberately separate: a partially consumed number must never become an edit.
import {currencyNames} from './price-language.ts';
import {comparisonPhrasePattern} from './comparison-operators.ts';
const small=():Record<string,number>=>recognitionMemo('correction-numbers.small',()=>(Object.assign(Object.create(null),languageValue<Record<string,number>>('correction-numbers.small.value.1'))));
const tens=():Record<string,number>=>recognitionMemo('correction-numbers.tens',()=>(Object.assign(Object.create(null),languageValue<Record<string,number>>('correction-numbers.tens.value.1'))));

function belowHundred(words:string[]):number|undefined {
 if(words.length===1)return small()[words[0]]??tens()[words[0]];
 if(words.length===2&&tens()[words[0]]&&small()[words[1]]>0&&small()[words[1]]<10)return tens()[words[0]]+small()[words[1]];
}
function belowThousand(words:string[]):number|undefined {
 if(words[1]!==languageValue<string>('correction-numbers.belowThousand.value.1'))return belowHundred(words);
 const multiplier=words[0]===languageValue<string>('correction-numbers.multiplier.value.1')?1:small()[words[0]];
 if(!multiplier||multiplier>9)return;
 let rest=words.slice(2);
 if(!rest.length)return multiplier*100;
 if(rest[0]===languageValue<string>('correction-numbers.lexical.value.1'))rest=rest.slice(1);
 const remainder=belowHundred(rest);
 if(remainder!==undefined&&remainder>0)return multiplier*100+remainder;
}
function integer(text:string):number|undefined {
 if(languagePattern('correction-numbers.integer.pattern.1').test(text)){
  const value=Number(text.replaceAll(',',''));return Number.isSafeInteger(value)?value:undefined;
 }
 // Hyphens join tens and units only; malformed signs/scales are not normalized away.
 if(languagePattern('correction-numbers.integer.pattern.2').test(text)&&text.split(languagePattern('correction-numbers.integer.pattern.3')).some(w=>w.includes('-')&&!languagePattern('correction-numbers.integer.pattern.4').test(w)))return;
 let words=text.replaceAll('-',' ').split(languagePattern('correction-numbers.words.pattern.1')),value=0,lastScale=Infinity;
 for(;;){
  const at=words.findIndex(w=>w===languageValue<string>('correction-numbers.lexical.value.2')||w===languageValue<string>('correction-numbers.lexical.value.3'));
  if(at<0)break;
  const scale=words[at]===languageValue<string>('correction-numbers.scale.value.1')?1000000:1000;
  const part=words.slice(0,at),group=part.length===1&&part[0]===languageValue<string>('correction-numbers.lexical.value.4')?1:belowThousand(part);
  if(group===undefined||group===0||scale>=lastScale)return;
  value+=group*scale;lastScale=scale;words=words.slice(at+1);
  if(!words.length)return value;
  if(words[0]===languageValue<string>('correction-numbers.integer.value.1')){
   words=words.slice(1);
   // "and" introduces the final remainder, never another scale group.
   if(!words.length||words.some(w=>w===languageValue<string>('correction-numbers.lexical.value.5')||w===languageValue<string>('correction-numbers.lexical.value.6')))return;
  }
 }
 const rest=belowThousand(words);
 if(rest!==undefined&&(value===0||rest>0))return value+rest;
}

/** Decimal text, without binary floating-point addition of currency fractions. */
function decimal(text:string):string|undefined {
 if(languagePattern('correction-numbers.decimal.pattern.1').test(text))return text.replaceAll(',','');
 const parts=text.split(' point ');
 if(parts.length>2)return;
 const whole=integer(parts[0]);if(whole===undefined)return;
 if(parts.length===1)return String(whole);
 const digits=parts[1].split(languagePattern('correction-numbers.digits.pattern.1')).map(w=>languagePattern('correction-numbers.digits.pattern.2').test(w)?w:small()[w]!==undefined&&small()[w]<10?String(small()[w]):'');
 if(!digits.length||digits.length>6||digits.some(d=>!d))return;
 return whole+'.'+digits.join('');
}

export function correctionQuantity(text:string):number|undefined {
 let value:number|undefined;
 const source=text.toLowerCase().trim().replace(languagePattern('correction-numbers.source.pattern.1'),' ').replace(languagePattern('correction-numbers.source.pattern.2'),'');
 if(languagePattern('correction-numbers.correctionQuantity.pattern.1').test(source))value=2;
 else if(source===languageValue<string>('correction-numbers.canonical.value.1'))value=6;
 else if(source===languageValue<string>('correction-numbers.canonical.value.2')||source===languageValue<string>('correction-numbers.canonical.value.3'))value=12;
 else if(source.endsWith(languageValue<string>('correction-numbers.correctionQuantity.value.1'))){const count=integer(source.slice(0,-6));if(count!==undefined)value=count*12;}
 else value=integer(source);
 return value!==undefined&&Number.isSafeInteger(value)&&value>0&&value<=1000000?value:undefined;
}

const currencies=():Record<string,string>=>recognitionMemo('correction-numbers.currencies',()=>({
 ...currencyNames(),'$':'USD','€':'EUR','£':'GBP',
 // Preserve the existing correction-only shorthand contract.
 dollar:'USD',dollars:'USD',pound:'GBP',pounds:'GBP',
}));
const currencyWords=()=>recognitionMemo('correction-numbers.currencyWords',()=>(Object.keys(currencies()).sort((a,b)=>b.length-a.length).map(s=>s.replace(languagePattern('correction-numbers.currencyWords.pattern.1'),'\\$&')).join('|')));
type Amount={amount:string;currency?:string;symbol?:string};
function amount(text:string):Amount|undefined {
 let source=text.trim(),currency:string|undefined,minor:string|undefined;
 const fractionAt=source.lastIndexOf(' and ');
 const fraction=fractionAt>=0?languagePattern('correction-numbers.fraction.pattern.1').exec(source.slice(fractionAt+5)):null;
 if(fraction){minor=fraction[1];source=source.slice(0,fractionAt);}
 const prefix=new RegExp('^('+currencyWords()+languageValue<string>('correction-numbers.prefix.value.1')).exec(source);
 if(prefix){currency=currencies()[prefix[1]];source=source.slice(prefix[0].length);}
 const suffix=new RegExp(languageValue<string>('correction-numbers.suffix.value.1')+currencyWords()+')$').exec(source);
 if(suffix){if(currency&&currency!==currencies()[suffix[1]])return;currency=currencies()[suffix[1]];source=source.slice(0,suffix.index);}
 let number=decimal(source.trim());if(number===undefined)return;
 if(minor!==undefined){
  const cents=integer(minor);
  const allowed=fraction![2].startsWith(languageValue<string>('correction-numbers.allowed.value.1'))?['USD','EUR','AUD','CAD']:['GBP'];
  if(!currency||!allowed.includes(currency)||number.includes('.')||cents===undefined||cents>99)return;
  number+='.'+String(cents).padStart(2,'0');
 }
 if(!Number.isFinite(Number(number))||Number(number)>1000000000)return;
 return {amount:number,...(currency?{currency}:{}),...(prefix&&languagePattern('correction-numbers.amount.pattern.1').test(prefix[1])?{symbol:prefix[1]}:{})};
}
const render=(value:Amount)=>`${value.symbol??(value.currency?value.currency+' ':'')}${value.amount}`;

export function correctionPrice(text:string):string|undefined {
 const source=text.toLowerCase().trim().replace(languagePattern('correction-numbers.source.pattern.3'),' ');
 if(source.startsWith(languageValue<string>('correction-numbers.correctionPrice.value.1'))){
  const body=source.slice(8),pairs:Amount[][]=[];
  for(const split of body.matchAll(languagePattern('correction-numbers.correctionPrice.pattern.1'))){
   const low=amount(body.slice(0,split.index)),high=amount(body.slice(split.index+split[0].length));
   if(low&&high)pairs.push([low,high]);
  }
  if(pairs.length!==1)return;
  const [low,high]=pairs[0];
  if(Number(low.amount)>Number(high.amount)||low.currency&&high.currency&&low.currency!==high.currency)return;
  const currency=low.currency??high.currency;
  return languageTemplate('correction-numbers.correctionPrice.template.1', [render({...low,currency}), render({...high,currency})]);
 }
 const match=new RegExp(languageValue<string>('correction-numbers.match.value.1')+comparisonPhrasePattern()+languageValue<string>('correction-numbers.match.value.2')).exec(source);
 if(!match)return;
 const value=amount(match[2]);
 if(value)return `${match[1].startsWith(languageValue<string>('correction-numbers.correctionPrice.value.2'))?languageValue<string>('correction-numbers.canonical.value.4'):match[1]} ${render(value)}`;
}
