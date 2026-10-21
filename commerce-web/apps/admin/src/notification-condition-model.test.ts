import { describe, expect, it } from 'vitest';
import type { NotificationCondition, NotificationConditionField, NotificationConditions, NotificationMetadata, NotificationProgramInput } from '@commerce/api-client';
import { conditionFieldAvailable, newNotificationCondition, normalizeNotificationConditions, notificationConditionProblems, notificationConditionSummary, notificationProgramSummary, notificationTemplateOutline, validNotificationAmount } from './notification-condition-model';
const fields: NotificationConditionField[] = [
  { key:'customer.verified', label:'Verified account', type:'boolean', operators:[{id:'eq',label:'Is'}], options:[{value:'true',label:'Yes'},{value:'false',label:'No'}], triggers:[], description:'Verification status' },
  { key:'customer.order_count', label:'Order count', type:'integer', operators:[{id:'eq',label:'Is'},{id:'gte',label:'Is at least'}], options:[], triggers:[], description:'Saved orders' },
  { key:'product.name', label:'Product name', type:'text', operators:[{id:'eq',label:'Is'},{id:'contains',label:'Contains'}], options:[], triggers:['product_view'], description:'Product at the recorded event' },
  { key:'order.total', label:'Order amount', type:'money', operators:[{id:'gte',label:'Is at least'}], options:[], triggers:['purchase'], description:'Recorded order amount' },
  { key:'order.currency', label:'Order currency', type:'text', operators:[{id:'eq',label:'Is'}], options:[], triggers:['purchase'], description:'Recorded currency' },
];
const problems = (rule: NotificationCondition, trigger='purchase') => notificationConditionProblems({match:'all',rules:[rule]},fields,trigger);
const count = (value:string):NotificationCondition => ({field:'customer.order_count',operator:'gte',value});
const money = (value:string,currency='USD'):NotificationCondition => ({field:'order.total',operator:'gte',value,currency});

it('normalizes legacy rules without modifying or sharing mutable rules',()=>{
  expect(normalizeNotificationConditions()).toEqual({match:'all',rules:[]});
  const source:NotificationConditions={match:'any',rules:[count('2')]};
  const result=normalizeNotificationConditions(source);result.rules[0].value='8';
  expect(source.rules[0].value).toBe('2');expect(result.match).toBe('any');
});
it('uses only trigger-compatible choices and preserves incompatible rules for correction',()=>{
  expect(conditionFieldAvailable(fields[0],'purchase')).toBe(true);
  expect(conditionFieldAvailable(fields[2],'purchase')).toBe(false);
  const rule={field:'product.name',operator:'contains' as const,value:'tote'};
  expect(problems(rule)).toEqual([expect.stringContaining('not available for this event')]);
  expect(rule).toEqual({field:'product.name',operator:'contains',value:'tote'});
  expect(problems(rule,'product_view')).toEqual([]);
});
it('resets type-specific values only when the operator deliberately chooses a new field',()=>{
  expect(newNotificationCondition(fields[0])).toEqual({field:'customer.verified',operator:'eq',value:'true'});
  expect(newNotificationCondition(fields[3])).toEqual({field:'order.total',operator:'gte',value:'',currency:''});
  expect(newNotificationCondition(fields[1])).not.toHaveProperty('currency');
});
describe('canonical integer boundaries',()=>{
  for(const value of ['0','1','1000000000'])it(`accepts ${value}`,()=>expect(problems(count(value))).toEqual([]));
  for(const value of ['01','1000000001','1.5','-1','1e3',' 2','２'])it(`rejects ${JSON.stringify(value)}`,()=>expect(problems(count(value)).length).toBeGreaterThan(0));
});
describe('exact decimal validation',()=>{
  for(const value of ['0','0.01','001.20','999999999999.99'])it(`accepts ${value}`,()=>{expect(validNotificationAmount(value)).toBe(true);expect(problems(money(value))).toEqual([]);});
  for(const value of ['1000000000000','999999999999.999','1.','-0.01','1e2','1,000',' 1'])it(`rejects ${JSON.stringify(value)}`,()=>expect(validNotificationAmount(value)).toBe(false));
  it('requires explicit uppercase currency and rejects currency on non-money fields',()=>{
    expect(problems(money('1','usd'))).toEqual([expect.stringContaining('three-letter currency')]);
    expect(problems({...count('2'),currency:'USD'})).toEqual([expect.stringContaining('only supported for order amounts')]);
    expect(problems({field:'order.currency',operator:'eq',value:'usd'})).toEqual([expect.stringContaining('three-letter currency')]);
  });
});
it('limits rules, disallows empty Any groups and rejects unsupported comparisons',()=>{
  expect(notificationConditionProblems({match:'all',rules:[]},fields,'purchase')).toEqual([]);
  expect(notificationConditionProblems({match:'any',rules:[]},fields,'purchase')).toContain('Add at least one condition when matching Any condition.');
  expect(notificationConditionProblems({match:'all',rules:Array.from({length:11},()=>count('1'))},fields,'purchase')).toContain('Use no more than 10 conditions.');
  expect(problems({...count('2'),operator:'contains'})).toEqual([expect.stringContaining('supported comparison')]);
});
it('counts Unicode characters and rejects C0 and C1 control characters',()=>{
  expect(problems({field:'product.name',operator:'eq',value:'س'.repeat(200)},'product_view')).toEqual([]);
  expect(problems({field:'product.name',operator:'eq',value:'س'.repeat(201)},'product_view')).toEqual([expect.stringContaining('200 characters')]);
  for(const value of ['name\u0001','name\u0085'])expect(problems({field:'product.name',operator:'eq',value},'product_view')).toEqual([expect.stringContaining('control characters')]);
});
it('explains rules and uses placeholders instead of fabricated preview values',()=>{
  expect(notificationConditionSummary(money('150.50'),fields)).toBe('Order amount is at least 150.50 USD');
  const metadata={triggers:[{id:'purchase',label:'Order placed',requires_orders:true}],condition_fields:fields,tokens:[{key:'customer.first_name',label:'Customer first name'}]} as NotificationMetadata;
  const program={trigger_kind:'purchase',delay_minutes:0,conditions:{match:'any',rules:[]}} as unknown as NotificationProgramInput;
  expect(notificationProgramSummary(program,metadata)).toContain('Add a condition or choose All conditions');
  expect(notificationTemplateOutline('Hi {{customer.first_name}}',metadata.tokens)).toBe('Hi ‹Customer first name›');
});
