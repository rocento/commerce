import { useEffect, useState } from 'react';
import { View, TextInput, ActivityIndicator, Linking } from 'react-native';
import { Button, Copy } from './Storefront';
import type { AddressDraft } from '../core/delivery';
import { validPin, merchant } from '../core/commerce';

type Region = { code: string; name: string; name_ar: string };
type City = { id: string; name: string; aliases: string[]; latitude: number; longitude: number };
const countries = [['EG', 'Egypt', 'مصر'], ['SA', 'Saudi Arabia', 'السعودية'], ['KW', 'Kuwait', 'الكويت'], ['US', 'United States', 'الولايات المتحدة'], ['NL', 'Netherlands', 'هولندا'], ['GB', 'United Kingdom', 'المملكة المتحدة']] as const;
export function DeliveryNeighborhood({ locale, draft, edit }: { locale: string; draft: AddressDraft; edit: (change: Partial<AddressDraft>) => void }) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [country, setCountry] = useState(draft.geography?.country_code ?? ''), [region, setRegion] = useState(draft.geography?.state_code ?? '');
  const [regions, setRegions] = useState<Region[]>([]), [cities, setCities] = useState<City[]>([]);
  const [choosingCity, setChoosingCity] = useState(!draft.geography);
  const [choosing, setChoosing] = useState<'country' | 'region' | null>(draft.geography ? null : 'country');
  const [search, setSearch] = useState(''), [failed, setFailed] = useState(false), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const clear = () => { setCities([]); setSearch(''); edit({ geography: null, latitude: '', longitude: '' }); };
  useEffect(() => {
    if (!country) return;
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    void (async () => {
      try {
        const read = async (file: string) => {
          const url = new URL(`/data/delivery/${country.toLowerCase()}/${file}.json`, merchant.origin);
          const response = await fetch(url.toString(), { signal: controller.signal, credentials: 'omit' });
          if (!response.ok) throw new Error('Directory unavailable');
          return response.json();
        };
        const [directory, data] = await Promise.all([read('index'), region ? read(region) : Promise.resolve(null)]);
        if (controller.signal.aborted) return;
        if (!Array.isArray(directory.states) || directory.states.some((state: Region) => !/^[A-Z0-9]{1,12}$/.test(state.code) || !state.name)) throw new Error('Invalid regions');
        setRegions(directory.states);
        if (region) {
          if (!Array.isArray(data) || data.some(city => !validPin(city) || typeof city.name !== 'string' || !Array.isArray(city.aliases))) throw new Error('Invalid cities');
          setCities(data);
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [country, region, retry]);
  const matches = cities.filter(city => !search.trim() || [city.name, ...city.aliases].some(name => name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  return <View style={{ gap: 8 }}>
    <Copy>{t('Country', 'الدولة')}</Copy>
    <Button title={countries.find(item => item[0] === country)?.[locale === 'ar' ? 2 : 1] ?? t('Choose country', 'اختر الدولة')} secondary onPress={() => setChoosing(choosing === 'country' ? null : 'country')} />
    {choosing === 'country' && countries.map(([code, en, ar]) => <Button key={code} title={t(en, ar)} secondary selected={country === code} onPress={() => { if (country === code) { setChoosing(null); return; } setChoosingCity(true); setChoosing('region'); setCountry(code); setRegion(''); setRegions([]); clear(); }} />)}
    <Copy>{t('Region', 'المنطقة')}</Copy>
    <Button title={regions.find(item => item.code === region)?.name ?? t('Choose region', 'اختر المنطقة')} secondary disabled={!regions.length} onPress={() => setChoosing(choosing === 'region' ? null : 'region')} />
    {choosing === 'region' && regions.map(state => <Button key={state.code} title={t(state.name, state.name_ar || state.name)} secondary selected={region === state.code} onPress={() => { setChoosing(null); if (region === state.code) return; setChoosingCity(true); setRegion(state.code); clear(); }} />)}
    <TextInput accessibilityLabel={t('Search city or neighborhood', 'ابحث عن المدينة أو الحي')} placeholder={t('Search city or neighborhood', 'ابحث عن المدينة أو الحي')} value={search} onChangeText={value => { setSearch(value); setChoosingCity(true); }} editable={cities.length > 0} style={{ padding: 12, borderWidth: 1, borderColor: '#888', borderRadius: 8 }} />
    {loading && <ActivityIndicator />}
    {failed && <><Copy>{t('Location list unavailable.', 'قائمة المواقع غير متاحة.')}</Copy><Button title={t('Retry', 'إعادة المحاولة')} secondary onPress={() => setRetry(value => value + 1)} /></>}
    {draft.geography && <Button title={draft.geography.city_name ?? ''} secondary onPress={() => setChoosingCity(true)} />}
    {choosingCity && matches.slice(0, 60).map(city => <Button key={city.id} title={city.name} secondary selected={draft.geography?.city_id === city.id} onPress={() => {
      const state = regions.find(value => value.code === region);
      if (!state || !validPin(city)) return;
      setChoosingCity(false);
      edit({ latitude: String(city.latitude), longitude: String(city.longitude), geography: { country_code: country, state_code: region, state_name: state.name, city_id: city.id, city_name: city.name } });
    }} />)}
    {choosingCity && matches.length > 60 && <Copy>{t('Type more to narrow the results.', 'اكتب المزيد لتضييق النتائج.')}</Copy>}
    <Copy>{t('No pin needed. Choose your area, then enter your street and building below.', 'لا يلزم دبوس. اختر منطقتك ثم أدخل الشارع والمبنى أدناه.')}</Copy>
    <Button title="GeoNames · CC BY 4.0" secondary onPress={() => void Linking.openURL('https://www.geonames.org/')} />
  </View>;
}
