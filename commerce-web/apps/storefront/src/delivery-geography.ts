import type { LocationInput } from '@commerce/api-client';

export type Geography = NonNullable<LocationInput['geography']>;
export type DeliveryState = { code: string; name: string; name_ar: string; city_count: number };
export type DeliveryDirectory = { country: { code: string; name: string; name_ar: string }; state_label?: string; states: DeliveryState[] };
export type DeliveryCity = { id: string; name: string; aliases: string[]; latitude: number; longitude: number; population: number; district?: string };
export const deliveryCountries = [
  { code: 'EG', name: 'Egypt', name_ar: 'مصر', stateLabel: 'Governorate' },
  { code: 'SA', name: 'Saudi Arabia', name_ar: 'المملكة العربية السعودية', stateLabel: 'Region' },
  { code: 'KW', name: 'Kuwait', name_ar: 'الكويت', stateLabel: 'Governorate' },
  { code: 'US', name: 'United States', name_ar: '', stateLabel: 'State / District' },
  { code: 'NL', name: 'Netherlands', name_ar: '', stateLabel: 'Province' },
  { code: 'GB', name: 'United Kingdom', name_ar: '', stateLabel: 'Constituent country' },
] as const;
export function deliveryCountry(code: string) {
  const country = deliveryCountries.find(country => country.code === code);
  if (!country) throw new Error('Choose a supported country.');
  return country;
}
async function read<T>(country: string, file: string, signal?: AbortSignal): Promise<T> {
  deliveryCountry(country);
  if (!/^(?:index|[A-Z0-9]{1,12})$/.test(file)) throw new Error('Choose a region first.');
  const response = await fetch(`${import.meta.env.BASE_URL}data/delivery/${country.toLowerCase()}/${file}.json`, { signal });
  if (!response.ok) throw new Error('Location directory is unavailable. Please retry or choose a map pin.');
  return response.json();
}
export async function loadDeliveryDirectory(country = 'EG', signal?: AbortSignal) {
  const data = await read<DeliveryDirectory>(country, 'index', signal);
  if (data.country?.code !== country || !Array.isArray(data.states) || !data.states.length || data.states.some(state => !/^[A-Z0-9]{1,12}$/.test(state.code) || !state.name || !Number.isInteger(state.city_count))) {
    throw new Error('Invalid location directory. Please retry or choose a map pin.');
  }
  return data;
}
export async function loadDeliveryCities(state: string, country = 'EG', signal?: AbortSignal) {
  if (!/^[A-Z0-9]{1,12}$/.test(state)) throw new Error('Choose a region first.');
  const data = await read<DeliveryCity[]>(country, state, signal);
  if (!Array.isArray(data) || data.some(city => !/^\d+$/.test(city.id) || !city.name || !Array.isArray(city.aliases) || !city.aliases.every(alias => typeof alias === 'string') || !Number.isFinite(city.latitude) || !Number.isFinite(city.longitude) || Math.abs(city.latitude) > 90 || Math.abs(city.longitude) > 180)) {
    throw new Error('Invalid city directory. Please retry or choose a map pin.');
  }
  return data;
}
export const emptyGeography = (country = ''): Geography => ({ country_code: country, state_code: '', state_name: '', city_id: '', city_name: '' });
export function clearDeliverySelection(value: LocationInput, location_method: 'pin' | 'neighborhood'): LocationInput {
  return { ...value, location_method, geography: null, latitude: NaN, longitude: NaN };
}
export function selectDeliveryCountry(value: LocationInput, country: string): LocationInput {
  if (country) deliveryCountry(country);
  return { ...clearDeliverySelection(value, 'neighborhood'), geography: emptyGeography(country) };
}
export function selectDeliveryCity(value: LocationInput, state: DeliveryState, city: DeliveryCity): LocationInput {
  const country = deliveryCountry(value.geography?.country_code || 'EG');
  return { ...value, location_method: 'neighborhood', latitude: city.latitude, longitude: city.longitude,
    geography: { country_code: country.code, state_code: state.code, state_name: state.name, city_id: city.id, city_name: city.name } };
}
export function geographyLabel(value: Pick<LocationInput, 'geography'>) {
  const geography = value.geography;
  return geography ? [geography.city_name, geography.state_name, deliveryCountries.find(country => country.code === geography.country_code)?.name ?? geography.country_code].filter(Boolean).join(', ') : '';
}
const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const citySearchText = new WeakMap<DeliveryCity, string>();
export function matchesCity(city: DeliveryCity, search: string) {
  const query = normalize(search.trim());
  if (!query) return true;
  let text = citySearchText.get(city);
  if (text === undefined) { text = [city.name, city.district ?? "", ...city.aliases].map(normalize).join('\n'); citySearchText.set(city, text); }
  return text.includes(query);
}
/** Bound rendered choices; all places remain searchable, including small villages. */
export function findDeliveryCities(cities: DeliveryCity[], query: string, limit = 60) {
  const matches: DeliveryCity[] = [];
  for (const city of cities) {
    if (matchesCity(city, query)) matches.push(city);
    if (matches.length > limit) break;
  }
  return { options: matches.slice(0, limit), hasMore: matches.length > limit };
}
