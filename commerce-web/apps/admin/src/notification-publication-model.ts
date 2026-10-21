import { safeNotificationPath, type GeneratedNotification } from '@commerce/api-client';

export type Audience = 'all' | 'guests' | 'customers';
export type PublicationForm = { title: string; body: string; audience: Audience; areaIds: string[]; areaTargeted: boolean; productTargeted: boolean; productId: string; productName: string; ctaLabel: string; ctaPath: string; startsAt: string; expiresAt: string };
export const DAY = 86400000;
export const localTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function defaultForm(record?: GeneratedNotification): PublicationForm {
  return { title: record?.title ?? '', body: record?.body ?? '', audience: 'customers', areaIds: [], areaTargeted: false, productTargeted: false, productId: '', productName: '', ctaLabel: '', ctaPath: '', startsAt: '', expiresAt: localTime(new Date(Date.now() + 7 * DAY)) };
}

export function validation(form: PublicationForm, targeted: boolean) {
  const errors: string[] = [];
  if (!targeted && form.productTargeted && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(form.productId)) errors.push('Choose a product for the visit trigger.');
  if (!targeted && form.areaTargeted && !form.areaIds.length) errors.push('Choose at least one delivery area.');
  if (form.areaIds.length > 100) errors.push('Choose at most 100 delivery areas.');
  for (const [name, value, max, multiline] of [['Title', form.title, targeted ? 2000 : 200, false], ['Message', form.body, targeted ? 32000 : 8000, true]] as const) {
    if (!value.trim()) errors.push(`${name} is required.`);
    if ([...value].length > max) errors.push(`${name} must be ${max.toLocaleString()} characters or fewer.`);
    if ([...value].some(character => /[\u0000-\u001f\u007f-\u009f]/.test(character) && !(multiline && ['\n', '\t'].includes(character)))) errors.push(`${name} contains an unsupported control character.`);
    if (!targeted && /[{}]/.test(value)) errors.push('Announcements use plain text. Remove personalized variables and braces.');
  }
  const label = form.ctaLabel.trim(), path = form.ctaPath.trim();
  if (!!label !== !!path) errors.push('Provide both an action label and a storefront path, or leave both empty.');
  if ([...label].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) errors.push('The action label must be one line and at most 80 characters.');
  if (path && (path.length > 300 || !safeNotificationPath(path))) errors.push('Use a supported internal storefront path without query strings or fragments.');
  const now = Date.now(), start = form.startsAt ? new Date(form.startsAt).getTime() : now, expiry = new Date(form.expiresAt).getTime();
  if (!Number.isFinite(start) || start < now - 5 * 60000 || start > now + 90 * DAY) errors.push('Choose a start time within the next 90 days.');
  if (!Number.isFinite(expiry) || expiry <= now || expiry <= start || expiry > start + 90 * DAY) errors.push('Choose an expiry after the start time and within 90 days of it.');
  return [...new Set(errors)];
}

