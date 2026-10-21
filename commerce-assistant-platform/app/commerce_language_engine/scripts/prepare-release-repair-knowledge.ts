/** Immutable revision; retain the complete licensed vocabulary and its provenance. */
import {readFile,writeFile} from 'node:fs/promises';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {ruleContract,deliveryQuestionExecutor,reviewContentHash,type GovernedRule,assertKnowledgeUpgrade} from '../src/rule-governance.ts';
import {compile} from '../src/compiler.ts';
const previous=canonicalKnowledge(JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-phase2-v3.json',import.meta.url),'utf8')));
const pack=structuredClone(previous);pack.revision=10;
const heads=['can I get a replacement for {product} {date}','could I get a replacement for {product} {date}','can a replacement for {product} arrive {date}','will a replacement for {product} arrive {date}'];
const rule={id:'question.replacement_arrival',intent:'DELIVERY_DATE' as const,templates:heads.flatMap(head=>[head,head+'? I need it for {purpose}'])};
pack.questionRules!.push(rule);
const row:GovernedRule={family:'question',ruleId:rule.id,version:1,language:'en',domain:'commerce',runtime:deliveryQuestionExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract('question',rule),examples:['Can I get a replacement for a laptop tomorrow? I need it for video editing.','Will a replacement for my camera arrive today?'],counterexamples:['Order a replacement laptop tomorrow','Can I get a replacement for a laptop tomorrow and add milk to my cart','Can I get a replacement for a laptop tomorrow if it is free'],conflictsWith:[],source:'First-party English replacement arrival questions; Phase 0 semantic write-route audit; enterprise release repair 2026-10-10',author:'codex',changeReason:'Replacement arrival feasibility requires delivery/availability clarification, with no order or purchase authorization. Preserve source text and published context relations.',status:'reviewed'};
row.review={reviewer:'codex',method:'ai_assisted',reviewedAt:'2026-10-10T00:00:00.000Z',contentSha256:reviewContentHash(row)};
pack.ruleGovernance!.push(row);
const canonical=canonicalKnowledge(pack);assertKnowledgeUpgrade(previous,canonical);
const dictionary=JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'));compile({...dictionary,languageKnowledge:canonical});
await writeFile(new URL('../data/knowledge/shopping-en-release-v10.json',import.meta.url),JSON.stringify(canonical,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({revision:canonical.revision,concepts:canonical.concepts.length,rules:canonical.ruleGovernance!.length,packSha256:knowledgeHash(canonical),sourcePreserved:canonical.source===previous.source}));
