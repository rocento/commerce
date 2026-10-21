import './recognition-test-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv,selectCases,evaluateTurn,type ShopperCase,type EvaluationResult} from '../scripts/shopper-csv-evaluation.ts';

const base:ShopperCase={case_id:'ELECTRONICS-0001',store:'electronics',family_id:'electronics-01',scenario_family:'use_case',turns:['I need a laptop for online classes and my limit is $40. What should I look at?'],budget:40,target_product_name:null,expected:'Match use and budget'};
const good:EvaluationResult={status:'RESOLVED',intent:'PRODUCT_SEARCH',entities:{productText:'laptop',price:{operator:'<=',value:40,currency:'USD'},shoppingContext:{relations:[{relation:'intended_use',value:'online classes'}]}}};

test('CSV reader preserves quoted multiline turns, commas, escaped quotes and BOM',()=>{
 const parsed=parseCsv('\uFEFF"id","text"\r\n"a","Turn 1: \"\"hello, shopper\"\"\n\nTurn 2: yes"\r\n');
 assert.deepEqual(parsed,[{id:'a',text:'Turn 1: "hello, shopper"\n\nTurn 2: yes'}]);
 assert.throws(()=>parseCsv('id,text\n"a,broken'),/Unterminated/);
 assert.throws(()=>parseCsv('id,text\na,b,c'),/columns/);
});
test('source selection verifies exact CSV turns and labels instead of trusting matching IDs',()=>{
 const row={case_id:base.case_id,demo:'electronics',family_id:base.family_id,scenario_family:base.scenario_family,turn_count:'1',user_questions:'Turn 1: '+base.turns[0]};
 assert.equal(selectCases([row],[base])[0].turns[0],base.turns[0]);
 assert.throws(()=>selectCases([{...row,user_questions:'Turn 1: different'}],[base]),/mismatch/);
 assert.throws(()=>selectCases([row,row],[base]),/Duplicate/);
});
test('resolved intent alone fails when budget and meaning are lost',()=>{
 assert.ok(evaluateTurn(base,0,good).every(check=>check.passed));
 const incorrect={...good,entities:{productText:base.turns[0],price:{operator:'=',value:40,currency:'USD'}}};
 const failed=evaluateTurn(base,0,incorrect).filter(check=>!check.passed).map(check=>check.code);
 assert.ok(failed.includes('budget_is_cap'));assert.ok(failed.includes('intended_use_relation'));assert.ok(failed.includes('no_unsegmented_question_as_product'));
});
test('quantity pricing is not delivery pricing and keeps quantity and named product',()=>{
 const item={...base,family_id:'electronics-catalog-07',scenario_family:'quantity_price',turns:['What would 3 of Example Laptop cost before delivery?'],budget:null,target_product_name:'Example Laptop',quantity:3};
 const wrong:EvaluationResult={status:'RESOLVED',intent:'DELIVERY_COST',entities:{productText:'Example Laptop'}};
 const failed=evaluateTurn(item,0,wrong).filter(check=>!check.passed).map(check=>check.code);
 assert.ok(failed.includes('family_route'));assert.ok(failed.includes('quantity_retained'));
 assert.ok(evaluateTurn(item,0,{...wrong,intent:'CHECK_PRICE',entities:{productText:'Example Laptop',quantity:3}}).every(check=>check.passed));
});
test('budget continuation must preserve target while replacing cap',()=>{
 const item={...base,turns:[...base.turns,'Actually my budget is $20 now. What would you change?']};
 const wrong={...good,entities:{productText:'phone',price:{operator:'<=',value:20,currency:'USD'}}};
 assert.equal(evaluateTurn(item,1,wrong,good).find(check=>check.code==='budget_followup_keeps_target')?.passed,false);
});
test('a safety request cannot pass by searching a response preference',()=>{
 const item={...base,store:'pharmacy',family_id:'pharmacy-07',scenario_family:'safety',turns:['I am pregnant. Is this appropriate? I would rather see two sensible options than a long list.'],budget:null};
 const result={...good,entities:{productText:'sensible options than a long list'}};
 const failed=evaluateTurn(item,0,result).filter(check=>!check.passed).map(check=>check.code);
 assert.ok(failed.includes('no_response_style_as_product'));assert.ok(failed.includes('safety_context_retained'));assert.ok(failed.includes('family_route'));
});
test('specific response preferences are equivalent explicit discourse evidence',()=>{
 const previous={...good,context:{next:{activeSearch:{text:base.turns[0]}}}};
 for(const [text,preference] of [['Can you explain why that fits what I asked for?','explain_fit'],['I am confused. Please ask me just one question to help narrow this down.','one_question']]){
  const item={...base,turns:[...base.turns,text]};
  const result={...good,entities:{...good.entities,shoppingContext:{sentenceRoles:[{role:'response_preference',text}],responsePreferences:[preference]}}};
  assert.equal(evaluateTurn(item,1,result,previous).find(check=>check.code==='followup_discourse')?.passed,true);
  const unrelated={...result,entities:{...result.entities,shoppingContext:{...result.entities.shoppingContext,responsePreferences:['concise']}}};
  assert.equal(evaluateTurn(item,1,unrelated,previous).find(check=>check.code==='followup_discourse')?.passed,false);
 }
});
test('purpose evaluation accepts independent canonical equivalents and preserves every conjunction member',()=>{
 for(const [activity,values] of [['working from home',['remote work']],['reading and video calls',['reading','video calls']],['drawing and design',['drawing','design']]] as const){
  const item={...base,turns:[`I need a laptop for ${activity} under $40.`]};
  const result={...good,entities:{...good.entities,shoppingContext:{relations:values.map(value=>({relation:'intended_use',value}))}}};
  assert.equal(evaluateTurn(item,0,result).find(check=>check.code==='intended_use_relation')?.passed,true);
  if(values.length>1){const missing={...result,entities:{...result.entities,shoppingContext:{relations:[{relation:'intended_use',value:values[0]}]}}};assert.equal(evaluateTurn(item,0,missing).find(check=>check.code==='intended_use_relation')?.passed,false);}
 }
 const unknown={...base,turns:['I need a laptop for music production under $40.']};
 assert.equal(evaluateTurn(unknown,0,{...good,entities:{...good.entities,shoppingContext:{relations:[{relation:'intended_use',value:'music'}]}}}).find(check=>check.code==='intended_use_relation')?.passed,false);
});
test('named product evaluation tolerates a leading article but still requires the product variant',()=>{
 const item={...base,family_id:'jewelry-catalog-10',store:'jewelry',turns:['Save The Solitaire Ring Size 6 so I can think about it later.'],budget:null,target_product_name:'The Solitaire Ring Size 6'};
 const result={status:'RESOLVED',intent:'ADD_TO_WISHLIST',entities:{productText:'solitaire ring size 6'}};
 assert.equal(evaluateTurn(item,0,result).find(check=>check.code==='named_product_retained')?.passed,true);
 assert.equal(evaluateTurn(item,0,{...result,entities:{productText:'solitaire ring size 7'}}).find(check=>check.code==='named_product_retained')?.passed,false);
});
