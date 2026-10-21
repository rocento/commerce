import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import type {Dictionary} from './types.ts';

export const attributeNames=()=>recognitionMemo('search-attributes.attributeNames',()=>(languageValue<string>('search-attributes.attributeNames.value.1')));
export type SearchAttribute='color'|'brand'|'size'|'material'|'flavor';
export type SearchAttributes=Record<string,string>;
const fieldName=()=>recognitionMemo('search-attributes.fieldName',()=>(languageValue<string>('search-attributes.fieldName.value.1')));
export const attributeKey=(name:string):SearchAttribute=>(languageValue<Record<string,string>>('search-attributes.attributeKey.value.1')[name]??name) as SearchAttribute;

/** A labeled merchant value is linguistic data, never evidence of availability. */
export function attributeValue(dictionary:Dictionary,key:string,text:string):string|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 const value=text.trim().replace(languagePattern('search-attributes.value.pattern.1'),' ');
 if(!value||value.length>100||!languagePattern('search-attributes.attributeValue.pattern.1').test(value)||!languagePattern('search-attributes.attributeValue.pattern.2').test(value))return;
 const alias=dictionary.entity_terms.find(a=>a.type===key.toUpperCase()&&a.alias.toLowerCase()===value.toLowerCase());
 if(alias)return alias.value;
 // A longer clause cannot disappear into an open vocabulary field.
 if(languagePattern('search-attributes.attributeValue.pattern.3').test(value)||(languagePattern('search-attributes.attributeValue.pattern.4').test(value)&&value.toLowerCase()!==languageValue<string>('search-attributes.attributeValue.value.1')))return;
 return value.toLowerCase();

 });
}

/** Canonical field suffixes survive stored-search replay without a dictionary alias. */
export function searchAttributes(dictionary:Dictionary,text:string):{coreText:string;fields:SearchAttributes;invalid:boolean}|undefined {
 return withDictionaryRecognition(dictionary,()=>{
 // Quoted product names retain their existing literal-search contract.
 if(languagePattern('search-attributes.searchAttributes.pattern.1').test(text))return;
 const first=new RegExp(languageValue<string>('search-attributes.first.value.1')+fieldName()+languageValue<string>('search-attributes.first.value.2'),'i').exec(text);
 if(!first)return;
 const fields:SearchAttributes=Object.create(null);let invalid=false;
 for(const clause of text.slice(first.index+1).split(',')){
  const match=new RegExp(languageValue<string>('search-attributes.match.value.1')+fieldName()+languageValue<string>('search-attributes.match.value.2'),'i').exec(clause);
  if(!match){invalid=true;continue;}
  const key=attributeKey(match[1].trim().toLowerCase().replace(languagePattern('search-attributes.key.pattern.1'),' ')),value=attributeValue(dictionary,key,match[2]);
  if(value===undefined||fields[key]!==undefined){invalid=true;continue;}
  fields[key]=value;
 }
 return {coreText:text.slice(0,first.index).trim(),fields,invalid:invalid||Object.keys(fields).length>10};

 });
}

export function attributeSuffix(fields:SearchAttributes):string {
 return Object.entries(fields).map(([key,value])=>`, ${key}: ${value}`).join('');
}
