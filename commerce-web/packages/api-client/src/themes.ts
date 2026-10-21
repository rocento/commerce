import { deliveryHeaders } from './delivery';
import rawContract from './theme-contract.json';
import { ApiError, customerSessionHeaders, withCustomerSession } from './identity';
import { traceFetch } from './telemetry';
import type { CatalogImage } from './catalog';

export type ThemeValue = string | number | null;
export interface ThemeProperty { kind: string; default: ThemeValue; min?: number | null; max?: number | null; options?: string[] | null }
export interface ThemeDefinition { label: string; version: number; locations: string[]; required: boolean; settings: Record<string, ThemeProperty> }
export interface ThemeTranslation { source: string; value: string }
export interface ThemeSection { id: string; component: string; version: number; enabled: boolean; settings: Record<string, ThemeValue>; translations?: Record<string, Record<string, ThemeTranslation>> }
export type ThemePage = 'home' | 'category' | 'product' | 'search' | 'cart';
export interface ThemeConfiguration { schema_version: string; tokens: Record<string, ThemeValue>; global: Record<'top' | 'bottom', ThemeSection[]>; pages: Record<ThemePage, ThemeSection[]> }
export type ResolvedTheme = { version_id: string | null; configuration: ThemeConfiguration; cities: string[]; images?: Record<string, CatalogImage>; discovery_attribution_enabled?: boolean };
export interface Theme { id: string; readonly entity_id?: number; name: string; owner_channel: string; revision: number; configuration: ThemeConfiguration; published_version: string | null; updated_at: string }
export interface ThemeVersion { id: string; readonly entity_id?: number; theme_id: string; number: number; configuration: ThemeConfiguration; created_by: string; published_at: string; source_version: string | null }
export interface ThemeTargetRule { id: string; theme_id: string; enabled: boolean; segment_id: string | null; area_id: string | null; stock_id: string | null; city: string | null }
export interface ThemeAssignment { channel: string; theme_id: string | null; revision: number; rules?: ThemeTargetRule[] }
export interface ThemeTargetOptions { segments: {id: string; name: string}[]; stocks: {id: string; name: string}[]; areas: {id: string; name: string; is_active: boolean; stocks: {stock_id: string}[]}[] }
export const themeContract = rawContract as unknown as { schema_version: string; tokens: Record<string, ThemeProperty>; components: Record<string, ThemeDefinition>; default: ThemeConfiguration };
export const defaultTheme = (): ThemeConfiguration => structuredClone(themeContract.default);
export const themeAllowed = (permissions: string[], op: string, channel: string) => permissions.some(p => p === '*' || p === `theme.${op}` || p === `theme.${op}@${channel}`);
export const safeThemeLink = (s: string) => s.startsWith('/') && !s.startsWith('//') && s.length <= 2000 && !/[\\%\s\x00-\x1f\x7f]/.test(s);
export function validThemeValue(p: ThemeProperty, value: unknown): boolean {
  switch (p.kind) {
    case 'color': return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
    case 'number': return typeof value === 'number' && Number.isInteger(value) && value >= (p.min ?? 0) && value <= (p.max ?? 4096);
    case 'select': return typeof value === 'string' && !!p.options?.includes(value);
    case 'link': return typeof value === 'string' && safeThemeLink(value);
    case 'asset': return value === null || typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
    case 'text': return typeof value === 'string' && new TextEncoder().encode(value).length >= (p.min ?? 0) && new TextEncoder().encode(value).length <= (p.max ?? 200) && !/[<>\x00-\x09\x0b-\x1f\x7f]/.test(value);
    default: return false;
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export function validateTheme(c: unknown): string[] {
  const errors: string[] = [];
  if (!record(c) || !record(c.tokens) || !record(c.global) || !record(c.pages)) return ['Missing theme configuration'];
  if (!exactKeys(c, ['schema_version', 'tokens', 'global', 'pages'])) errors.push('Missing or unknown configuration fields');
  if (!exactKeys(c.global, ['bottom', 'top']) || !exactKeys(c.pages, ['cart', 'category', 'home', 'product', 'search'])) return ['Missing or unknown layouts'];
  if (c.schema_version !== themeContract.schema_version) errors.push('Unsupported schema version');
  const properties = (defs: Record<string, ThemeProperty>, values: Record<string, unknown>, path: string) => {
    if (!exactKeys(values, Object.keys(defs))) errors.push(`${path}: missing or unknown settings`);
    for (const [key, def] of Object.entries(defs)) if (!validThemeValue(def, values[key])) errors.push(`${path}: ${key}`);
  };
  const tokens = { ...c.tokens };
  for (const key of ['grid.columns.desktop', 'grid.columns.tablet', 'grid.columns.mobile', 'layout.direction', 'font.arabic.body', 'font.arabic.heading', 'font.size-offset']) {
    if (!Object.hasOwn(tokens, key)) tokens[key] = themeContract.tokens[key].default;
  }
  properties(themeContract.tokens, tokens, 'Tokens');
  if (Number(c.tokens['breakpoint.mobile']) >= Number(c.tokens['breakpoint.desktop'])) errors.push('Breakpoints must increase');
  const ids = new Set<string>();
  for (const [location, sections] of Object.entries({ ...c.global, ...c.pages })) {
    if (!Array.isArray(sections)) { errors.push(`${location}: invalid layout`); continue; }
    if (sections.length > 30) errors.push(`${location}: at most 30 sections`);
    for (const section of sections) {
      if (!record(section) || !record(section.settings)) { errors.push('Invalid section'); continue; }
      if (!exactKeys(section, ['id', 'component', 'version', 'enabled', 'settings', ...(Object.hasOwn(section, 'translations') ? ['translations'] : [])]) || typeof section.enabled !== 'boolean') errors.push('Invalid section fields');
      if (typeof section.id !== 'string' || !/^[a-z\d-]{1,80}$/i.test(section.id) || ids.has(section.id)) { errors.push('Section IDs must be unique'); continue; }
      ids.add(section.id);
      const def = typeof section.component === 'string' && Object.hasOwn(themeContract.components, section.component) ? themeContract.components[section.component] : undefined;
      if (!def || def.version !== section.version || !def.locations.includes(location)) { errors.push(`${section.id}: unknown component or version`); continue; }
      if (def.required && !section.enabled) errors.push(`${def.label} is required`);
      // Themes published before the cart display option keep the original sidebar behavior.
      const settings = { ...section.settings };
      if (section.component === 'header_options' && !Object.hasOwn(settings, 'cart_display')) {
        settings.cart_display = def.settings.cart_display.default;
      }
      if (section.component === 'footer_options') {
        for (const [key, property] of Object.entries(def.settings)) if ((key === 'back_to_top_label' || key.startsWith('install_')) && !Object.hasOwn(settings, key)) settings[key] = property.default;
      }
      properties(def.settings, settings, def.label);
      if (Object.hasOwn(section, 'translations')) {
        if (!record(section.translations) || Object.keys(section.translations).length > 32) errors.push(`${section.id}: invalid translations`);
        else for (const [locale, fields] of Object.entries(section.translations)) {
          if (!validThemeLocale(locale) || !record(fields)) { errors.push(`${section.id}: invalid translation locale or fields`); continue; }
          for (const [key, field] of Object.entries(fields)) {
            const property = def.settings[key];
            if (!property || !themeTextTranslatable(key, property) || !record(field) || !exactKeys(field, ['source', 'value']) || typeof field.source !== 'string' || !validThemeValue({...property, min: 0}, field.source) || !validThemeValue(property, field.value) || typeof field.value !== 'string' || !field.value.trim()) errors.push(`${section.id}: invalid ${locale} translation for ${key}`);
          }
        }
      }
      if (section.settings.image && !String(section.settings.alt || '').trim()) errors.push(`${def.label}: image alt text required`);
    }
    for (const [key, def] of Object.entries(themeContract.components)) if (def.required && def.locations.includes(location) && sections.filter(s => record(s) && s.component === key).length !== 1) errors.push(`${location}: exactly one ${def.label} required`);
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(c)).length > 128 * 1024) errors.push('Configuration exceeds 128 KiB');
  } catch { errors.push('Configuration must be JSON serializable'); }
  return errors;
}
export const validThemeLocale = (locale: string) => /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/.test(locale);
export const themeTextTranslatable = (key: string, property: ThemeProperty) => property.kind === 'text' && key !== 'query';
export function themeTranslationIssues(config: ThemeConfiguration): string[] {
  return Object.values({...config.global, ...config.pages}).flat().flatMap(section => Object.entries(section.translations ?? {}).flatMap(([locale, fields]) => Object.entries(fields).filter(([key, field]) => field.source !== (section.settings[key] ?? (section.component === 'footer_options' ? themeContract.components.footer_options.settings[key]?.default : undefined))).map(([key]) => `${locale} · ${section.id} · ${key}: source changed; review the translation`)));
}
export function localizeTheme(config: ThemeConfiguration, locale: string): ThemeConfiguration {
  const localize = (section: ThemeSection): ThemeSection => {
    const fields = section.translations?.[locale];
    if (!fields) return section;
    const settings = {...(section.component === 'footer_options' ? Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).map(([key, property]) => [key, property.default])) : {}), ...section.settings};
    for (const [key, field] of Object.entries(fields)) if (field.source === settings[key] && field.value.trim()) settings[key] = field.value;
    return {...section, settings};
  };
  return {...config, global: {top: config.global.top.map(localize), bottom: config.global.bottom.map(localize)}, pages: Object.fromEntries(Object.entries(config.pages).map(([key, sections]) => [key, sections.map(localize)])) as ThemeConfiguration['pages']};
}
async function request<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await traceFetch(`/api/v1/${path}`, { method, credentials: 'include', cache: path.startsWith('theme/') ? 'no-cache' : 'no-store', headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({ error: `Theme request failed (${response.status})` }));
  if (!response.ok) throw new ApiError(data.error || 'Theme request failed', response.status);
  return data as T;
}
export const themeApi = {
  list: () => request<Theme[]>('admin/themes'),
  get: (id: string) => request<Theme>(`admin/themes/${id}`),
  create: (name: string, owner_channel: string, source?: string) => request<Theme>('admin/themes', 'POST', { name, owner_channel, source }),
  save: (id: string, expected_revision: number, configuration: ThemeConfiguration) => request<Theme>(`admin/themes/${id}`, 'PUT', { expected_revision, configuration }),
  validate: (id: string) => request<{ valid: boolean }>(`admin/themes/${id}/validate`, 'POST'),
  preview: (id: string) => request<ThemeConfiguration>(`admin/themes/${id}/preview`),
  publish: (id: string, expected_revision: number, source_version?: string) => request<ThemeVersion>(`admin/themes/${id}/publish`, 'POST', { expected_revision, source_version }),
  versions: (id: string) => request<ThemeVersion[]>(`admin/themes/${id}/versions`),
  version: (id: string, version: string) => request<ThemeVersion>(`admin/themes/${id}/versions/${version}`),
  assignments: () => request<ThemeAssignment[]>('admin/themes/assignments'),
  targetOptions: (channel: string) => request<ThemeTargetOptions>(`admin/themes/target-options/${encodeURIComponent(channel)}`),
  assign: (channel: string, expected_revision: number, theme_id: string | null, rules: ThemeTargetRule[] = []) => request<ThemeAssignment>(`admin/themes/assignments/${encodeURIComponent(channel)}`, 'PUT', { expected_revision, theme_id, rules }),
  resolve: (channel: string, city = '') => withCustomerSession(() => request<ResolvedTheme>(`theme/${encodeURIComponent(channel)}${city ? `?city=${encodeURIComponent(city)}` : ""}`, 'GET', undefined, { ...customerSessionHeaders(), ...deliveryHeaders() })),
};
