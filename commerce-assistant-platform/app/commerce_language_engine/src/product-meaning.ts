import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Additive generic meaning. No catalog access and no changes to commerce authority. */
import {productConcepts,packageUnits,type ProductConcept} from './product-concepts.ts';
import {quantityPrefix,packagedQuantity} from './quantities.ts';
import {normalize} from './normalize.ts';
import {comparisonPhrasePattern} from './comparison-operators.ts';
import {priceAmount} from './price-language.ts';
import type {KnowledgeIndex} from './language-knowledge.ts';
import {lexicalConcept} from './lexical-knowledge.ts';

export type ProductMeaning = {
  action?: string;
  product_concept?: string;
  concept_id?: string;
  concept_path?: string[];
  industry?: string;
  category?: string;
  subcategory?: string;
  raw_product_text: string;
  quantity?: number;
  unit?: string;
  attributes?: Record<string,string>;
  price_preference?: 'low';
  price_constraint?: Record<string,unknown>;
};
const actionNames:Record<string,string>={PRODUCT_SEARCH:'catalog.search',PRODUCT_RECOMMEND:'catalog.recommend',PRODUCT_COMPARE:'catalog.compare',ADD_TO_CART:'cart.add',REMOVE_FROM_CART:'cart.remove',ADD_TO_WISHLIST:'wishlist.add'};
const escape=(value:string)=>value.replace(languagePattern('product-meaning.escape.pattern.1'),'\\$&');
const attributeBoundary=()=>recognitionMemo('product-meaning.attributeBoundary',()=>(languageValue<string>('product-meaning.attributeBoundary.value.1')));
const openAttribute=()=>recognitionMemo('product-meaning.openAttribute',()=>(new RegExp(languageValue<string>('product-meaning.openAttribute.value.1')+attributeBoundary()+'|(?:'+comparisonPhrasePattern()+languageValue<string>('product-meaning.openAttribute.value.2')+priceAmount()+')|$)','g')));

export function compileProductConcepts(nodes:readonly ProductConcept[]) {
  const byId=new Map(nodes.map(node=>[node.id,node]));
  if(byId.size!==nodes.length)throw new Error('Duplicate product concept ID');
  const entries:{concept:ProductConcept;path:ProductConcept[];alias:string}[]=[];
  const aliases=new Map<string,string>();
  for(const node of nodes){
    const path:ProductConcept[]=[];let current:ProductConcept|undefined=node;
    while(current){
      if(path.some(parent=>parent.id===current!.id))throw new Error('Product concept cycle');
      path.unshift(current);
      if(current.parent&&!byId.has(current.parent))throw new Error('Unknown product concept parent');
      current=current.parent?byId.get(current.parent):undefined;
    }
    if(node.kind!=='product')continue;
    for(const value of new Set([node.name,...node.aliases??[]])){
      const alias=normalize(value);
      if(!alias||!languagePattern('product-meaning.compileProductConcepts.pattern.1').test(alias))throw new Error('Product concepts require generic English aliases');
      if(aliases.has(alias)&&aliases.get(alias)!==node.id)throw new Error(languageValue<string>('product-meaning.compileProductConcepts.value.1')+alias);
      aliases.set(alias,node.id);entries.push({concept:node,path,alias});
    }
  }
  return entries.sort((a,b)=>b.alias.split(' ').length-a.alias.split(' ').length||b.path.length-a.path.length||b.alias.length-a.alias.length);
}
const compiledConcepts=()=>recognitionMemo('product-meaning.compiledConcepts',()=>(compileProductConcepts(productConcepts())));

