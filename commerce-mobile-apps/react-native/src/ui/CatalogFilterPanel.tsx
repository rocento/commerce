import { useContext, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import type { Category, Locale } from '../core/commerce';
import { emptyFilters, validFilters, type CatalogFilters } from '../core/catalogFilters';
import { Button, Copy, Row, UiContext } from './Storefront';
export function CatalogFilterPanel({ categories, category, filters, locale, apply }: { categories: Category[]; category: string; filters: CatalogFilters; locale: Locale; apply: (category: string, filters: CatalogFilters) => void }) {
  const [draft, setDraft] = useState(filters), [selection, setSelection] = useState(category);
  const { colors, rtl } = useContext(UiContext), t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  return <View style={{ flex: 1 }}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 20, gap: 12 }}>
    <Row><Copy style={{ flex: 1, color: colors.muted }}>{t('Refine your results', 'حدد النتائج المناسبة')}</Copy><Pressable accessibilityRole="button" onPress={() => { setDraft(emptyFilters); setSelection(''); }} style={{ minHeight: 44, justifyContent: 'center' }}><Copy style={{ color: colors.primary }}>{t('Reset', 'إعادة تعيين')}</Copy></Pressable></Row>
    <Copy style={{ fontSize: 20, fontWeight: '600' }}>{t('Category', 'الفئة')}</Copy>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: rtl ? 'row-reverse' : 'row' }}>{[{ id: '', name: t('All categories', 'جميع الفئات') }, ...categories].map(c => <Button key={c.id} title={c.name} selected={selection === c.id} secondary onPress={() => setSelection(c.id)} />)}</ScrollView>
    <Copy style={{ fontSize: 20, fontWeight: '600' }}>{t('Sort by', 'ترتيب حسب')}</Copy>
    {(['relevance', 'price_asc', 'price_desc', 'name_asc', 'name_desc'] as const).map((sort, i) => <Pressable key={sort} accessibilityRole="radio" aria-checked={draft.sort === sort} accessibilityState={{ checked: draft.sort === sort }} onPress={() => setDraft(v => ({ ...v, sort }))} style={{ minHeight: 44, flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'center', gap: 12 }}><View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: draft.sort === sort ? colors.primary : colors.border, alignItems: 'center', justifyContent: 'center' }}>{draft.sort === sort && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary }} />}</View><Copy>{[t('Relevance', 'الأكثر صلة'), t('Price: low to high', 'السعر: الأقل أولاً'), t('Price: high to low', 'السعر: الأعلى أولاً'), t('Name: A–Z', 'الاسم: تصاعدياً'), t('Name: Z–A', 'الاسم: تنازلياً')][i]!}</Copy></Pressable>)}
    <Copy style={{ fontSize: 20, fontWeight: '600' }}>{t('Price range', 'نطاق السعر')}</Copy>
    {(['minimum', 'maximum'] as const).map((key, i) => {
      const limit = Math.max(10000, Number(draft.minimum), Number(draft.maximum));
      const value = draft[key] ? Number(draft[key]) : i ? limit : 0;
      return <PriceSlider key={key} label={i ? t('Max price', 'أعلى سعر') : t('Min price', 'أقل سعر')} value={value} limit={limit}
        display={i && !draft.maximum ? t('Any price', 'أي سعر') : value.toLocaleString(locale)}
        onChange={next => setDraft(v => {
          const price = i ? Math.max(next, Number(v.minimum)) : Math.min(next, v.maximum ? Number(v.maximum) : limit);
          return { ...v, [key]: (i ? price === limit : price === 0) ? '' : String(price) };
        })} />;
    })}
    <Row><Copy style={{ flex: 1 }}>{t('In stock only', 'المتوفر فقط')}</Copy><Switch accessibilityLabel={t('In stock only', 'المتوفر فقط')} value={draft.inStock} onValueChange={inStock => setDraft(v => ({ ...v, inStock }))} trackColor={{ true: colors.primary }} /></Row>
    {!validFilters(draft) && <Copy accessibilityRole="alert">{t('Enter a valid price range.', 'أدخل نطاق أسعار صالحاً.')}</Copy>}
    </ScrollView>
    <View style={{ padding: 20, borderTopWidth: 1, borderColor: colors.border }}>
    <Button title={t('Show results', 'عرض النتائج')} disabled={!validFilters(draft)} onPress={() => apply(selection, draft)} />
    </View>
  </View>;
}

function PriceSlider({ label, value, limit, display, onChange }: { label: string; value: number; limit: number; display: string; onChange: (value: number) => void }) {
  const { colors, rtl } = useContext(UiContext);
  const [width, setWidth] = useState(1);
  const update = (x: number) => onChange(Math.round(Math.max(0, Math.min(1, rtl ? 1 - x / width : x / width)) * limit));
  const fraction = value / limit;
  return <View>
    <Copy>{label}: {display}</Copy>
    <View accessibilityRole="adjustable" accessibilityLabel={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={value} aria-valuetext={display} accessibilityValue={{ min: 0, max: limit, now: value, text: display }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={event => onChange(Math.max(0, Math.min(limit, value + (event.nativeEvent.actionName === 'increment' ? 1 : -1))))}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
      onResponderGrant={event => update(event.nativeEvent.locationX)} onResponderMove={event => update(event.nativeEvent.locationX)}
      style={{ height: 48, justifyContent: 'center', marginHorizontal: 14 }}>
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: colors.border }} />
      <View pointerEvents="none" style={{ position: 'absolute', height: 4, width: `${fraction * 100}%`, [rtl ? 'right' : 'left']: 0, backgroundColor: colors.primary }} />
      <View pointerEvents="none" style={{ position: 'absolute', [rtl ? 'right' : 'left']: `${fraction * 100}%`, marginLeft: -14, marginRight: -14, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary }} />
    </View>
  </View>;
}
