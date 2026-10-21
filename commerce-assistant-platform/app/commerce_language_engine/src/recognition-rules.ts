/** Release-scoped declarative recognition data. Never executes stored JavaScript. */
import {AsyncLocalStorage} from 'node:async_hooks';
import contract from './generated/recognition-contract.json' with {type:'json'};
export type RecognitionEntry = {kind:'value';value:unknown}|{kind:'pattern';source:string;flags:string}|{kind:'template';parts:string[]};
export type RecognitionRules = {schemaVersion:1;language:string;revision:number;entries:Record<string,RecognitionEntry>};
export type RecognitionRuntime = {rules:RecognitionRules;patterns:Map<string,RegExp>;memo:Map<string,unknown>};
const active=new AsyncLocalStorage<RecognitionRuntime>();
type ValueShape={type:string;items?:ValueShape[];values?:ValueShape;properties?:Record<string,ValueShape>};
function validValue(value:unknown,shape:ValueShape,depth=0):boolean {
 if(depth>24)return false;
 if(shape.type==='null')return value===null;
 if(shape.type==='string')return typeof value==='string'&&value.length<=64000;
 if(shape.type==='number')return typeof value==='number'&&Number.isFinite(value);
 if(shape.type==='boolean')return typeof value==='boolean';
 if(shape.type==='array')return Array.isArray(value)&&value.length<=10000&&value.every(v=>(shape.items??[]).some(s=>validValue(v,s,depth+1)));
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const object=value as Record<string,unknown>;
 if(Object.keys(object).some(k=>['__proto__','constructor','prototype'].includes(k)))return false;
 if(shape.type==='record')return Object.values(object).every(v=>validValue(v,shape.values!,depth+1));
 return Object.entries(shape.properties??{}).every(([k,s])=>Object.hasOwn(object,k)&&validValue(object[k],s,depth+1));
}
function freeze(value:unknown):void {if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}}

export function compileRecognitionRules(input:RecognitionRules|undefined):RecognitionRuntime {
 if(!input||input.schemaVersion!==1||typeof input.language!=='string'||!input.language.trim()||!Number.isSafeInteger(input.revision)||input.revision<1||!input.entries||typeof input.entries!=='object'||Array.isArray(input.entries))throw new Error('A complete versioned recognition rule set is required; upgrade the dictionary before publishing');
 const rules=structuredClone(input),patterns=new Map<string,RegExp>();
 for(const [key,expected] of Object.entries(contract)){
  const rule=rules.entries[key];if(!rule||rule.kind!==expected.kind)throw new Error('Missing or incompatible recognition rule: '+key);
  if(rule.kind==='pattern'){
   if(typeof rule.source!=='string'||rule.source.length>16000||typeof rule.flags!=='string'||!/^[dgimsuvy]*$/.test(rule.flags))throw new Error('Invalid recognition pattern: '+key);
   try{
    const pattern=new RegExp(rule.source,rule.flags);
    const captures=new RegExp('(?:'+rule.source+')|',rule.flags.replace(/[gy]/g,'')).exec('')!.length-1;
    if('captures' in expected&&captures!==expected.captures||'requiresGlobal' in expected&&expected.requiresGlobal&&!rule.flags.includes('g'))throw new Error('Capture/global contract changed');
    patterns.set(key,pattern);
   }catch{throw new Error('Invalid recognition pattern or capture contract: '+key);}
  }else if(rule.kind==='template'){
   if(!Array.isArray(rule.parts)||rule.parts.length!==('arity' in expected?expected.arity:0)+1||rule.parts.some(p=>typeof p!=='string'||p.length>16000))throw new Error('Invalid recognition template: '+key);
  }else {
   if(!Object.hasOwn(rule,'value')||!('valueShape' in expected)||!validValue(rule.value,expected.valueShape as ValueShape))throw new Error('Invalid recognition value: '+key);
   if('fragmentCaptures' in expected){try{if(new RegExp('(?:'+String(rule.value)+')|').exec('')!.length-1!==expected.fragmentCaptures)throw new Error('Capture contract changed');}catch{throw new Error('Invalid recognition fragment or capture contract: '+key);}}
  }
 }
 freeze(rules);
 return {rules,patterns,memo:new Map()};
}
export function withRecognitionRules<T>(runtime:RecognitionRuntime,run:()=>T):T{return active.run(runtime,run);}
/** Explicit ambient context for authoring tools and isolated parser tests. */
export function enterRecognitionRules(runtime:RecognitionRuntime):void {active.enterWith(runtime);}
function current():RecognitionRuntime {const runtime=active.getStore();if(!runtime)throw new Error('Recognition requires an explicit dictionary rule context');return runtime;}
export function languageValue<T>(key:string):T {
 const entry=current().rules.entries[key];if(!entry||entry.kind!=='value')throw new Error('Unknown recognition value: '+key);
 const value=entry.value;
 if(value===null||typeof value!=='object')return value as T;
 const primitive=(item:unknown)=>item===null||typeof item!=='object';
 if(Array.isArray(value)&&value.every(primitive))return value.slice() as T;
 if(!Array.isArray(value)&&Object.values(value).every(primitive))return {...value} as T;
 return structuredClone(value) as T;
}
export function languagePattern(key:string):RegExp {
 const pattern=current().patterns.get(key);if(!pattern)throw new Error('Unknown recognition pattern: '+key);
 // Fresh state preserves literal RegExp behavior for global/sticky expressions.
 return new RegExp(pattern);
}
export function languageTemplate(key:string,values:unknown[]):string {
 const entry=current().rules.entries[key];if(!entry||entry.kind!=='template'||entry.parts.length!==values.length+1)throw new Error('Unknown or incompatible recognition template: '+key);
 return entry.parts.map((part,index)=>part+(index<values.length?String(values[index]):'')).join('');
}
/** Derived indexes are isolated by compiled release, never by process-wide state. */
export function recognitionMemo<T>(key:string,build:()=>T):T {const runtime=current();if(!runtime.memo.has(key))runtime.memo.set(key,build());return runtime.memo.get(key) as T;}
const contexts=new WeakMap<RecognitionRules,RecognitionRuntime>();
/** Public dictionary APIs bind their own release, including authoring/import paths. */
export function withDictionaryRecognition<T>(dictionary:{recognitionRules?:RecognitionRules},run:()=>T):T {
 const rules=dictionary.recognitionRules;
 if(!rules)throw new Error('Dictionary recognition rules are required');
 const existing=active.getStore();if(existing?.rules===rules)return run();
 let runtime=Object.isFrozen(rules)?contexts.get(rules):undefined;
 if(!runtime){runtime=compileRecognitionRules(rules);if(Object.isFrozen(rules))contexts.set(rules,runtime);}
 return withRecognitionRules(runtime,run);
}
