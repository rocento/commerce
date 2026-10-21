import type { CapacityRow, CapacityRule, FulfillmentSchedule, ScheduleWindow } from '@commerce/api-client';

export const scheduleMethods = [
  ['standard_delivery', 'Standard delivery'], ['same_day', 'Same-day delivery'],
  ['next_day', 'Next-day delivery'], ['scheduled_delivery', 'Scheduled delivery'],
  ['express', 'Express delivery'], ['pickup', 'Store pickup'],
] as const;
export const scheduleBounds = {
  duration_minutes: [15, 1440], spacing_minutes: [0, 1440], lead_minutes: [0, 10080],
  min_days: [0, 30], max_days: [0, 60], ttl_minutes: [1, 30],
} as const;
function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}
function windowsError(windows: ScheduleWindow[]) {
  if (windows.length > 28) return 'Use at most 28 operating windows.';
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  if (windows.some(w => !w.start || !w.end || minutes(w.end) - minutes(w.start) < 15)) return 'Each operating window must end at least 15 minutes after it starts on the same day.';
  if (windows.some((w, i) => windows.slice(i + 1).some(v => w.weekday === v.weekday && w.start < v.end && v.start < w.end))) return 'Operating windows on the same day must not overlap.';
  return '';
}
export function scheduleError(schedule: FulfillmentSchedule) {
  if (!schedule.source_id) return 'Choose a location.';
  if (!schedule.method.trim()) return 'Choose a fulfillment method.';
  if (schedule.enabled && ['store_pickup', 'curbside_pickup'].includes(schedule.method)) return 'This legacy pickup method is unsupported. Create a replacement schedule using Store pickup and disable the old schedule.';
  if (!validTimezone(schedule.timezone)) return 'Enter a valid IANA timezone, such as Africa/Cairo.';
  for (const [key, [min, max]] of Object.entries(scheduleBounds)) {
    const value = schedule.config[key as keyof typeof scheduleBounds];
    if (key === 'duration_minutes' && value === null) continue;
    if (value === null || !Number.isInteger(value) || value < min || value > max) return `${key.replaceAll('_', ' ')} must be a whole number from ${min} to ${max}.`;
  }
  if (schedule.config.min_days > schedule.config.max_days) return 'Maximum days ahead must be at least minimum days ahead.';
  const error = windowsError(schedule.config.windows);
  if (error) return error;
  const exceptions = schedule.config.exceptions;
  if (exceptions.length > 100) return 'Use at most 100 calendar exceptions.';
  if (exceptions.some((x, i) => !x.from || !x.through || x.from > x.through || exceptions.slice(i + 1).some(y => x.from <= y.through && y.from <= x.through))) return 'Calendar exception dates must be valid and must not overlap.';
  return exceptions.map(x => windowsError(x.windows)).find(Boolean) || '';
}
export function capacityRuleError(rule: CapacityRule) {
  if (!validTimezone(rule.timezone)) return 'Enter a valid IANA timezone, such as Africa/Cairo.';
  if (rule.starts_on && rule.ends_on && rule.starts_on > rule.ends_on) return 'Through date must be on or after the from date.';
  if (rule.overrides_rule_id && (!rule.starts_on || !rule.ends_on)) return 'An override requires both dates.';
  if (!Object.keys(rule.limits).length) return 'Set at least one capacity limit.';
  if (Object.values(rule.limits).some(value => !Number.isInteger(value) || value < 0 || value > 1000000000)) return 'Capacity limits must be whole numbers from 0 to 1,000,000,000.';
  return '';
}
export function blockWindow(row: CapacityRow): CapacityRule {
  const timezone = row.slot.timezone;
  const starts = new Date(row.slot.starts_at);
  const date = starts.toLocaleDateString('en-CA', { timeZone: timezone });
  return { id: crypto.randomUUID(), overrides_rule_id: null, source_id: row.slot.source_id,
    area_id: row.area_id, method: row.slot.method, timezone, period: 'slot',
    local_start: starts.toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false }),
    starts_on: date, ends_on: date, limits: { orders: 0 }, overflow_percent: 0, enabled: true };
}
