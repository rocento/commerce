import { describe, expect, it } from 'vitest';
import type { CapacityRow, FulfillmentSchedule } from '@commerce/api-client';
import { blockWindow, capacityRuleError, scheduleError } from './capacity-validation';

const schedule = (): FulfillmentSchedule => ({ id:'schedule',source_id:'warehouse',area_id:null,method:'pickup',enabled:true,timezone:'Africa/Cairo',config:{windows:[{weekday:0,start:'09:00:00',end:'18:00:00',cutoff:null}],duration_minutes:60,spacing_minutes:0,lead_minutes:120,cutoff:null,min_days:0,max_days:14,ttl_minutes:10,release_before:'fulfilling',exceptions:[]} });
describe('fulfillment editor validation',()=>{
 it('accepts valid pickup and rejects a legacy pickup identifier while enabled',()=>{const s=schedule();expect(scheduleError(s)).toBe('');s.method='store_pickup';expect(scheduleError(s)).toContain('unsupported');s.enabled=false;expect(scheduleError(s)).toBe('');});
 it('rejects reversed windows, overlap and invalid exception ranges',()=>{const s=schedule();s.config.windows[0].end='08:00:00';expect(scheduleError(s)).toContain('15 minutes');s.config.windows[0].end='18:00:00';s.config.windows.push({weekday:0,start:'17:00:00',end:'19:00:00',cutoff:null});expect(scheduleError(s)).toContain('overlap');s.config.windows.pop();s.config.exceptions=[{from:'2026-10-03',through:'2026-10-01',closed:true,windows:[]}];expect(scheduleError(s)).toContain('dates');});
 it('matches backend duration, hold and advance bounds',()=>{const s=schedule();s.config.duration_minutes=14;expect(scheduleError(s)).toContain('15 to 1440');s.config.duration_minutes=null;s.config.ttl_minutes=31;expect(scheduleError(s)).toContain('1 to 30');s.config.ttl_minutes=10;s.config.min_days=15;expect(scheduleError(s)).toContain('Maximum days');});
 it('rejects invalid timezones before submission',()=>{const s=schedule();s.timezone='Not/AZone';expect(scheduleError(s)).toContain('timezone');});
 it('blocks one location at its local date without inheriting a shared scope',()=>{
  const row={slot:{source_id:'warehouse',method:'pickup',timezone:'Africa/Cairo',starts_at:'2026-10-01T22:30:00Z'},area_id:'area',caps:[{rule_id:'shared'}]} as CapacityRow;
  const rule=blockWindow(row);expect(rule).toMatchObject({source_id:'warehouse',area_id:'area',method:'pickup',overrides_rule_id:null,starts_on:'2026-10-02',ends_on:'2026-10-02',local_start:'01:30:00',limits:{orders:0},overflow_percent:0});expect(capacityRuleError(rule)).toBe('');
  rule.ends_on='2026-10-01';expect(capacityRuleError(rule)).toContain('Through date');rule.ends_on=rule.starts_on;rule.limits={};expect(capacityRuleError(rule)).toContain('at least one');
 });
});
