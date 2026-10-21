import { useEffect, useState, useSyncExternalStore } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { comparisonRows, type ComparisonStore } from '../core/comparison';
import { imageURL, type CommerceClient, type Locale } from '../core/commerce';
import { Button, Copy } from './Storefront';

export function ComparisonScreen({ store, client, locale, locked, open, ask }: { store: ComparisonStore; client: CommerceClient; locale: Locale; locked: boolean; open: (id:string)=>void; ask:(prompt:string)=>void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const key = JSON.stringify([state.ids, locale, client.pin, client.customer?.id]);
  const [ready, setReady] = useState('');
  const t = (en:string, ar:string) => locale === 'ar' ? ar : en;
  const load = async () => { await store.load(id => client.product(id)); setReady(key); };
  useEffect(() => { void load(); }, [key]);
  const cell = { width: 180, flexShrink: 0 as const, padding: 12 };
  return <View style={{ gap: 16 }}>
    <Copy accessibilityRole="header" style={{ fontSize: 22, fontWeight: '600' }}>{t('Compare products', 'مقارنة المنتجات')}</Copy>
    {state.ids.map((id, index) => <Button key={id} secondary title={`${t('Remove', 'إزالة')} ${state.products.find(p => p.id === id)?.name ?? index + 1}`} disabled={locked} onPress={() => store.toggle(id)} />)}
    {!!state.ids.length && <Button title={t('Clear all', 'مسح الكل')} secondary disabled={locked} onPress={() => store.reset()} />}
    {state.ids.length < 2 && <Copy>{t('Select at least two products to compare', 'اختر منتجين على الأقل للمقارنة')}</Copy>}
    {state.busy && <Copy accessibilityLiveRegion="polite">{t('Loading current product facts', 'تحميل معلومات المنتجات الحالية')}</Copy>}
    {!!state.failed.length && <><Copy accessibilityRole="alert">{t('A selected product is unavailable. Remove it or retry.', 'أحد المنتجات غير متوفر. احذفه أو أعد المحاولة.')}</Copy><Button title={t('Retry', 'إعادة المحاولة')} disabled={locked || state.busy} onPress={() => void load()} /></>}
    {ready === key && !state.busy && !state.failed.length && state.products.length >= 2 && <>
      <ScrollView horizontal accessibilityLabel={t('Product comparison', 'مقارنة المنتجات')}>
        <View>
          <View style={{ flexDirection: 'row' }}><Copy style={cell}>{t('Detail', 'التفاصيل')}</Copy>{state.products.map(p => <View key={p.id} style={cell}>{!!imageURL(p) && <Image source={{uri:imageURL(p)}} style={{width:100,height:100}} />}<Button secondary title={p.name} disabled={locked} onPress={() => open(p.id)} /></View>)}</View>
          {comparisonRows(state.products, locale).map((row,i) => <View key={i} style={{ flexDirection:'row', borderBottomWidth:1, borderBottomColor:'#D8DED9' }}><Copy style={[cell,{fontWeight:'600'}]}>{row.label}</Copy>{row.values.map((value,j) => <Copy key={state.products[j]!.id} style={cell}>{value}</Copy>)}</View>)}
        </View>
      </ScrollView>
      <Copy>{t('Currencies are not converted. Availability depends on delivery location.', 'لا يتم تحويل العملات. يعتمد التوفر على موقع التوصيل.')}</Copy>
      <Button title={t('Ask the shopping assistant', 'اسأل مساعد التسوق')} disabled={locked} onPress={() => ask(store.prompt)} />
    </>}
  </View>;
}