export function productMeaning(raw:string,intent?:string|null,entities:Record<string,unknown>={},concepts=compiledConcepts(),detailsText=raw,knowledge?:KnowledgeIndex):ProductMeaning|undefined {
  // English-only annotation; do not partially reinterpret a mixed-language request.
  if(languagePattern('product-meaning.productMeaning.pattern.1').test(raw))return;
  const normalized=normalize(raw);
  const quantity=quantityPrefix(normalized.split(' '));
  const words=normalized.split(' '),unit=lexicalConcept(knowledge,'unit',words[quantity.end]??'');
  let nounStart=quantity.end;
  if(unit?.metadata?.unitKind==='package'){nounStart++;if(words[nounStart]===languageValue<string>('product-meaning.productMeaning.value.1'))nounStart++;}
  const noun=words.slice(nounStart).join(' ');
  const lexical=lexicalConcept(knowledge,'product',noun)??lexicalConcept(knowledge,'product',normalized);
  const hits=concepts.flatMap(entry=>{
    const match=new RegExp(languageValue<string>('product-meaning.match.value.1')+escape(entry.alias)+languageValue<string>('product-meaning.match.value.2')).exec(normalized);
    return match?[{...entry,start:match.index,end:match.index+match[0].length}]:[];
  });
  const selected=hits.filter(hit=>!hits.some(other=>other!==hit&&other.start<=hit.start&&other.end>=hit.end&&(other.end-other.start>hit.end-hit.start||other.path.length>hit.path.length)));
  const ids=new Set(selected.map(hit=>hit.concept.id));
  // Do not collapse two different products into one concept.
  let hit=ids.size===1?selected[0]:undefined;
  // A complete reviewed noun such as "coffee urn" is more specific than an
  // embedded generic "coffee" annotation. This never changes entity authority.
  if(lexical&&hit&&noun.split(' ').length>hit.alias.split(' ').length)hit=undefined;
  if(!hit&&!intent&&!lexical)return;
  const meaning:ProductMeaning={...(intent&&actionNames[intent]?{action:actionNames[intent]}:{}),raw_product_text:raw};
  if(hit){
    const industry=hit.path.find(node=>node.kind==='industry');
    const category=hit.path.find(node=>node.kind==='category');
    const parent=hit.path.at(-2);
    Object.assign(meaning,{product_concept:hit.concept.name,concept_id:hit.concept.id,concept_path:hit.path.map(node=>node.name),...(industry?{industry:industry.name}:{}),...(category?{category:category.name}:{}),...(parent?.kind==='product'?{subcategory:parent.name}:{})});
  }
  if(!hit&&lexical)Object.assign(meaning,{product_concept:lexical.canonical,concept_id:lexical.id,concept_path:[lexical.canonical]});
  if((quantity.quantity!==undefined||typeof entities.quantity==='number')&&unit?.metadata?.unitKind==='package')meaning.unit=unit.canonical;
  if(quantity.quantity!==undefined&&!quantity.quantityRange)meaning.quantity=quantity.quantity;
  if(typeof entities.quantity==='number')meaning.quantity=entities.quantity;
  const packaging=packagedQuantity(raw)??(meaning.quantity!==undefined?packagedQuantity(`${meaning.quantity} ${raw}`):undefined);
  if(packaging){meaning.quantity=packaging.quantity;meaning.unit=packaging.unit;}
  else {const first=normalized.split(' ')[0];if(packageUnits()[first]&&normalized.includes(languageValue<string>('product-meaning.productMeaning.value.2')))meaning.unit=packageUnits()[first];}
  const attributes:Record<string,string>={};
  // Ignore color/material words that belong to the concept itself (e.g. green tea).
  for(const key of languageValue<string[]>('product-meaning.productMeaning.value.3')){
    const value=entities[key];
    const productWords=(hit?.alias??(lexical?noun:'')).split(' ');
    if(typeof value==='string'&&!productWords.includes(normalize(value)))attributes[key]=value;
  }
  if(packaging?.size)attributes.size=packaging.size;
  const details=normalize(detailsText);
  const outside=hit?details.replace(new RegExp(languageValue<string>('product-meaning.outside.value.1')+escape(hit.alias)+languageValue<string>('product-meaning.outside.value.2'),'g'),' '):details;
  const size=languagePattern('product-meaning.size.pattern.1').exec(outside);if(size)attributes.size=size[1];
  const color=languagePattern('product-meaning.color.pattern.1').exec(outside);if(color&&!attributes.color)attributes.color=color[1];
  // Open values use attribute labels, not global merchant value dictionaries.
  for(const match of outside.matchAll(openAttribute())){
    if(match[1]===languageValue<string>('product-meaning.productMeaning.value.5')&&languagePattern('product-meaning.productMeaning.pattern.2').test(outside.slice(0,match.index)))continue;
    const key=match[1].replace(languageValue<string>('product-meaning.key.value.1'),languageValue<string>('product-meaning.key.value.2')).replace(languageValue<string>('product-meaning.key.value.3'),languageValue<string>('product-meaning.key.value.4'));attributes[key]=match[2].replace(languagePattern('product-meaning.productMeaning.pattern.3'),'').trim();
  }
  for(const match of outside.matchAll(languagePattern('product-meaning.productMeaning.pattern.4')))attributes[languagePattern('product-meaning.productMeaning.pattern.5').test(match[2])?'weight':'volume']=`${match[1]} ${match[2]}`;
  // Keep labeled measurements literal; unit conversion, tolerances and product
  // compliance belong to catalog verification, never this lexical annotation.
  for(const match of outside.matchAll(languagePattern('product-meaning.productMeaning.pattern.6'))){
   const dimension=lexicalConcept(knowledge,'dimension',match[1]),measure=lexicalConcept(knowledge,'unit',match[3]);
   if(dimension&&measure?.metadata?.unitKind==='measure'&&dimension.metadata?.dimension===measure.metadata?.dimension)attributes[dimension.canonical]=match[2]+' '+match[3];
  }
  const pack=languagePattern('product-meaning.pack.pattern.1').exec(outside);if(pack)attributes.pack_size=pack[1];
  if(Object.keys(attributes).length)meaning.attributes=attributes;
  if(languagePattern('product-meaning.productMeaning.pattern.7').test(outside))meaning.price_preference='low';
  if(entities.price&&typeof entities.price==='object'&&!Array.isArray(entities.price))meaning.price_constraint={...entities.price};
  return meaning;
}
