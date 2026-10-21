import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatInterfaceMessage } from '@commerce/api-client';
import { parseInterfacePreview } from './interface-preview';
import catalog from './interface-messages.json';
import { readShopperLocale, saveShopperLocale, shopperLocale, SHOPPER_LOCALE_KEY } from './shopper-locale';

afterEach(() => vi.unstubAllGlobals());
it('restores only supported locales and persists the shopper selection', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)});
  expect(readShopperLocale()).toBe('en');
  saveShopperLocale('ar');
  expect(values.get(SHOPPER_LOCALE_KEY)).toBe('ar');
  expect(readShopperLocale()).toBe('ar');
  saveShopperLocale('en');
  expect(readShopperLocale()).toBe('en');
  expect(shopperLocale('fr')).toBe('en');
});
it('still works when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {getItem: () => {throw new Error('blocked');}, setItem: () => {throw new Error('blocked');}});
  expect(readShopperLocale()).toBe('en');
  expect(() => saveShopperLocale('ar')).not.toThrow();
});
it('ships the source catalog without draft overrides and formats Arabic plural counts', () => {
  expect(catalog).toEqual(JSON.parse(readFileSync(new URL('../../../../commerce-api/interface-messages.json', import.meta.url), 'utf8')));
  const bundle = parseInterfacePreview({revision: 1, catalog_version: 'bundled', messages: catalog.messages.map(message => ({plural: null, ...message})), overrides: []});
  expect(bundle.overrides).toEqual([]);
  expect(formatInterfaceMessage(bundle, 'navigation.account', 'ar')).toBe('حسابي');
  for (const count of [0, 1, 2, 3, 11, 100]) {
    const text = formatInterfaceMessage(bundle, 'cart.item_count', 'ar', {count});
    expect(text).not.toContain('{count}');
    expect(text).toMatch(/[\u0600-\u06ff]/);
  }
});

it('accepts configured regional locales and falls back to the store source locale', () => {
  expect(shopperLocale('fr-CA',['en','fr-CA','ar-EG'])).toBe('fr-CA');
  expect(shopperLocale('ar-EG',['en','fr-CA','ar-EG'])).toBe('ar-EG');
  expect(shopperLocale('de',['fr','ar'])).toBe('fr');
});
