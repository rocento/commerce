import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import ts from 'typescript';
import contract from '../src/generated/recognition-contract.json' with {type:'json'};
const modules=new Set(Object.keys(contract).map(key=>key.split('.')[0]+'.ts'));
test('runtime recognition modules keep spoken patterns and command word lists out of TypeScript',()=>{
 const violations:string[]=[];
 for(const file of readdirSync(new URL('../src/',import.meta.url))){
  if(!modules.has(file))continue;
  const text=readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  function visit(node:ts.Node){
   if(ts.isTypeNode(node))return;
   if(!['language-knowledge.ts','rule-governance.ts'].includes(file)&&ts.isRegularExpressionLiteral(node)&&/[a-z]{2,}/i.test(node.text.slice(1,node.text.lastIndexOf('/'))))violations.push(file+': literal pattern '+node.getText());
   if(ts.isArrayLiteralExpression(node)&&node.elements.some(e=>ts.isStringLiteral(e)&&['need','want','please','find','show','buy','remove','add','cancel'].includes(e.text)))violations.push(file+': literal command vocabulary');
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
 assert.deepEqual(violations,[]);
});
test('every published recognition contract key has a runtime consumer',()=>{
 const source=readdirSync(new URL('../src/',import.meta.url)).filter(file=>file.endsWith('.ts')).map(file=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).join('\n');
 assert.deepEqual(Object.keys(contract).filter(key=>!source.includes("'"+key+"'")),[]);
});
