import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
/** Bounded linguistic evidence. Suggestions never identify SKUs or authorize writes. */
import {normalize} from './normalize.ts';
import type {Compiled} from './compiler.ts';
export type TokenCorrection={start:number;end:number;tokenIndex:number;from:string;to:string};
export type CorrectionEvidence={start:number;end:number;original:string;candidate:string;accepted:boolean;source:'reviewed-command'|'compiled-read-command'|'protected-command'|'catalog-suggestion';distance:number;rankScore:number;reason:string};
export type CorrectionTrace={version:1;offsetUnit:'unicode-code-point';originalText:string;candidates:CorrectionEvidence[];truncated:boolean};
const wrappers=()=>recognitionMemo('language-corrections.wrappers',()=>(languageValue<string>('language-corrections.wrappers.value.1')));
const head=()=>recognitionMemo('language-corrections.head',()=>(new RegExp(languageTemplate('language-corrections.head.template.1', [wrappers()]),'i')));
const legacy=():Record<string,string>=>recognitionMemo('language-corrections.legacy',()=>(languageValue<Record<string,string>>('language-corrections.legacy.value.1')));
function tokenChange(text:string,start:number,from:string,to:string):TokenCorrection {
 const prefix=normalize(text.slice(0,start));return {start,end:start+from.length,tokenIndex:prefix?prefix.split(' ').length:0,from,to};
}
/** Preserve known informal heads without ever scanning an open product argument. */
export function scopedTokenCorrections(text:string):TokenCorrection[]{
 if(text.length>4000)return [];
 const changes:TokenCorrection[]=[];const match=head().exec(text);
 if(match&&legacy()[match[1].toLowerCase()])changes.push(tokenChange(text,match[0].length-match[1].length,match[1],legacy()[match[1].toLowerCase()]));
 // These are complete owned-order read/reference phrases, not generic noun replacements.
 const reference=new RegExp(languageTemplate('language-corrections.reference.template.1', [wrappers()]),'i');
 if(reference.test(text))for(const m of text.matchAll(languagePattern('language-corrections.scopedTokenCorrections.pattern.1')))changes.push(tokenChange(text,m.index!,m[0],m[1].toLowerCase()===languageValue<string>('language-corrections.lexical.value.1')?'my':'order'));
 return changes;
}
/** Damerau-Levenshtein for short tokens; bounded by caller length/candidate limits. */
export function editCost(a:string,b:string):number {
 if(a.length>24||b.length>24)return 25;
 const rows=Array.from({length:a.length+1},()=>Array<number>(b.length+1).fill(0));
 for(let i=0;i<=a.length;i++)rows[i][0]=i;for(let j=0;j<=b.length;j++)rows[0][j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
  rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+Number(a[i-1]!==b[j-1]));
  if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])rows[i][j]=Math.min(rows[i][j],rows[i-2][j-2]+1);
 }
 return rows[a.length][b.length];
}
const readWords=()=>recognitionMemo('language-corrections.readWords',()=>(languageValue<string[]>('language-corrections.readWords.value.1')));
const lexicalCache=()=>recognitionMemo('language-corrections.lexicalCache',()=>new WeakMap<Compiled,{known:Set<string>;reads:string[]}>());
function vocabulary(compiled:Compiled){
 let value=lexicalCache().get(compiled);if(value)return value;
 const known=new Set([...compiled.dictionary.groups.flatMap(g=>g.terms),...compiled.dictionary.entity_terms.map(t=>t.alias)].flatMap(t=>normalize(t).split(' ')));
 const actionWords=new Set(compiled.dictionary.groups.filter(g=>g.code.startsWith('ACTION_')).flatMap(g=>g.terms));
 value={known,reads:readWords().filter(word=>actionWords.has(word))};lexicalCache().set(compiled,value);return value;
}
export function evidence(text:string,change:Pick<TokenCorrection,'start'|'end'|'from'|'to'>,source:CorrectionEvidence['source'],accepted:boolean,reason:string):CorrectionEvidence {
 const distance=editCost(change.from.toLowerCase(),change.to);
 return {start:[...text.slice(0,change.start)].length,end:[...text.slice(0,change.end)].length,original:change.from,candidate:change.to,accepted,source,distance,rankScore:1/(1+distance),reason};
}
/** Internal scoped-catalog input is evidence only; never expose it as client context authority. */
export function correctionProposals(compiled:Compiled,text:string,catalogTerms:readonly string[]=[]):CorrectionTrace {
 const candidates:CorrectionEvidence[]=[];
 const trace:CorrectionTrace={version:1,offsetUnit:'unicode-code-point',originalText:text,candidates,truncated:false};
 if(text.length>4000||text.split(languagePattern('language-corrections.correctionProposals.pattern.1')).length>128){trace.truncated=true;return trace;}
 const match=head().exec(text);if(!match)return trace;
 const word=match[1].toLowerCase(),start=match[0].length-match[1].length;
 if(word===languageValue<string>('language-corrections.correctionProposals.value.1')){
  candidates.push(evidence(text,{start,end:start+word.length,from:match[1],to:languageValue<string>('language-corrections.canonical.value.1')},'protected-command',false,'destructive_command_requires_clarification'));return trace;
 }
 const {known,reads}=vocabulary(compiled);
 if(word.length>=3&&word.length<=24&&!known.has(word)&&!legacy()[word]){
  const ranked=reads.map(to=>({to,cost:editCost(word,to)})).filter(r=>r.cost===1).sort((a,b)=>a.cost-b.cost||a.to.localeCompare(b.to));
  for(const r of ranked.slice(0,3)){
   // Substitutions can turn a legitimate uncommon word/name into a command: never auto-accept them.
   const substitution=word.length===r.to.length&&[...word].filter((c,i)=>c!==r.to[i]).length===1;
   const repeated=word.length===r.to.length+1&&[...word].some((c,i)=>i>0&&c===word[i-1]&&word.slice(0,i)+word.slice(i+1)===r.to);
   candidates.push(evidence(text,{start,end:start+word.length,from:match[1],to:r.to},'compiled-read-command',false,ranked.length!==1?'ambiguous_command':substitution?'substitution_requires_clarification':r.to.length>word.length?'missing_letter_requires_clarification':word.length>r.to.length&&!repeated?'extra_letter_requires_clarification':'unique_read_candidate'));
  }
 }
 // Word-boundary proposals are deliberately not auto-accepted: a split can be
 // an intentional word/name. Only inspect the command head, never product spans.
 if(!known.has(word)&&match[1]===word&&word.length<=24){
  const tail=languagePattern('language-corrections.tail.pattern.1').exec(text.slice(start+word.length));
  if(tail&&!known.has(tail[2])&&reads.includes(word+tail[2])){
   const from=match[1]+tail[0];
   candidates.push(evidence(text,{start,end:start+from.length,from,to:word+tail[2]},'compiled-read-command',false,'word_boundary_requires_clarification'));
  }
  for(const read of reads){
   const suffix=word.slice(read.length);
   if(word.startsWith(read)&&languageValue<string[]>('language-corrections.correctionProposals.value.2').includes(suffix)){
    candidates.push(evidence(text,{start,end:start+word.length,from:match[1],to:read+' '+suffix},'compiled-read-command',false,'word_boundary_requires_clarification'));
   }
  }
 }
 // Catalog terms are supplied only by a trusted scoped caller. They remain suggestions;
 // quantities, IDs, punctuation, negation, allergy words and exact catalog tokens stay literal.
 if(catalogTerms.length>256){trace.truncated=true;return trace;}
 const catalog=[...new Set(catalogTerms.map(t=>t.toLowerCase()).filter(t=>languagePattern('language-corrections.catalog.pattern.1').test(t)))].sort();
 const protectedWords=new Set(languageValue<string[]>('language-corrections.protectedWords.value.1'));
 const tokens=[...text.matchAll(languagePattern('language-corrections.tokens.pattern.1'))];
 for(const token of tokens){
  if(candidates.length>=8){trace.truncated=true;break;}
  const from=token[0],raw=from.toLowerCase();
  if(token.index!<=start||!languagePattern('language-corrections.correctionProposals.pattern.2').test(from)||protectedWords.has(raw)||known.has(raw)||catalog.includes(raw))continue;
  const ranked=catalog.map(to=>({to,cost:editCost(raw,to)})).filter(r=>r.cost<=2&&r.cost>0).sort((a,b)=>a.cost-b.cost||a.to.localeCompare(b.to)).slice(0,3);
  for(const r of ranked){if(candidates.length>=8){trace.truncated=true;break;}candidates.push(evidence(text,{start:token.index!,end:token.index!+from.length,from,to:r.to},'catalog-suggestion',false,'catalog_name_requires_confirmation'));}
 }
 return trace;
}

