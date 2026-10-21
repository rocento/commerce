import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LocationInput } from '@commerce/api-client';
import { clearDeliverySelection, selectDeliveryCountry, findDeliveryCities, loadDeliveryCities, geographyLabel, matchesCity, selectDeliveryCity, type DeliveryCity, type DeliveryDirectory } from './delivery-geography';
const index: DeliveryDirectory = JSON.parse(readFileSync(new URL('../public/data/delivery/eg/index.json', import.meta.url), 'utf8'));
const input: LocationInput = { label: 'home', latitude: NaN, longitude: NaN, formatted_address: '12 Test Street' };
describe('Egypt delivery directory', () => {
  it('has all 27 governorates, valid coordinates, unique places, and nonempty dependent city lists', () => {
    expect(index.country.code).toBe('EG');
    expect(index.states).toHaveLength(27);
    const ids = new Set<string>();
    for (const state of index.states) {
      const cities: DeliveryCity[] = JSON.parse(readFileSync(new URL(`../public/data/delivery/eg/${state.code}.json`, import.meta.url), 'utf8'));
      expect(cities.length).toBe(state.city_count);
      expect(cities.length).toBeGreaterThan(0);
      for (const city of cities) {
        expect(ids.has(city.id)).toBe(false); ids.add(city.id);
        expect(city.name.length).toBeGreaterThan(0);
        expect(city.latitude).toBeGreaterThanOrEqual(21);
        expect(city.latitude).toBeLessThanOrEqual(32);
        expect(city.longitude).toBeGreaterThanOrEqual(24);
        expect(city.longitude).toBeLessThanOrEqual(37);
      }
    }
  });
  it('selects a sourced city without inventing an entrance pin, and clears coordinates on method changes', () => {
    const state = index.states.find(state => state.code === '11')!;
    const cities: DeliveryCity[] = JSON.parse(readFileSync(new URL('../public/data/delivery/eg/11.json', import.meta.url), 'utf8'));
    const city = cities.find(city => city.name === 'New Cairo')!;
    const selected = selectDeliveryCity(input, state, city);
    expect(selected.location_method).toBe('neighborhood');
    expect(selected.latitude).toBe(city.latitude);
    expect(selected.formatted_address).toBe('12 Test Street');
    expect(geographyLabel(selected)).toBe('New Cairo, Cairo, Egypt');
    expect(matchesCity(city, 'القاهرة الجديدة')).toBe(true);
    const switched = clearDeliverySelection(selected, 'pin');
    expect(switched.geography).toBeNull();
    expect(Number.isNaN(switched.latitude)).toBe(true);
    expect(Number.isNaN(switched.longitude)).toBe(true);
    expect(switched.formatted_address).toBe('12 Test Street');
  });
});

describe('international delivery directory', () => {
  it('bundles complete first-level divisions with valid, unique sourced places', () => {
    const countries = { SA: 13, KW: 6, US: 51, NL: 12, GB: 4 };
    for (const [country, count] of Object.entries(countries)) {
      const base = `../public/data/delivery/${country.toLowerCase()}/`;
      const manifest = JSON.parse(readFileSync(new URL(base + 'index.json', import.meta.url), 'utf8'));
      expect(manifest.country.code).toBe(country);
      expect(manifest.states).toHaveLength(count);
      expect(manifest.source_sha256).toMatch(/^[a-f0-9]{64}$/);
      const ids = new Set<string>();
      for (const state of manifest.states) {
        const places: DeliveryCity[] = JSON.parse(readFileSync(new URL(base + state.code + '.json', import.meta.url), 'utf8'));
        expect(places.length).toBe(state.city_count);
        expect(places.length).toBeGreaterThan(0);
        for (const place of places) {
          if (ids.has(place.id) || !place.name || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180) throw new Error(`Invalid ${country}/${state.code}/${place.id}`);
          ids.add(place.id);
        }
      }
      expect(ids.size).toBe(manifest.city_count);
    }
  });
  it('clears dependent fields and coordinates when changing countries', () => {
    const old = { ...input, latitude: 30, longitude: 31, geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '123', city_name: 'Cairo' } };
    const value = selectDeliveryCountry(old, 'US');
    expect(value.geography).toEqual({ country_code: 'US', state_code: '', state_name: '', city_id: '', city_name: '' });
    expect(Number.isNaN(value.latitude)).toBe(true);
    expect(value.formatted_address).toBe(old.formatted_address);
    const selected = selectDeliveryCity(value, { code: 'CA', name: 'California', name_ar: '', city_count: 1 }, { id: '1234', name: 'Los Angeles', aliases: [], latitude: 34, longitude: -118, population: 1 });
    expect(selected.geography?.country_code).toBe('US');
    expect(geographyLabel(selected)).toBe('Los Angeles, California, United States');
    expect(() => selectDeliveryCountry(old, '../US')).toThrow();
  });
  it('bounds rendering while keeping places beyond the initial page searchable', () => {
    const cities = Array.from({ length: 1000 }, (_, n) => ({ id: String(n), name: `Place ${n}`, aliases: n === 999 ? ['القاهرة', 'Den Háág'] : [], latitude: 1, longitude: 1, population: 0 }));
    expect(findDeliveryCities(cities, '').options).toHaveLength(60);
    expect(findDeliveryCities(cities, '').hasMore).toBe(true);
    expect(findDeliveryCities(cities, 'den haag').options[0].id).toBe('999');
    expect(findDeliveryCities(cities, 'القاهرة').options[0].id).toBe('999');
  });
  it('uses country-scoped paths and passes cancellation to fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([])));
    try {
      const signal = new AbortController().signal;
      await loadDeliveryCities('ENG', 'GB', signal);
      expect(fetcher).toHaveBeenCalledWith('/data/delivery/gb/ENG.json', { signal });
      await expect(loadDeliveryCities('../EG', 'US')).rejects.toThrow();
      await expect(loadDeliveryCities('CA', 'ZZ')).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { fetcher.mockRestore(); }
  });
});
