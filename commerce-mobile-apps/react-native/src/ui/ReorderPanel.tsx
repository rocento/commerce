import { useState, useSyncExternalStore } from 'react';
import { Switch, TextInput, View } from 'react-native';
import type { CommerceClient, LiveProduct, Locale, Order } from '../core/commerce';
import { CommerceError } from '../core/commerce';
import type { ShoppingSession } from '../core/shoppingSession';
import { Button, Copy, Row } from './Storefront';

export function ReorderPanel({ order, session, client, locale, locked, run, checkout }: {
  order: Order; session: ShoppingSession; client: CommerceClient; locale: Locale; locked: boolean;
  run: (operation: () => Promise<void>) => Promise<void>; checkout: () => void;
}) {
  const store = session.reorder;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [location, setLocation] = useState(''), [replace, setReplace] = useState(false);
  const [alternative, setAlternative] = useState(''), [query, setQuery] = useState(''), [results, setResults] = useState<LiveProduct[]>([]);
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const busy = locked || state.busy;
  const p = state.proposal;
  if (state.order?.id !== order.id || !state.task) return <Button title={t('Reorder', 'إعادة الطلب')} disabled={busy} onPress={() => void run(() => store.start(order))} />;
  return <View style={{ gap: 16 }}>
    <Copy accessibilityRole="header" style={{ fontSize: 20, fontWeight: '600' }}>{t('Reorder', 'إعادة الطلب')} #{order.number}</Copy>
    {state.done ? <>
      <Copy>{t('Your reorder cart is ready', 'سلة إعادة الطلب جاهزة')}</Copy>
      <Button title={t('Continue to checkout', 'متابعة لإتمام الشراء')} disabled={busy} onPress={() => void run(async () => {
        await session.delivery.refresh(); const address = session.delivery.getSnapshot().locations.find(l => l.id === p?.draft.location_id);
        if (!address) throw new CommerceError(409, t('Confirm a saved delivery address before checkout', 'أكد عنوان توصيل محفوظ قبل إتمام الشراء'));
        await session.delivery.choose(address);
        checkout();
      })} />
      <Button title={t('Start another reorder', 'بدء إعادة طلب أخرى')} secondary disabled={busy} onPress={() => void run(() => store.start(order, true))} />
    </> : !p ? <>
      <Copy>{t('Current basket', 'السلة الحالية')}</Copy>
      {state.cart?.items.map(i => <Copy key={i.product_id}>{i.quantity} × {i.name} · {i.line_total} {state.cart?.currency}</Copy>)}
      {!!state.cart?.items.length && <Row><Copy style={{ flex: 1 }}>{t('Empty the current cart before rebuilding this order', 'إفراغ السلة الحالية قبل إعادة هذا الطلب')}</Copy><Switch accessibilityLabel={t('Replace current cart', 'استبدال السلة الحالية')} value={replace} disabled={busy} onValueChange={setReplace} /></Row>}
      <Copy>{t('Confirm delivery address', 'تأكيد عنوان التوصيل')}</Copy>
      {state.locations.map(l => <Button key={l.id} title={l.formatted_address} selected={location === l.id} secondary disabled={busy} onPress={() => setLocation(l.id)} />)}
      {!state.locations.length && <Copy>{t('Add a saved address in your account, then reload.', 'أضف عنواناً محفوظاً في الحساب ثم أعد التحميل.')}</Copy>}
      <Button title={replace ? t('Empty cart & review reorder', 'إفراغ السلة ومراجعة إعادة الطلب') : t('Keep cart & review reorder', 'الاحتفاظ بالسلة ومراجعة إعادة الطلب')} disabled={busy || !state.locations.some(l => l.id === location)} onPress={() => void run(() => store.prepare(location, replace))} />
    </> : <>
      <Copy>{t('Review proposed basket', 'مراجعة السلة المقترحة')}</Copy>
      {p.lines.map(line => <View key={line.selection.product_id} style={{ gap: 8 }}>
        <Copy>{line.product?.name ?? t('Unavailable product', 'منتج غير متوفر')} · {line.selection.quantity}</Copy>
        {!!line.historical_price && <Copy>{t('Previous unit price', 'سعر الوحدة السابق')}: {line.historical_price}</Copy>}
        <Row><Button title="−" label={t('Decrease quantity', 'تقليل الكمية')} disabled={busy || state.pending || line.selection.quantity <= 1} onPress={() => void run(() => store.revise(p.draft.selections.map(s => s.product_id === line.selection.product_id ? { ...s, quantity: s.quantity - 1 } : s)))} />
          <Button title="+" label={t('Increase quantity', 'زيادة الكمية')} disabled={busy || state.pending || line.selection.quantity >= 1_000_000} onPress={() => void run(() => store.revise(p.draft.selections.map(s => s.product_id === line.selection.product_id ? { ...s, quantity: s.quantity + 1 } : s)))} />
          <Button title={t('Remove', 'إزالة')} secondary disabled={busy || state.pending || p.draft.selections.length < 2} onPress={() => void run(() => store.revise(p.draft.selections.filter(s => s.product_id !== line.selection.product_id)))} /></Row>
        <Button title={t('Choose replacement', 'اختيار بديل')} secondary disabled={busy || state.pending} onPress={() => { setAlternative(line.selection.product_id); setResults([]); setQuery(''); }} />
      </View>)}
      {!!alternative && <><TextInput accessibilityLabel={t('Search replacement', 'البحث عن بديل')} value={query} onChangeText={setQuery} style={{ minHeight: 48, borderWidth: 1, padding: 12 }} />
        <Button title={t('Search', 'بحث')} disabled={busy || !query.trim()} onPress={() => void run(async () => { const page = await client.search(query); setResults(page.hits.filter(v => v.in_stock && v.active !== false && v.product_type !== 'configurable' && !p.draft.selections.some(s => s.product_id === v.id))); })} />
        {results.map(product => <Button key={product.id} title={`${product.name} · ${product.price} ${product.currency}`} secondary disabled={busy || state.pending} onPress={() => void run(async () => { await store.revise([...p.draft.selections.filter(s => s.product_id !== alternative), { product_id: product.id, quantity: 1, replaces: null, required_attributes: {}, reason: 'Customer selected replacement' }]); setAlternative(''); })} />)}
      </>}
      <Copy>{t('Basket after approval', 'السلة بعد الموافقة')}</Copy>
      {p.resulting_items.map(i => <Copy key={i.product_id}>{i.quantity} × {i.name} · {i.line_total} {i.currency}</Copy>)}
      <Copy>{t('Quoted total', 'الإجمالي المعروض')}: {p.after.payable ?? t('Not yet verified', 'لم يتم التحقق بعد')} {p.after.currency}</Copy>
      {[...p.issues, ...p.notes].map((note, i) => <Copy key={i}>{note}</Copy>)}
      <Copy>{t('Approval updates your cart. Confirm the order separately at checkout.', 'الموافقة تعدّل السلة. أكّد الطلب بشكل منفصل عند إتمام الشراء.')}</Copy>
      <Button title={state.pending ? t('Check & retry basket update', 'التحقق وإعادة محاولة تحديث السلة') : t('Approve & apply to bag', 'الموافقة والتطبيق على السلة')} disabled={busy || (!state.pending && !p.can_apply)} onPress={() => void run(() => store.approve())} />
      <Button title={t('Refresh quote', 'تحديث العرض')} secondary disabled={busy} onPress={() => void run(() => store.revise(p.draft.selections))} />
    </>}
    <Button title={t('Reload reorder', 'إعادة تحميل إعادة الطلب')} secondary disabled={busy} onPress={() => void run(() => store.start(order))} />
  </View>;
}
