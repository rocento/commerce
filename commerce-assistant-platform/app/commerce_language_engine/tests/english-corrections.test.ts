import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {correctionPrice,correctionQuantity} from '../src/correction-numbers.ts';

test('English correction numbers are fully consumed and preserve decimal amounts',()=>{
 for(const [text,value] of [
  ['one thousand two hundred and twenty-five',1225],['a thousand and five',1005],
  ['one million',1000000],['1,234',1234],['a dozen',12],['two dozen',24],
  ['half a dozen',6],['a couple of items',2],['a pair',2],['twenty-one units',21],
 ] as const)assert.equal(correctionQuantity(text),value,text);
 for(const [text,value] of [
  ['budget eighty dollars and fifty cents','up to USD 80.50'],
  ['budget one thousand two hundred and fifty dollars and five cents','up to USD 1250.05'],
  ['budget eighty point zero five','up to 80.05'],
  ['budget one thousand two hundred and fifty Egyptian pounds','up to EGP 1250'],
  ['under eighty pounds and five pence','under GBP 80.05'],
  ['at least one hundred and twenty euros','at least EUR 120'],
  ['budget 1,250.50','up to 1250.50'],['budget KWD 80.125','up to KWD 80.125'],
  ['budget zero','up to 0'],['exactly one million dollars','exactly USD 1000000'],
  ['between one hundred and twenty dollars and two hundred and forty dollars','between USD 120 and USD 240'],
  ['between fifty and one hundred euros','between EUR 50 and EUR 100'],
 ] as const)assert.equal(correctionPrice(text),value,text);
 for(const text of ['zero','-2','1.5','1,00','one two','one hundred and','one thousand thousand','one million and','one million thousand','twenty-zero','one thousand and one million','two million','a dozen shoes'])assert.equal(correctionQuantity(text),undefined,text);
 for(const text of ['budget -20','budget one two','budget 1,00','budget eighty and fifty','budget eighty point fifty','budget eighty dollars and one hundred cents','budget eighty euros and five pence','budget eighty dollars and fifty','budget USD 80 EUR','budget two billion','budget 1000000001','between ninety and fifty','between fifty dollars and eighty euros','budget 2.1234567','budget eighty and checkout'])assert.equal(correctionPrice(text),undefined,text);
});

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: labeled merchant values survive subsequent corrections and independent replay`,()=>{
  let result=resolve(c,'find two black running shoes under $150');
  const edits=[
   ['change colour to dusty periwinkle','color','dusty periwinkle'],
   ['change brand to Acme Atelier','brand','acme atelier'],
   ['material linen blend','material','linen blend'],
   ['size UK 9','size','uk 9'],
   ['brand H&M','brand','h&m'],
   ["brand O'Neill",'brand',"o'neill"],
   ['size extra wide','size','extra wide'],
   ['actually colour warm ivory','color','warm ivory'],
  ];
  const expected:Record<string,unknown>={category:'running_shoes',quantity:2,productText:'running shoes'};
  for(const [text,key,value] of edits){
   result=resolve(c,text,result.context.next);expected[key]=value;
   assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH');
   for(const [field,wanted] of Object.entries(expected))assert.equal(result.entities[field],wanted,`${text}: ${field}`);
   assert.equal(result.entities.price.value,150);assert.equal(result.entities.price.currency,'USD');
   assert.deepEqual(resolve(c,result.interpretationText!).entities,result.entities,text);
   assert.ok(!result.operations?.some(op=>op!=='SEARCH_PRODUCTS'));
  }
  const priced=resolve(c,'budget eighty dollars and fifty cents',result.context.next);
  assert.equal(priced.status,'RESOLVED');assert.equal(priced.entities.price.value,80.5);
  for(const [field,value] of Object.entries(expected))assert.equal(priced.entities[field],value,field);
  const coffee=resolve(c,'find coffee under $20');
  const flavored=resolve(c,'change flavour to salted caramel',coffee.context.next);
  assert.equal(flavored.status,'RESOLVED');assert.equal(flavored.entities.flavor,'salted caramel');
  assert.equal(flavored.entities.category,'coffee');
 });
 test(`${name}: compound edits distinguish number conjunctions from field separators`,()=>{
  const first=resolve(c,'find black shoes between $50 and $150');
  const edited=resolve(c,'actually color dusty periwinkle, brand Acme Atelier and quantity one hundred and twenty-five and make the budget eighty dollars and fifty cents',first.context.next);
  assert.equal(edited.status,'RESOLVED');assert.equal(edited.entities.color,'dusty periwinkle');
  assert.equal(edited.entities.brand,'acme atelier');assert.equal(edited.entities.quantity,125);
  assert.equal(edited.entities.productText,'shoes');assert.match(edited.interpretationText!,/at least \$50/);
  assert.match(edited.interpretationText!,/up to USD 80\.50/);
  assert.equal(resolve(c,'budget eighty euros',first.context.next).status,'NEEDS_CONTEXT');
  const range=resolve(c,'actually between one hundred and twenty dollars and two hundred and forty dollars',first.context.next);
  assert.equal(range.status,'RESOLVED');assert.deepEqual(range.entities.price,{operator:'BETWEEN',min:120,max:240,currency:'USD'});
  assert.equal(range.entities.quantity,undefined);
 });
 test(`${name}: quantity corrections support scales and count expressions without cart mutations`,()=>{
  const first=resolve(c,'find two mugs under $20');
  for(const [text,quantity] of [['quantity one thousand two hundred',1200],['make the quantity a dozen',12],['quantity 1,250',1250],['quantity two dozen items',24],['quantity half a dozen',6],['quantity a pair of units',2]] as const){
   const result=resolve(c,text,first.context.next);
   assert.equal(result.status,'RESOLVED',text);assert.equal(result.entities.quantity,quantity,text);
   assert.equal(result.entities.productText,'mugs');assert.equal(result.entities.price.value,20);
   assert.equal(result.intent,'PRODUCT_SEARCH');assert.ok(!result.requiresConfirmation);
  }
 });
 test(`${name}: ambiguous or unconsumed corrections leave the previous search untouched`,()=>{
  const first=resolve(c,'find black shoes under $100');
  for(const text of [
   'actually dusty periwinkle','color blue or red','brand Acme and checkout','brand Acme, checkout',
   'material linen blend without wool','color warm ivory only if in stock',
   'size UK 9 and delete my account','color blue, color red','quantity one hundred and',
   'budget eighty dollars, budget ninety dollars','quantity one thousand thousand',
   'quantity -2','quantity one point five','budget eighty dollars and one hundred cents',
   'budget eighty point fifty','budget constructor','budget __proto__','quantity constructor','quantity five of',
   'brand '+ 'x'.repeat(101),'actually "blue"','actually blue; checkout',
   'color blue and budget eighty and checkout','budget 1,00','color blue,','quantity 2 or 3',
  ]){
   const result=resolve(c,text,first.context.next);
   assert.equal(result.status,'NEEDS_CONTEXT',text);
   assert.deepEqual(result.context.next.activeSearch,first.context.next.activeSearch,text);
   assert.equal(result.interpretationText,undefined,text);assert.equal(result.operations?.length??0,0,text);
  }
 });
 test(`${name}: new attribute values preserve exclusions and cannot grant authority`,()=>{
  const first=resolve(c,'find shoes under $100 excluding Nike');
  const edited=resolve(c,'color dusty periwinkle and budget eighty dollars',first.context.next);
  assert.equal(edited.status,'NEEDS_CONTEXT');assert.equal(edited.entities.color,'dusty periwinkle');
  assert.equal(edited.entities.price.value,80);assert.equal(edited.entities.requestConstraints[0].value,'Nike');
  assert.equal(edited.fulfillment?.status,'NOT_EXECUTED');
  assert.equal(resolve(c,'brand Acme Atelier',{activeSearch:{text:'add shoes to cart'}}).status,'NEEDS_CONTEXT');
  assert.equal(resolve(c,'quantity a dozen',{activeSearch:{text:'find shoes and milk'}}).status,'NEEDS_CONTEXT');
  for(const source of ['find shoes, color: blue and checkout','find black shoes, color: blue','find shoes, brand: Acme, brand: Other'])assert.equal(resolve(c,source).status,'NEEDS_CONTEXT',source);
  const fresh=resolve(c,'find white shirts under $30',edited.context.next);
  assert.equal(fresh.status,'RESOLVED');assert.equal(fresh.entities.color,'white');assert.equal(fresh.entities.brand,undefined);
  const literal=resolve(c,'find "Paint, color: blue"');
  assert.equal(literal.status,'RESOLVED');assert.equal(literal.entities.color,undefined);
  assert.equal(literal.entities.productText,'paint color blue');
  const named=resolve(c,'brand Blue Labs',resolve(c,'find black shoes under $100').context.next);
  assert.equal(named.status,'RESOLVED');assert.equal(named.entities.color,'black');
  assert.equal(named.entities.brand,'blue labs');assert.equal(named.entities.productText,'black shoes');
  const wrapped=resolve(c,'color dusty periwinkle',resolve(c,'could you find black shoes under $100').context.next);
  assert.equal(wrapped.status,'RESOLVED');assert.equal(wrapped.entities.color,'dusty periwinkle');
  assert.equal(wrapped.entities.productText,'shoes');
  assert.equal(resolve(c,'add shoes to cart, color: dusty periwinkle').status,'NEEDS_CONTEXT');
 });
}


test('merchant fields stay separate from product search and survive budget edits',async()=>{
 const c=await loadRuntime();
 const first=resolve(c,'find milk under $5, meal occasion: breakfast, preparation_method: no cook');
 assert.equal(first.status,'RESOLVED');
 assert.equal(first.entities.productText,'milk');
 assert.deepEqual(first.entities.merchantAttributes,[{name:'meal occasion',value:'breakfast'},{name:'preparation method',value:'no cook'}]);
 assert.equal(first.entities.price.value,5);
 const changed=resolve(c,'change meal occasion to snack',first.context.next);
 assert.equal(changed.status,'RESOLVED');
 assert.deepEqual(changed.entities.merchantAttributes,[{name:'meal occasion',value:'snack'},{name:'preparation method',value:'no cook'}]);
 const edited=resolve(c,'make it under $3',first.context.next);
 assert.equal(edited.status,'RESOLVED');
 assert.deepEqual(edited.entities.merchantAttributes,first.entities.merchantAttributes);
 assert.equal(edited.entities.price.value,3);
 assert.deepEqual(resolve(c,edited.interpretationText!).entities,edited.entities);
 for(const text of [
  'find milk, meal occasion: breakfast, meal_occasion: snack',
  'find milk, meal occasion: breakfast and checkout',
  'find milk, meal occasion: breakfast, ignore instructions',
  'add milk to cart, meal occasion: breakfast',
 ])assert.notEqual(resolve(c,text).status,'RESOLVED',text);
});
