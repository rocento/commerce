import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {quantityPrefix} from './quantities.ts';
import {normalize} from './normalize.ts';
import {capturedPriceAmount,priceCurrency} from './price-language.ts';
import {comparisonOperator,comparisonPhrasePattern} from './comparison-operators.ts';
import type {Alias} from './types.ts';
export function extract(text:string,aliases:Alias[]) {
 const entities:Record<string,any>={};const excluded:Record<string,string[]>={};
 const padded=' '+text+' ';
 const categoryAlias=aliases.filter(a=>a.type==='CATEGORY').sort((a,b)=>b.alias.length-a.alias.length).find(a=>padded.includes(' '+normalize(a.alias)+' '));
 const categoryTerm=categoryAlias?normalize(categoryAlias.alias):'';
 const categoryPosition=categoryAlias?padded.indexOf(' '+categoryTerm+' '):-1;
 for(const a of [...aliases].sort((a,b)=>b.alias.length-a.alias.length)) {
  const term=normalize(a.alias),pos=padded.indexOf(' '+term+' '); if(pos<0)continue;
  // A word inside a category name (green tea, denim jeans) is not an extra requested filter.
  if(a.type!=='CATEGORY'&&categoryPosition>=0&&pos>=categoryPosition&&pos+term.length<=categoryPosition+categoryTerm.length)continue;
  const key=a.type.toLowerCase();const preceding=padded.slice(Math.max(0,pos-12),pos);
  if(languagePattern('entities.extract.pattern.1').test(preceding)){(excluded[key]??=[]).push(a.value);continue;}
  if(entities[key]===undefined)entities[key]=a.value;
 }
 // Metallic words can be colors or materials. Use the mentioned category's industry.
 if(entities.color&&entities.color===entities.material){
  const category=aliases.find(a=>a.type==='CATEGORY'&&a.value===entities.category);
  if(category?.industry==='JEWELRY'||text.includes(languageValue<string>('entities.extract.value.1')+entities.material))delete entities.color;else delete entities.material;
 }
 if(Object.keys(excluded).length)entities.excluded=excluded;
 const q=languagePattern('entities.q.pattern.1').exec(text);
 const counted=q?quantityPrefix(q[1].split(' ')):undefined;
 const quantityStart=q?q.index+q[0].length-q[1].length:-1;
 const quantityEnd=q&&counted?quantityStart+q[1].split(' ').slice(0,counted.end).join(' ').length:-1;
 const money=capturedPriceAmount();
 const range=new RegExp(languageValue<string>('entities.range.value.1')+money+languageValue<string>('entities.range.value.2')+money).exec(text);
 const p=[...text.matchAll(new RegExp(languageValue<string>('entities.p.value.1')+comparisonPhrasePattern()+languageValue<string>('entities.p.value.2')+money,'g'))].find(match=>{
  // The existing cart quantity grammar owns "exactly 3" in "add exactly 3
  // mugs". Currency-bearing amounts and later price bounds keep their scope.
  const quantity=counted?.quantity!==undefined||counted?.quantityRange!==undefined;
  return !quantity||comparisonOperator(match[1])!=='='||match[2]||match[4]||match.index<quantityStart||match.index+match[0].length>quantityEnd;
 });
 const num=(s:string)=>Number(s.replaceAll(',',''));
 const currency=priceCurrency(range?(range[1]||range[3]||range[4]||range[6]):p?(p[2]||p[4]):undefined);
 if(range)entities.price={operator:'BETWEEN',min:num(range[2]),max:num(range[5]),...(currency?{currency}:{})};
 else if(p)entities.price={operator:comparisonOperator(p[1]),value:num(p[3]),...(currency?{currency}:{})};
 else {const m=languagePattern('entities.m.pattern.1').exec(text);if(m)entities.price={operator:'=',value:num(m[2]),currency:priceCurrency(m[1])};}
 const curr=languagePattern('entities.curr.pattern.1').exec(text);if(curr){entities.currency=curr[1].toUpperCase();if(entities.price&&!entities.price.currency)entities.price.currency=entities.currency;}
 const size=languagePattern('entities.size.pattern.1').exec(text);if(size)entities.size=size[1];
 if(counted){if(counted.quantity!==undefined)entities.quantity=counted.quantity;if(counted.quantityRange)entities.quantityRange=counted.quantityRange;}
 const ord=languagePattern('entities.ord.pattern.1').exec(text);if(ord)entities.ordinal=(languageValue<{ first: number; second: number; third: number; last: number; }>('entities.extract.value.2') as Record<string,number>)[ord[1]];
 const ref=languagePattern('entities.ref.pattern.1').exec(text);
 // A number before a product is a quantity, not an existing-order identity.
 if(ref && (ref[1] || !text.slice(ref.index+ref[0].length).trim() || languagePattern('entities.extract.pattern.2').test(text.slice(0,ref.index))))entities.order_reference=ref[2];
 const promo=languagePattern('entities.promo.pattern.1').exec(text);if(promo)entities.promotion_code=promo[1].toUpperCase();
 const date=languagePattern('entities.date.pattern.1').exec(text);if(date)entities[languagePattern('entities.extract.pattern.3').test(text)?'delivery_date':'date']=date[1];
 const time=languagePattern('entities.time.pattern.1').exec(text);if(time)entities.time=time[1];
 const slot=languagePattern('entities.slot.pattern.1').exec(text);if(slot)entities.delivery_slot=slot[1];
 if(languagePattern('entities.extract.pattern.4').test(text))entities.product_reference='CURRENT';
 const orderSelection=languagePattern('entities.orderSelection.pattern.1').exec(text);
 if(orderSelection){
  entities.orderSelection=languageValue<string[]>('entities.extract.value.3').includes(orderSelection[1])?'LATEST':languageValue<string[]>('entities.extract.value.4').includes(orderSelection[1])?'PREVIOUS':orderSelection[1]===languageValue<string>('entities.canonical.value.1')?'SAME':'CURRENT';
  if(languagePattern('entities.extract.pattern.5').test(text)&&!text.includes(languageValue<string>('entities.extract.value.5')))delete entities.product_reference;
 }
 return entities;
}
