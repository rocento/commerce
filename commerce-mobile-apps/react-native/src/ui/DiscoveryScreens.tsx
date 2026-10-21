import { formatMoney } from '../core/formatMoney';
import type { OperationKind } from '../core/operations';
import { WishlistStore } from '../core/wishlistStore';
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, View, useWindowDimensions } from 'react-native';
import { CommerceClient, displayPrice, imageURL, type LiveProduct, type Locale } from '../core/commerce';
import { Button, Copy, Row, UiContext } from './Storefront';

export function ProductPrice({ product, locale }: { product: LiveProduct; locale: Locale }) {
  const { colors } = useContext(UiContext);
  const price = displayPrice(product);
  const money = (v: string) => formatMoney(v, product.currency, locale);
  return <View style={{ gap: 5 }}><Copy style={{ fontSize: 17, fontWeight: '600' }}>{money(price)}</Copy>{price !== product.price && <><Copy accessibilityLabel={`${locale === 'ar' ? 'السعر الأصلي' : 'Original price'} ${money(product.price)}`} style={{ textDecorationLine: 'line-through', color: colors.muted, fontSize: 12 }}>{money(product.price)}</Copy><Copy style={{ color: colors.primary, fontWeight: '600', fontSize: 12 }}>{locale === 'ar' ? 'وفّر' : 'Save'} {money(String(Number(product.price) - Number(price)))}</Copy></>}</View>;
}
export function ProductThumbnail({ product, size = 80 }: { product: LiveProduct; size?: number }) {
  const { colors } = useContext(UiContext);
  const url = imageURL(product);
  return <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>{url ? <Image source={{ uri: url }} resizeMode="contain" style={{ width: '100%', height: '100%' }} /> : <Copy style={{ fontSize: 32, lineHeight: 44 }}>◇</Copy>}</View>;
}
export function DealsScreen({ client, locale, openProduct }: { client: CommerceClient; locale: Locale; openProduct: (product: LiveProduct) => void }) {
  const { colors, rtl } = useContext(UiContext), { width, fontScale } = useWindowDimensions();
  const columns = fontScale > 1.4 || width < 360 ? 1 : width > 700 ? 3 : 2;
  const size = (Math.min(width, 960) - 40 - (columns - 1) * 20) / columns;
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [products, setProducts] = useState<LiveProduct[]>([]), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [more, setMore] = useState(true);
  const offset = useRef(0), request = useRef<AbortController | null>(null);
  const load = async (reset = false) => {
    if (request.current && !reset) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    if (reset) { offset.current = 0; setProducts([]); setMore(true); }
    setLoading(true); setFailed(false);
    try {
      let found = 0;
      for (let page = 0; page < 10; page++) {
        const result = await client.search('', '', offset.current, controller.signal);
        if (controller.signal.aborted) return;
        const offers = result.hits.filter(p => p.active !== false && displayPrice(p) !== p.price);
        setProducts(current => [...current, ...offers.filter(p => !current.some(v => v.id === p.id))]);
        found += offers.length; offset.current += result.hits.length;
        const hasMore = result.hits.length > 0 && offset.current < result.total && offset.current <= 9999;
        setMore(hasMore); if (!hasMore || found >= 12) break;
      }
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  };
  useEffect(() => { void load(true); return () => { request.current?.abort(); request.current = null; }; }, [client, locale]);
  return <FlatList key={`deals-${columns}`} data={products} numColumns={columns} keyExtractor={product => product.id}
    initialNumToRender={6} maxToRenderPerBatch={6} windowSize={5}
    contentContainerStyle={{ padding: 20, gap: 20 }} columnWrapperStyle={columns > 1 ? { gap: 20, flexDirection: rtl ? 'row-reverse' : 'row' } : undefined}
    renderItem={({ item: product }) => <Pressable accessibilityRole="button" accessibilityLabel={product.name} onPress={() => openProduct(product)} style={{ width: size, gap: 12 }}><ProductThumbnail product={product} size={size} /><Copy style={{ fontSize: 17, fontWeight: '600' }}>{product.name}</Copy><ProductPrice product={product} locale={locale} /></Pressable>}
    ListHeaderComponent={<View style={{ gap: 16 }}>
    <Copy accessibilityRole="header" style={{ fontSize: 30, fontWeight: '700' }}>{t('Deals', 'العروض')}</Copy>
    <Copy>{t('Current offers, with savings shown upfront.', 'عروض حالية مع توضيح قيمة التوفير.')}</Copy>
    <Copy style={{ fontSize: 12, color: colors.muted }}>{t('Final prices and eligibility are confirmed at checkout.', 'يتم تأكيد الأسعار النهائية وشروط الاستحقاق عند إتمام الطلب.')}</Copy>
    </View>}
    ListFooterComponent={<View style={{ gap: 16 }}>
    {loading && <ActivityIndicator accessibilityLabel={t('Loading deals', 'جارٍ تحميل العروض')} color={colors.primary} />}
    {failed && <Copy accessibilityRole="alert">{t('Unable to load deals. Please retry.', 'تعذر تحميل العروض. يرجى المحاولة.')}</Copy>}
    {!loading && !failed && !products.length && <Copy>{more ? t('No offers in these products. Explore more below.', 'لا توجد عروض في هذه المنتجات. استكشف المزيد أدناه.') : t('No deals available right now', 'لا توجد عروض حالياً')}</Copy>}
    {(more || failed) && <Button title={failed ? t('Retry', 'إعادة المحاولة') : t('Explore more deals', 'استكشف المزيد من العروض')} disabled={loading} onPress={() => void load()} />}
    {!more && !loading && <Button title={t('Refresh deals', 'تحديث العروض')} secondary onPress={() => void load(true)} />}
  </View>} />;
}
export function WishlistScreen({ store, locale, owner, run, openProduct, signIn, shop, locked }: { store: WishlistStore; locale: Locale; owner?: string; run: (operation: () => Promise<void>, kind?: OperationKind) => Promise<void>; openProduct: (p: LiveProduct) => void; signIn: () => void; shop: () => void; locked: boolean }) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const { colors } = useContext(UiContext);
  const { ids, products, limit, loaded, loading: busy, failed } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const error = failed ? t('Unable to update saved products. Please retry.', 'تعذر تحديث المنتجات المحفوظة. حاول مجدداً.') : '';
  const load = (more = false) => owner ? run(() => store.load(locale, more), 'refresh') : Promise.resolve();
  useEffect(() => { void load(); }, [store, locale, owner]);
  const remove = (id: string) => locked ? Promise.resolve() : run(() => store.save(id, false));
  return <FlatList data={owner ? ids.slice(0, limit).filter(id => id in products) : []} keyExtractor={id => id}
    initialNumToRender={6} maxToRenderPerBatch={6} windowSize={5} contentContainerStyle={{ padding: 20, gap: 16 }}
    ListHeaderComponent={<View style={{ gap: 16 }}><Copy accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700' }}>{t('Saved products', 'المنتجات المحفوظة')}</Copy>
    {!owner ? <><Copy>{t('Sign in to save your favourites and find them here.', 'سجّل الدخول لحفظ منتجاتك المفضلة والعثور عليها هنا.')}</Copy><Button title={t('Sign in', 'تسجيل الدخول')} onPress={signIn} /></> : <>
      {busy && <ActivityIndicator accessibilityLabel={t('Loading saved products', 'جارٍ تحميل المنتجات المحفوظة')} color={colors.primary} />}
      {!!error && <><Copy accessibilityRole="alert">{error}</Copy><Button title={t('Retry', 'إعادة المحاولة')} disabled={busy} onPress={() => void load()} /></>}
      {loaded && !ids.length && <><Copy>{t('Your wishlist is empty. Save a product from its details.', 'المفضلة فارغة. احفظ منتجاً من صفحة تفاصيله.')}</Copy><Button title={t('Explore products', 'استكشف المنتجات')} onPress={shop} /></>}
      {!!ids.length && <Copy>{ids.length} {t('saved products', 'منتجات محفوظة')}</Copy>}
    </>}
    </View>}
      renderItem={({ item: id }) => { const p = products[id]; return <View key={id} style={{ gap: 12, paddingBottom: 16, borderBottomWidth: 1, borderColor: colors.border }}>
        {p ? <><Pressable accessibilityRole="button" accessibilityLabel={p.name} disabled={busy} onPress={() => openProduct(p)}><Row><ProductThumbnail product={p} /><View style={{ flex: 1, gap: 8 }}><Copy style={{ fontWeight: '600' }}>{p.name}</Copy><ProductPrice product={p} locale={locale} /></View></Row></Pressable><Copy>{p.in_stock ? t('In stock', 'متوفر') : t('Out of stock', 'غير متوفر')}</Copy><Button title={t('View product', 'عرض المنتج')} secondary disabled={busy} onPress={() => openProduct(p)} /></> : <Copy>{t('Product unavailable', 'المنتج غير متاح')}</Copy>}
        <Button title={t('Remove from wishlist', 'إزالة من المفضلة')} secondary disabled={busy || locked} onPress={() => void remove(id)} />
      </View>; }}

    ListFooterComponent={owner ? <View style={{ gap: 16 }}>
      {ids.length > limit && <Button title={t('Load more products', 'عرض المزيد من المنتجات')} disabled={busy} onPress={() => void load(true)} />}
      <Button title={t('Refresh wishlist', 'تحديث المفضلة')} secondary disabled={busy} onPress={() => void load()} />
    </View> : null} />;
}
