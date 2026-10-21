import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** English, merchant-independent concepts. Add nodes/aliases here, not parser branches. */
export type ProductConcept = {
  id: string;
  name: string;
  parent?: string;
  kind: 'industry' | 'category' | 'product';
  aliases?: readonly string[];
};
export const productConcepts = ():readonly ProductConcept[]=>recognitionMemo('product-concepts.productConcepts',()=>(languageValue<({ id: string; name: string; kind: "industry"; } | { id: string; name: string; parent: string; kind: "category"; } | { id: string; name: string; parent: string; kind: "product"; aliases: string[]; } | { id: string; name: string; parent: string; kind: "product"; })[]>('product-concepts.productConcepts.value.1')));

export const packageUnits = ():Readonly<Record<string,string>>=>recognitionMemo('product-concepts.packageUnits',()=>(languageValue<Readonly<Record<string,string>>>('product-concepts.packageUnits.value.1')));