export type ProtectedSpan={start:number;end:number};
/** Internal adapter input from a scoped catalog reader, never HTTP/user context. */
export type CatalogVocabulary={tenantId:string;revision:string;terms:readonly string[];protectedTerms:readonly string[]};
export function scopedCatalogProposals(compiled:Compiled,text:string,tenantId:string,vocabulary:CatalogVocabulary,protectedSpans:readonly ProtectedSpan[]):CorrectionTrace {
 const empty:CorrectionTrace={version:1,offsetUnit:'unicode-code-point',originalText:text,candidates:[],truncated:false};
 if(text.length>4000){empty.truncated=true;return empty;}
 const length=[...text].length;
 if(!tenantId||tenantId!==vocabulary.tenantId||!vocabulary.revision||vocabulary.revision.length>128)throw new Error('Invalid catalog scope');
 if(vocabulary.terms.length>256||vocabulary.protectedTerms.length>256||protectedSpans.length>128){empty.truncated=true;return empty;}
 if([...vocabulary.terms,...vocabulary.protectedTerms].some(t=>typeof t!=='string'||!t||t.length>128))throw new Error('Invalid catalog term');
 if(protectedSpans.some(s=>!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end<=s.start||s.end>length))throw new Error('Invalid protected span');
 // Without an authoritative entity parser, sensitive requests abstain as a whole.
 // This adapter is suggestion-only and does not infer addresses, dates or brands.
 if(languagePattern('language-corrections.scopedCatalogProposals.pattern.1').test(text))return empty;
 const trace=correctionProposals(compiled,text,vocabulary.terms);
 const protectedNames=vocabulary.protectedTerms.map(t=>t.toLowerCase());
 trace.candidates=trace.candidates.filter(c=>c.source==='catalog-suggestion'&&!protectedNames.includes(c.original.toLowerCase())&&!protectedNames.includes(c.candidate.toLowerCase())&&!protectedSpans.some(s=>c.start<s.end&&c.end>s.start));
 // Multiword protected names also cover constituent tokens and retain exact offsets.
 const ranges:ProtectedSpan[]=[];
 for(const name of protectedNames){
  const escaped=name.replace(languagePattern('language-corrections.escaped.pattern.1'),'\\$&');
  for(const match of text.matchAll(new RegExp(escaped,'giu'))){
   ranges.push({start:[...text.slice(0,match.index!)].length,end:[...text.slice(0,match.index!+match[0].length)].length});
  }
 }
 trace.candidates=trace.candidates.filter(c=>!ranges.some(s=>c.start<s.end&&c.end>s.start));
 return trace;
}
