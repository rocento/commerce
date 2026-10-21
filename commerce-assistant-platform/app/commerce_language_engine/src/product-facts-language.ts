import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Whole-request product questions carry names, never inferred product facts. */
export function productFactRead(message: string): {intent: string; entities: Record<string, any>} | undefined {
 const text=message.trim().replace(languagePattern('product-facts-language.text.pattern.1'),'').replace(languagePattern('product-facts-language.text.pattern.2'),'').trim();
 if(!text||text.length>400||languagePattern('product-facts-language.productFactRead.pattern.1').test(text)||languagePattern('product-facts-language.productFactRead.pattern.2').test(text))return;
 const facts:Record<string,string>=languageValue<Record<string,string>>('product-facts-language.facts.value.1');
 // Whole duration and sizing questions request a known product field. They
 // carry a current-product reference; catalog facts are still read downstream.
 if(languagePattern('product-facts-language.productFactRead.pattern.3').test(text)
  || languagePattern('product-facts-language.productFactRead.pattern.4').test(text))return languageValue<{ intent: string; entities: { product_reference: string; }; }>('product-facts-language.productFactRead.value.1');
 if(languagePattern('product-facts-language.productFactRead.pattern.5').test(text))return languageValue<{ intent: string; entities: { product_reference: string; }; }>('product-facts-language.productFactRead.value.2');
 const names=Object.keys(facts).sort((a,b)=>b.length-a.length).join('|');
 const patterns:[RegExp,(match:RegExpExecArray)=>[string,string]][]=[
  [new RegExp(languageTemplate('product-facts-language.patterns.template.1', [names]),'i'),m=>[m[1],m[2]]],
  [new RegExp(languageTemplate('product-facts-language.patterns.template.2', [names]),'i'),m=>[m[1],languageValue<string>('product-facts-language.patterns.value.1')]],
  [new RegExp(languageTemplate('product-facts-language.patterns.template.3', [names]),'i'),m=>[m[1],m[2]]],
  [languagePattern('product-facts-language.patterns.pattern.1'),m=>[languageValue<string>('product-facts-language.patterns.value.2'),m[1]]],
  [languagePattern('product-facts-language.patterns.pattern.2'),m=>[languageValue<string>('product-facts-language.patterns.value.3'),m[1]]],
  [languagePattern('product-facts-language.patterns.pattern.3'),m=>[languageValue<string>('product-facts-language.patterns.value.4'),m[1]]],
  [languagePattern('product-facts-language.patterns.pattern.4'),m=>[languageValue<string>('product-facts-language.patterns.value.5'),m[1]]],
  [languagePattern('product-facts-language.patterns.pattern.5'),m=>[languageValue<string>('product-facts-language.patterns.value.6'),m[1]]],
  [languagePattern('product-facts-language.patterns.pattern.6'),m=>[m[2],m[1]]],
 ];
 for(const [pattern,parts] of patterns){
  const match=pattern.exec(text);if(!match)continue;
  const [field,raw]=parts(match);const intent=facts[field.toLowerCase()];if(!intent)continue;
  const product=raw.trim().replace(languagePattern('product-facts-language.product.pattern.1'),'');
  if(!product||languagePattern('product-facts-language.productFactRead.pattern.6').test(product)||product.length>160||!languagePattern('product-facts-language.productFactRead.pattern.7').test(product)||languagePattern('product-facts-language.productFactRead.pattern.8').test(product)||languagePattern('product-facts-language.productFactRead.pattern.9').test(product))return;
  const reference=languagePattern('product-facts-language.reference.pattern.1').test(product);
  return {intent,entities:reference?{product_reference:'CURRENT'}:{productText:product}};
 }
}
