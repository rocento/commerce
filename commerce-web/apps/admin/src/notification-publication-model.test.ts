import { afterEach, expect, it, vi } from 'vitest';
import { defaultForm, validation, localTime, DAY } from './notification-publication-model';
afterEach(() => vi.useRealTimers());
function form() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  return { ...defaultForm(), title: 'New arrivals', body: 'Explore our latest collection.' };
}
it('defaults to seven days for signed-in customers and accepts Arabic copy', () => {
  const value = form(); expect(value.audience).toBe('customers');
  expect(new Date(value.expiresAt).getTime()).toBe(Date.now() + 7 * DAY);
  expect(validation({ ...value, title: 'وصل حديثاً', body: 'اكتشف مجموعتنا الجديدة' }, false)).toEqual([]);
});
it('requires selected delivery areas and caps the list', () => {
  const value = { ...form(), areaTargeted: true };
  expect(validation(value, false)).toContain('Choose at least one delivery area.');
  expect(validation({ ...value, areaIds: Array.from({length:101},(_,i)=>String(i)) }, false)).toContain('Choose at most 100 delivery areas.');
});
it('rejects unsafe or incomplete button destinations', () => {
  const value = form();
  expect(validation({ ...value, ctaLabel:'Shop' },false).length).toBeGreaterThan(0);
  expect(validation({ ...value, ctaLabel:'Shop', ctaPath:'https://outside.example' },false).length).toBeGreaterThan(0);
  expect(validation({ ...value, ctaLabel:'Shop', ctaPath:'/search' },false)).toEqual([]);
});
it('blocks unpublished variables and empty content', () => {
  const value = form();
  expect(validation({ ...value, title:'Hello {{customer.name}}' },false)).toContain('Announcements use plain text. Remove personalized variables and braces.');
  expect(validation({ ...value, body:'  ' },false)).toContain('Message is required.');
});
it('rejects expired, inverted and excessive schedules', () => {
  const value = form();
  expect(validation({ ...value, expiresAt:localTime(new Date(Date.now()-DAY)) },false).length).toBeGreaterThan(0);
  expect(validation({ ...value, startsAt:localTime(new Date(Date.now()+8*DAY)) },false).length).toBeGreaterThan(0);
  expect(validation({ ...value, expiresAt:localTime(new Date(Date.now()+91*DAY)) },false).length).toBeGreaterThan(0);
});
it('accepts scheduled visibility within ninety days', () => {
  const value = form();
  expect(validation({ ...value, startsAt:localTime(new Date(Date.now()+20*DAY)), expiresAt:localTime(new Date(Date.now()+27*DAY)) },false)).toEqual([]);
});

it('requires a selected product only when product-visit targeting is enabled', () => {
  const value = { ...form(), productTargeted: true };
  expect(validation(value, false)).toContain('Choose a product for the visit trigger.');
  expect(validation({ ...value, productId: 'bc0cbb1d-8b21-45e2-8047-b5ac807260f3' }, false)).toEqual([]);
  expect(validation({ ...value, productTargeted: false }, false)).toEqual([]);
});
