import { storefrontStyles } from './storefrontStyles';
import { CheckoutPanel } from './CheckoutPanel';
import { AuthenticationPanel } from './AuthenticationPanel';
import { AddressPanel } from './AddressPanel';
import { OrdersPanel } from './OrdersPanel';
import { storefrontColors } from '../core/designColors';
import { BannerGallery, DesignSectionView } from './DesignSections';
import type { DesignAction, DesignSection } from '../core/design';
import { createShoppingRuntime } from '../platform/shoppingRuntime';
import { loadingLabel, type OperationKind } from '../core/operations';
import type { Panel, Tab } from '../core/navigationStore';
import type { AuthMode } from '../core/authenticationForm';
import { NotificationsScreen } from './NotificationsScreen';
import { type CatalogFilters } from '../core/catalogFilters';
import { CatalogFilterPanel } from './CatalogFilterPanel';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatMoney } from '../core/formatMoney';
import { ActivityIndicator, BackHandler, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { categoryImageURL, imageURL, type StorefrontConfiguration, type LiveProduct, type Locale } from '../core/commerce';
import { DealsScreen, WishlistScreen, ProductPrice } from './DiscoveryScreens';
import { AssistantPanel } from './AssistantPanel';
import { ScreenSheet, MenuRow, AmountRow } from './ScreenParts';
import { ProductPurchaseBar } from './ProductPurchaseBar';
import { CouponPanel } from './CouponPanel';
import { ProductRelationships } from './ProductRelationships';
import { ComparisonScreen } from './ComparisonScreen';
import { ReviewsPanel } from './ReviewsPanel';
import { SupportScreen } from './SupportScreen';
import { NavigationIcon } from './NavigationIcon';
import { BottomBarIcon } from './BottomBarIcon';
import { Button, Copy, Row, UiContext } from './Storefront';

type StorefrontRow = { kind: 'product'; product: LiveProduct } | { kind: 'section'; section: DesignSection };

export function LiveStorefront({ configuration }: { configuration: StorefrontConfiguration }) {
  const client = configuration.commerce;
  const runtime = useMemo(() => createShoppingRuntime(client), [client]);
  const { settings, session, authForm } = runtime;
  const comparison = useSyncExternalStore(session.comparison.subscribe, session.comparison.getSnapshot, session.comparison.getSnapshot);
  const { locale } = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
  const { tab, panel, checkout } = useSyncExternalStore(session.navigation.subscribe, session.navigation.getSnapshot, session.navigation.getSnapshot);
  // Matches the bundled SwiftUI Grocery brand (small radius, comfortable density).
  const colors = useMemo(() => storefrontColors(configuration.design?.colors), [configuration.design?.colors]);
  const s = useMemo(() => storefrontStyles(colors), [colors]);
  const { width, fontScale } = useWindowDimensions();
  const columns = fontScale > 1.4 || width < 360 ? 1 : width > 700 ? 3 : 2;
  const cardWidth = (Math.min(width, 960) - 40 - (columns - 1) * 20) / columns;
  const ar = locale === 'ar';
  const t = (en: string, arabic: string) => ar ? arabic : en;
  const amount = (value: string, currency = 'USD') => formatMoney(value, currency, locale);
  const dateTime = (value: string) => new Date(value).toLocaleString(ar ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const [revision, setRevision] = useState(0);
  const { categories, products, query, category, filters, loading, error: catalogError, selected, variants, hasMore } = useSyncExternalStore(session.catalog.subscribe, session.catalog.getSnapshot, session.catalog.getSnapshot);
  const setQuery = (query: string) => session.catalog.update({ query });
  const setCategory = (category: string) => session.catalog.update({ category });
  const setFilters = (filters: CatalogFilters) => session.catalog.update({ filters });
  const setSelected = (_: null) => session.catalog.dismissProduct();
  const operationLoading = useSyncExternalStore(session.operations.subscribe, session.operations.getSnapshot, session.operations.getSnapshot);
  const busy = operationLoading.busy;
  const { customer } = useSyncExternalStore(session.account.subscribe, session.account.getSnapshot, session.account.getSnapshot);
  const { orders } = useSyncExternalStore(session.orders.subscribe, session.orders.getSnapshot, session.orders.getSnapshot);
  const cart = useSyncExternalStore(session.cart.subscribe, session.cart.getSnapshot, session.cart.getSnapshot);
  const { locations, locationID, guestAddress } = useSyncExternalStore(session.delivery.subscribe, session.delivery.getSnapshot, session.delivery.getSnapshot);
  useEffect(() => () => runtime.dispose(), [runtime]);
  const { failure, notice } = useSyncExternalStore(session.feedback.subscribe, session.feedback.getSnapshot, session.feedback.getSnapshot);
  const error = failure?.message ?? '';
  const setError = (value: string) => session.feedback.setError(value);
  const setNotice = (value: string) => session.feedback.setNotice(value);

  const [purchaseVariant, setPurchaseVariant] = useState<LiveProduct | null>(null);
  useEffect(() => { setPurchaseVariant(null); }, [selected?.id]);
  const setTab = (tab: Tab) => session.navigation.setTab(tab);
  const setPanel = (panel: Panel) => session.navigation.open(panel);
  const setCheckout = (value: boolean) => session.navigation.presentCheckout(value);
  const checkoutFlow = session.checkout;
  useSyncExternalStore(checkoutFlow.subscribe, checkoutFlow.getSnapshot, checkoutFlow.getSnapshot);
  const uncertain = checkoutFlow.locked;
  const { ids: wishlistIDs } = useSyncExternalStore(session.wishlist.subscribe, session.wishlist.getSnapshot, session.wishlist.getSnapshot);
  const assistantBusy = useSyncExternalStore(session.assistant.subscribe, session.assistant.getBusySnapshot, session.assistant.getBusySnapshot);
  const [assistantOptions, setAssistantOptions] = useState(false);
  const [filtered, setFiltered] = useState(false);
  const browseResults = !!category || !!query || filtered;
  const authMode = useSyncExternalStore(authForm.subscribe, () => authForm.getSnapshot().mode, () => authForm.getSnapshot().mode);
  const scroll = useRef<FlatList<StorefrontRow>>(null);
  useEffect(() => { scroll.current?.scrollToOffset({ offset: 0, animated: false }); }, [tab, panel]);
  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  const resetQuote = () => checkoutFlow.invalidate();
  const act = useCallback(async (operation: () => Promise<void>, kind: OperationKind = 'mutation') => {
    await session.perform(operation, kind, locale);
  }, [session, locale]);
  useEffect(() => {
    void runtime.start();
  }, [session]);
  useEffect(() => {
    const timer = setTimeout(() => { void session.catalog.refresh(locale); }, query ? 300 : 0);
    return () => { clearTimeout(timer); session.catalog.cancel(); };
  }, [session, locale, query, category, revision, filters]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      return session.navigation.back();
    });
    return () => subscription.remove();
  }, [checkout, tab, panel]);
  const [quickPurchase, setQuickPurchase] = useState(false);
  const openProductID = useCallback((id: string, quick = false) => act(async () => {
    setQuickPurchase(quick);
    setPanel(null); setCheckout(false);
    await session.catalog.openProduct(id);
    if (session.account.getSnapshot().customer) await session.wishlist.refreshIDs();
  }), [session, act]);
  const openProduct = useCallback((product: LiveProduct) => { setQuickPurchase(false); void openProductID(product.id); }, [openProductID]);
  const openQuickPurchase = useCallback((product: LiveProduct) => { void openProductID(product.id, true); }, [openProductID]);
  const add = useCallback((product: LiveProduct, quantity = 1) => {
    if (!customer) { setSelected(null); setTab('account'); setNotice(t('Sign in to add products to your bag.', 'سجّل الدخول لإضافة المنتجات إلى حقيبتك.')); return; }
    if (!client.pin) { setSelected(null); setTab('account'); setNotice(t('Add a delivery address before shopping.', 'أضف عنوان توصيل قبل التسوق.')); return; }
    if (uncertain) { setSelected(null); setTab('bag'); return; }
    void act(async () => { await session.cart.add(product, quantity); setNotice(t('Added to your bag', 'تمت الإضافة إلى حقيبتك')); });
  }, [session, client, customer, uncertain, act, locale]);
  const purchaseQuantity = cart?.items.find(item => item.product_id === (purchaseVariant ?? selected)?.id)?.quantity ?? 0;
  const art = (product: LiveProduct, large = false) => <View style={[s.art, large && s.largeArt, large && quickPurchase && { height: 180 }, { backgroundColor: 'transparent' }]}>
    {imageURL(product) ? <Image accessibilityLabel={product.name} source={{ uri: imageURL(product) }} resizeMode="contain" style={s.image} /> : <Copy style={s.placeholder}>◇</Copy>}
  </View>;
  const tabs = { home: t('Home', 'الرئيسية'), catalog: t('Categories', 'الفئات'), deals: t('Deals', 'العروض'), bag: t('Cart', 'السلة'), account: t('Account', 'الحساب') };
  const status = (value: string) => ({ placed: t('Order placed', 'تم الطلب'), pending: t('Pending', 'قيد الانتظار'), confirmed: t('Confirmed', 'مؤكد'), processing: t('Processing', 'قيد التجهيز'), shipped: t('Shipped', 'تم الشحن'), delivered: t('Delivered', 'تم التوصيل'), cancelled: t('Cancelled', 'ملغي') })[value] ?? value;

  const bottomNavigation = (<View style={[s.tabs, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: ar ? 'row-reverse' : 'row' }]}>
        {(['home', 'catalog', 'deals', 'account', 'bag'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={tabs[value]} accessibilityState={{ selected: tab === value }} onPress={() => { setSelected(null); closePanel(); session.navigation.selectTab(value); setNotice(''); }} style={s.tab}>
          <BottomBarIcon name={value} selected={value === tab} color={value === tab ? colors.primary : colors.muted} />
          <Copy style={[s.tabLabel, { color: value === tab ? colors.primary : colors.muted, fontWeight: value === tab ? '600' : '400' }]}>{tabs[value]}{value === 'bag' && count ? ` (${count})` : ''}</Copy>
        </Pressable>)}
      </View>);

  const openAuth = (mode: AuthMode) => { authForm.open(mode); setError(''); setPanel('auth'); };
  const closePanel = () => { if (panel === 'address') session.delivery.clearAddress(); setPanel(null); };
  const toggleLanguage = () => void act(() => runtime.selectLocale(ar ? 'en' : 'ar'));
  const openOrder = (id: string) => act(async () => { setPanel('order'); await session.orders.track(id); }, 'refresh');
  const authTitle = authMode === 'login' ? t('Sign in', 'تسجيل الدخول') : authMode === 'register' ? t('Create account', 'إنشاء حساب') : authMode === 'verify' ? t('Verify account', 'تأكيد الحساب') : authMode === 'forgot-password' ? t('Forgot password', 'نسيت كلمة المرور') : t('Reset password', 'تعيين كلمة المرور');
  const feedback = <>{busy && <ActivityIndicator accessibilityLabel={loadingLabel(operationLoading, locale)} color={colors.primary} />}{!!error && <Copy accessibilityRole="alert" style={{ color: '#A63125' }}>{error}</Copy>}{!!notice && <Copy accessibilityLiveRegion="polite">{notice}</Copy>}</>;
  const inlinePanel = tab === 'account' && ['auth', 'addresses', 'orders', 'order', 'language'].includes(panel ?? '');
  const panelContent = <>
      {panel === 'support' && <>{feedback}<SupportScreen store={session.support} owner={customer?.id} locale={locale} locked={busy || uncertain || assistantBusy} run={act} signIn={() => openAuth('login')} openOrder={id => void openOrder(id)} /></>}
      {panel === 'comparison' && <ComparisonScreen store={session.comparison} client={client} locale={locale} locked={busy || uncertain || assistantBusy} open={id => void openProductID(id)} ask={prompt => { session.assistant.setDraft(prompt); setPanel('assistant'); }} />}
      {panel === 'coupon' && <CouponPanel key={customer?.id} cart={cart} locale={locale} locked={busy || uncertain || assistantBusy} feedback={feedback} apply={code => act(async () => { await session.cart.coupon(code); })} />}
      {panel === 'language' && <View style={s.panelCard}><Copy style={s.heading}>{t('Language', 'اللغة')}</Copy><Row>{(['en', 'ar'] as const).map(value => <View key={value} style={{ flex: 1 }}><Button title={value === 'en' ? 'English' : 'العربية'} selected={locale === value} secondary disabled={busy || uncertain} onPress={() => { if (locale !== value) toggleLanguage(); }} /></View>)}</Row></View>}
      {panel === 'filters' && <CatalogFilterPanel categories={categories} category={category} filters={filters} locale={locale} apply={(category, filters) => { setCategory(category); setFilters(filters); setFiltered(true); setTab('catalog'); setPanel(null); }} />}
      <AssistantPanel optionsOpen={assistantOptions} closeOptions={() => setAssistantOptions(false)} feedback={panel === 'assistant' ? feedback : null} client={client} locale={locale} visible={panel === 'assistant'} locked={busy || uncertain} store={session.assistant}
        library={session.library} run={act}
        openSupport={id => { void act(async () => { await session.support.open(id); setPanel('support'); }, 'refresh'); }}
        openTickets={() => { session.support.showList(); setAssistantOptions(false); setPanel('support'); }}
        navigate={destination => { setSelected(null); setCheckout(false); setPanel(null); if (destination === 'wishlist') setPanel('wishlist'); else if (destination === 'addresses') customer ? setPanel('addresses') : openAuth('login'); else setTab(destination); }}
        openProduct={id => { void openProductID(id); }}
        addProduct={id => { if (!customer || !client.pin) { setPanel(null); setTab('account'); return; } void act(async () => { await session.actions.addAssistantProduct(id, async id => { setPanel(null); await session.catalog.openProduct(id); }, () => setNotice(t('Added to your bag', 'تمت الإضافة إلى حقيبتك'))); }); }}
        applyProposal={id => session.operations.run(() => session.actions.applyProposal(id))}
        settled={async () => { if (session.account.getSnapshot().customer) await act(() => session.actions.assistantSettled()); }} />
      {panel === 'notifications' && <>{feedback}<NotificationsScreen store={session.notifications} owner={customer?.id} locale={locale} run={act} locked={busy} status={status} openOrder={id => { void openOrder(id); }} signIn={() => openAuth('login')} /></>}
      {panel === 'wishlist' && <WishlistScreen store={session.wishlist} locale={locale} owner={customer?.id} run={act} locked={busy || uncertain || assistantBusy} openProduct={product => void openProduct(product)} signIn={() => openAuth('login')} shop={() => { setPanel(null); setTab('catalog'); }} />}
      {(checkout) && <CheckoutPanel runtime={runtime} locale={locale} />}
      {(panel === 'auth') && <AuthenticationPanel runtime={runtime} locale={locale} />}
      {(panel === 'addresses' || panel === 'address') && <AddressPanel runtime={runtime} locale={locale} />}
      {(panel === 'orders' || panel === 'order') && <OrdersPanel runtime={runtime} locale={locale} client={client} />}
      {(selected !== null) && <>
        {!quickPurchase && configuration.design?.productActions?.compare !== false && <Pressable accessibilityRole="button" accessibilityLabel={comparison.ids.includes(selected.id) ? t('Remove from comparison', 'إزالة من المقارنة') : t('Compare this product', 'مقارنة هذا المنتج')} accessibilityState={{ selected: comparison.ids.includes(selected.id) }} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' }} disabled={busy || (!comparison.ids.includes(selected.id) && comparison.ids.length >= 5)} onPress={() => session.comparison.toggle(selected.id)}><NavigationIcon name="compare" color={comparison.ids.includes(selected.id) ? colors.primary : colors.muted} /></Pressable>}
        {!quickPurchase && configuration.design?.productActions?.compare !== false && !!comparison.ids.length && <Pressable accessibilityRole="button" accessibilityLabel={`${t('Compare products', 'مقارنة المنتجات')} (${comparison.ids.length}/5)`} style={{ minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' }} onPress={() => { setSelected(null); setPanel('comparison'); }}><NavigationIcon name="compare" color={colors.primary} /></Pressable>}
        {selected && <>{art(selected, true)}<Copy style={s.largeTitle}>{selected.name}</Copy><ProductPrice product={selected} locale={locale} />{!quickPurchase && <Copy>{selected.description}</Copy>}<Copy>{selected.in_stock ? t('✓ Available', '✓ متوفر') : t('Out of stock', 'غير متوفر')}</Copy>
          {!quickPurchase && configuration.design?.productActions?.wishlist !== false && <Pressable accessibilityRole="button" accessibilityLabel={wishlistIDs.includes(selected.id) ? t('Remove from wishlist', 'إزالة من المفضلة') : t('Save to wishlist', 'حفظ في المفضلة')} accessibilityState={{ selected: wishlistIDs.includes(selected.id) }} style={{ minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' }} disabled={busy || uncertain || assistantBusy} onPress={() => { if (!customer) { setSelected(null); openAuth('login'); return; } const product = selected, saved = !wishlistIDs.includes(product.id); void act(async () => { await session.wishlist.save(product.id, saved, product); setNotice(saved ? t('Saved to wishlist', 'تم الحفظ في المفضلة') : t('Removed from wishlist', 'تمت الإزالة من المفضلة')); }); }}><NavigationIcon name="heart" color={wishlistIDs.includes(selected.id) ? colors.primary : colors.muted} /></Pressable>}
          {!!error && <Copy accessibilityRole="alert">{error}</Copy>}{!!notice && <Copy accessibilityLiveRegion="polite">{notice}</Copy>}
          {selected.product_type === 'configurable' ? <><Copy style={s.productTitle}>{t('Choose an option', 'اختر أحد الخيارات')}</Copy>
            {variants.map(value => <Button key={value.id} title={`${value.name} · ${amount(value.price, value.currency)}${!value.in_stock ? t(' · Sold out', ' · غير متوفر') : ''}`} secondary disabled={busy || !value.in_stock || uncertain} selected={purchaseVariant?.id === value.id} onPress={() => setPurchaseVariant(value)} />)}
            {!client.pin ? <><Copy>{t('Choose a delivery address to see available sizes and stock.', 'اختر عنوان توصيل لعرض الأحجام والمخزون المتاح.')}</Copy></> : !variants.length && <Copy>{t('No options are available.', 'لا توجد خيارات متاحة.')}</Copy>}
          </> : null}
          {!quickPurchase && <ProductRelationships client={client} sources={[selected.id]} kind="related" locale={locale} disabled={busy || uncertain} open={id => void openProductID(id)} />}
          {!quickPurchase && <ProductRelationships client={client} sources={[selected.id]} kind="upsell" locale={locale} disabled={busy || uncertain} open={id => void openProductID(id)} />}
          {!quickPurchase && <ReviewsPanel store={session.reviews} product={selected.id} customer={customer} locale={locale} locked={busy || uncertain || assistantBusy} run={act} signIn={() => { setSelected(null); openAuth(customer ? 'verify' : 'login'); }} />}
        </>}
      </>}
  </>;
  const ui = useMemo(() => ({ colors, rtl: ar, radius: configuration.design?.radius ?? (tab === 'bag' ? 13 : 8) }), [colors, ar, configuration.design?.radius, tab]);
  const showingCatalog = ((tab === 'home' && !configuration.design) || tab === 'catalog');
  const homeDesign = tab === 'home' ? configuration.design : undefined;
  const listColumns = homeDesign ? 1 : columns;
  const rows = useMemo<StorefrontRow[]>(() => homeDesign ? homeDesign.sections.map(section => ({ kind: 'section', section })) :
    showingCatalog && (tab === 'home' || browseResults) ? products.map(product => ({ kind: 'product', product })) : [], [homeDesign, showingCatalog, tab, browseResults, products]);
  const navigateDesign = (action?: DesignAction, path?: string) => {
  const categoryID = path?.startsWith('/categories/') ? path.slice(12) : action?.type === 'openCategory' ? action.categoryId : undefined;
  if (categoryID) { const found = categories.find(c => c.id === categoryID || c.slug === categoryID); if (found) { setCategory(found.id); setTab('catalog'); } else setError(t('Category unavailable', 'الفئة غير متاحة')); return; }
  if (path === '/assistant') { setPanel('assistant'); return; }
  if (path === '/register') { openAuth('register'); return; }
  if (path === '/search') { setTab('catalog'); return; }
  if (path === '/account') { setTab('account'); return; }
  if (action?.type === 'openProduct') { void openProductID(action.productId); return; }
  if (action?.type === 'openTab') { if (action.tab === 'wishlist') setPanel('wishlist'); else setTab(action.tab === 'categories' ? 'catalog' : action.tab === 'cart' ? 'bag' : action.tab); }
  };
  return <UiContext.Provider value={ui}><SafeAreaView style={[s.safe, { backgroundColor: colors.background }]}>
    <StatusBar style="dark" />
    <KeyboardAvoidingView style={s.shell} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {(tab === 'home' || tab === 'catalog' || tab === 'deals') && <View style={[s.header, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={{ flexDirection: ar ? 'row-reverse' : 'row', alignItems: 'center', gap: 12 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Choose delivery location', 'اختيار موقع التوصيل')} onPress={() => setPanel('address')} style={[s.grow, { flexDirection: ar ? 'row-reverse' : 'row', alignItems: 'center', gap: 8 }]}>
            <NavigationIcon name="location" color={colors.primary} /><View style={s.grow}><Copy style={[s.caption, { color: colors.primary }]}>{t('Deliver to', 'التوصيل إلى')}</Copy>
            {(locations.find(value => value.id === locationID)?.formatted_address || guestAddress) && <Copy numberOfLines={1} style={[s.location, { color: colors.primary }]}>{locations.find(value => value.id === locationID)?.formatted_address ?? guestAddress}</Copy>}</View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Notifications', 'الإشعارات')} onPress={() => setPanel('notifications')} style={[s.language, { minWidth: 44, alignItems: 'center' }]}><NavigationIcon name="notifications" color={colors.primary} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Shopping assistant', 'مساعد التسوق')} onPress={() => { setNotice(''); setError(''); setPanel('assistant'); }} style={[s.language, { minWidth: 44, alignItems: 'center' }]}><NavigationIcon name="assistant" color={colors.primary} /></Pressable>

        </View>
        {(tab === 'home' || tab === 'catalog') && <View style={[s.search, { backgroundColor: colors.background, flexDirection: ar ? 'row-reverse' : 'row' }]}>
          <NavigationIcon name="search" color={colors.muted} />
          <TextInput accessibilityLabel={t('Search products', 'ابحث عن المنتجات')} placeholder={t('Search products', 'ابحث عن المنتجات')} placeholderTextColor={colors.muted} value={query} onChangeText={value => { setQuery(value); setTab('catalog'); }} autoCorrect={false} returnKeyType="search" style={[s.searchInput, { color: colors.text, textAlign: ar ? 'right' : 'left' }]} />
        </View>}
      </View>}
      {tab === 'bag' && <View style={[s.header, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Pressable testID="cart-delivery" accessibilityRole="button" disabled={busy || uncertain} onPress={() => customer ? setCheckout(true) : openAuth('login')} style={{ flexDirection: ar ? 'row-reverse' : 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
          <NavigationIcon name="location" color={colors.primary} />
          <View style={s.grow}><Copy style={s.productTitle}>{t('Deliver to', 'التوصيل إلى')}</Copy><Copy style={s.caption}>{locations.find(value => value.id === locationID)?.formatted_address ?? guestAddress ?? t('Choose your delivery address', 'اختر عنوان التوصيل')}</Copy></View>
        </Pressable>
      </View>}
      {busy && <ActivityIndicator accessibilityLabel={t('Loading', 'جار التحميل')} color={colors.primary} style={s.loading} />}
      {!!error && <View accessibilityRole="alert" style={[s.banner, { backgroundColor: colors.tint }]}><Copy>{error}</Copy></View>}
      {!!notice && <View accessibilityLiveRegion="polite" style={s.banner}><Copy>{notice}</Copy></View>}
      {tab === 'deals' ? <DealsScreen client={client} locale={locale} openProduct={openProduct} /> : <FlatList
        ref={scroll} key={`${tab}-${listColumns}`} testID="catalog-list"
        data={rows}
        numColumns={listColumns} keyExtractor={row => row.kind === 'product' ? row.product.id : row.section.id}
        initialNumToRender={6} maxToRenderPerBatch={6} windowSize={5}
        columnWrapperStyle={listColumns > 1 ? { gap: 20, flexDirection: ar ? 'row-reverse' : 'row' } : undefined}
        renderItem={({ item }) => item.kind === 'section' && homeDesign ? <DesignSectionView section={item.section} design={homeDesign} client={client} locale={locale} categories={categories} openProduct={openProduct} navigate={navigateDesign} /> : item.kind === 'product' ? <CatalogProductCard product={item.product} width={cardWidth} locale={locale} busy={busy} uncertain={uncertain} open={openProduct} add={openQuickPurchase} /> : null}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        contentContainerStyle={s.content}
        ListHeaderComponent={<View style={{ gap: configuration.design?.spacing ?? 24 }}>
        {((tab === 'home' && !configuration.design) || tab === 'catalog') && <>
          {tab === 'home' && !configuration.design && <>
            <View style={s.hero}>
              <BannerGallery sources={[require('../../assets/grocery-produce.png'), require('../../assets/grocery-pantry.png'), require('../../assets/grocery-greens.png')]} radius={16} navigate={() => setTab('catalog')} section={{ id: 'grocery-tall', type: 'heroBanner', layout: 'portrait', imageFit: 'cover', image: 'bundled-produce', accessibilityLabel: { en: 'Fresh grocery offers', ar: 'عروض البقالة الطازجة' } }} />
              <View style={[s.heroCopy, { alignItems: ar ? 'flex-end' : 'flex-start' }]}>
                <Copy accessibilityRole="header" style={s.heroTitle}>{t('Good food. Everyday.', 'طعام شهي كل يوم.')}</Copy>
                <Copy style={s.heroBody}>{t('Fresh produce and pantry favourites for your table.', 'خضروات وفواكه طازجة وأساسيات المطبخ لمائدتك.')}</Copy>
                <Pressable accessibilityRole="button" onPress={() => setTab('catalog')} style={s.shopLink}><Copy style={{ color: colors.primary, textDecorationLine: 'underline' }}>{t('Shop now ↗', 'تسوّق الآن ↖')}</Copy></Pressable>
              </View>
            </View>
            <BannerGallery sources={[require('../../assets/grocery-breakfast.png')]} radius={16} navigate={() => setTab('catalog')} section={{ id: 'grocery-wide', type: 'heroBanner', layout: 'horizontal', imageFit: 'cover', image: 'bundled-breakfast', accessibilityLabel: { en: 'Breakfast favourites', ar: 'مفضلات الفطور' } }} />
            <Copy accessibilityRole="header" style={s.heading}>{t('Shop by category', 'تسوّق حسب الفئة')}</Copy>
          </>}
          {tab === 'catalog' && <Copy accessibilityRole="header" style={s.largeTitle}>{category ? categories.find(value => value.id === category)?.name : query ? t('Search results', 'نتائج البحث') : t('Categories', 'الفئات')}</Copy>}
          {tab === 'catalog' && browseResults && <Button title={t('Filter & sort', 'تصفية وترتيب')} secondary onPress={() => setPanel('filters')} />}
          {tab === 'catalog' && !browseResults && <View testID="category-grid" style={{ flexDirection: ar ? 'row-reverse' : 'row', flexWrap: 'wrap', gap: 12 }}>
            {categories.map(value => <Pressable key={value.id} testID={`category-${value.id}`} accessibilityRole="button" accessibilityLabel={value.name} onPress={() => setCategory(value.id)} style={{ width: (Math.min(width, 960) - 64) / 3, flexGrow: 0, marginBottom: 8, gap: 8 }}>
              <CategoryArtwork uri={categoryImageURL(value)} />
              <Copy style={{ textAlign: 'center', fontWeight: '600', fontSize: 14 }}>{value.name}</Copy>
            </Pressable>)}
          </View>}
          {(tab === 'home' || (browseResults && categories.some(value => value.parent_id === category))) && <ScrollView testID="subcategory-slider" horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: ar ? 'row-reverse' : 'row' }}>
            {tab === 'home' && <Button title={t('All', 'الكل')} secondary selected={!category} onPress={() => setCategory('')} />}
            {categories.filter(value => tab === 'home' || value.parent_id === category).map(value => <Button key={value.id} title={value.name} secondary selected={category === value.id} onPress={() => { setCategory(value.id); setTab('catalog'); }} />)}
          </ScrollView>}
          {!!catalogError && <View style={s.block}><Copy accessibilityRole="alert">{catalogError}</Copy><Button title={t('Retry', 'إعادة المحاولة')} onPress={() => setRevision(value => value + 1)} /></View>}
          {loading && <ActivityIndicator color={colors.primary} style={s.loading} />}
          {(tab === 'home' || browseResults) && !loading && !catalogError && products.length === 0 && <Copy>{t('No products found. Try another search.', 'لا توجد منتجات. جرّب بحثاً آخر.')}</Copy>}
          {tab === 'home' && <Copy accessibilityRole="header" style={s.heading}>{t('Fresh picks', 'مختارات طازجة')}</Copy>}
        </>}
        </View>}
        ListFooterComponent={<View style={{ gap: 24 }}>
        {showingCatalog && <>
          {!loading && products.length > 0 && hasMore && <Button title={t('Load more', 'تحميل المزيد')} secondary disabled={busy} onPress={() => void act(async () => {
            await session.catalog.refresh(locale, true);
          })} />}
          <Copy style={s.caption}>{t('Prices and availability are confirmed at checkout.', 'يتم تأكيد الأسعار والتوفر عند إتمام الطلب.')}</Copy>
        </>}

        {tab === 'bag' && <>
          {!customer ? <View style={s.emptyState}>
            <View style={s.symbol}><NavigationIcon name="bag" color={colors.primary} /></View>
            <Copy style={s.heading}>{t('Your everyday essentials', 'احتياجاتك اليومية')}</Copy>
            <Copy style={s.centerCopy}>{t('Sign in to view your saved bag.', 'سجّل الدخول لعرض حقيبتك المحفوظة.')}</Copy>
            <Button title={t('Sign in', 'تسجيل الدخول')} onPress={() => { openAuth('login'); }} />
            <Button title={t('Explore the store', 'تصفّح المتجر')} secondary onPress={() => setTab('catalog')} />
          </View> : <>
            {cart?.items.map(item => <View key={item.product_id} style={s.cartRow}>
              <Copy style={s.productTitle}>{item.name}</Copy>
              <AmountRow label={`${item.quantity} × ${amount(item.price, cart.currency)}`} value={amount(item.line_total, cart.currency)} />
              <Row><View style={s.stepper}><Row>
                <Pressable accessibilityRole="button" accessibilityLabel={`${t('Decrease quantity', 'تقليل الكمية')}: ${item.name}`} disabled={busy || uncertain} style={s.step} onPress={() => void act(async () => { await session.cart.quantity(item.product_id, item.quantity - 1); })}><Copy style={s.centerCopy}>−</Copy></Pressable>
                <Copy accessibilityLiveRegion="polite">{item.quantity}</Copy>
                <Pressable accessibilityRole="button" accessibilityLabel={`${t('Increase quantity', 'زيادة الكمية')}: ${item.name}`} disabled={busy || uncertain || item.quantity >= 99} style={s.step} onPress={() => void act(async () => { await session.cart.quantity(item.product_id, item.quantity + 1); })}><Copy style={s.centerCopy}>+</Copy></Pressable>
              </Row></View><View style={s.grow} /><Pressable accessibilityRole="button" disabled={busy || uncertain} style={s.language} onPress={() => void act(async () => { await session.cart.quantity(item.product_id, 0); })}><Copy style={s.muted}>{t('Remove', 'إزالة')}</Copy></Pressable></Row>
              <Button title={t('Save for later', 'حفظ لوقت لاحق')} secondary disabled={busy || uncertain || assistantBusy} onPress={() => void act(async () => { await session.workflows.saveForLater(item.product_id); setNotice(t('Saved for later', 'تم الحفظ لوقت لاحق')); })} />
              {item.reserved_quantity < item.quantity && <Copy>{t('Some quantity is unavailable. Update your bag before checkout.', 'بعض الكمية غير متاحة. حدّث حقيبتك قبل إتمام الطلب.')}</Copy>}
            </View>)}
            {!count && <View style={s.emptyState}><View style={s.symbol}><NavigationIcon name="bag" color="#B44E32" /></View><Copy style={s.heading}>{t('Your bag is empty', 'حقيبتك فارغة')}</Copy><Copy style={s.centerCopy}>{t('Fresh favourites and everyday essentials, all in one place.', 'منتجاتك المفضلة واحتياجاتك اليومية، كلها في مكان واحد.')}</Copy><Button title={t('Explore the store', 'تصفّح المتجر')} onPress={() => setTab('catalog')} /></View>}
            {!!count && <View style={s.block}>
              <MenuRow title={t('Offers & promo codes', 'العروض وأكواد الخصم')} detail={cart?.coupon_code ?? undefined} disabled={busy || uncertain || assistantBusy} onPress={() => { setError(''); setNotice(''); setPanel('coupon'); }} />
              {!!cart?.coupon_error && <Copy accessibilityRole="alert" style={{ color: '#A63125' }}>{cart.coupon_error}</Copy>}
              <Copy style={s.productTitle}>{t('Order summary', 'ملخص الطلب')}</Copy><AmountRow label={t('Subtotal', 'المجموع الفرعي')} value={amount(cart?.subtotal ?? '0', cart?.currency)} />
              {!!cart?.discount_amount && <AmountRow label={t('Discount', 'الخصم')} value={amount(cart.discount_amount, cart.currency)} />}
              <Copy style={s.muted}>{t('Delivery and applicable tax are confirmed at checkout.', 'تُؤكّد رسوم التوصيل والضرائب المطبّقة عند إتمام الشراء.')}</Copy></View>}
            <Button title={t('Refresh bag', 'تحديث الحقيبة')} secondary disabled={busy || uncertain} onPress={() => void act(async () => { await session.cart.refresh(); resetQuote(); })} />
            {uncertain && <Copy>{t('The previous order result is uncertain. Retry with the same request to recover its result; do not start another checkout.', 'نتيجة الطلب السابق غير مؤكدة. أعد المحاولة بنفس الطلب لاسترجاع النتيجة قبل بدء طلب آخر.')}</Copy>}
          </>}
        </>}
        {inlinePanel && <><Pressable accessibilityRole="button" accessibilityLabel={panel === 'order' ? t('Back', 'رجوع') : t('My account', 'حسابي')} onPress={() => { session.navigation.back(); }} style={s.language}><Copy style={{ color: colors.primary }}>{panel === 'order' ? t('‹ Back', 'رجوع ›') : ar ? 'حسابي ›' : '‹ My account'}</Copy></Pressable>{panelContent}</>}
        {tab === 'account' && !inlinePanel && <>
          <Copy accessibilityRole="header" style={s.largeTitle}>{t('My account', 'حسابي')}</Copy>
          {!customer ? <View style={s.emptyState}>
            <View style={s.symbol}><Image source={require('../../assets/rocento-icon.png')} style={{ width: 42, height: 48 }} resizeMode="contain" accessibilityIgnoresInvertColors /></View>
            <Copy style={[s.largeTitle, s.centerCopy]}>{t('Your everyday shop,\nmade easier.', 'تسوّقك اليومي،\nبكل سهولة.')}</Copy>
            <Copy style={[s.centerCopy, s.muted]}>{t('Sign in to track orders, save favourites and check out faster.', 'سجّل الدخول لتتبّع طلباتك وحفظ مفضلاتك وإتمام الشراء أسرع.')}</Copy>
            <Button title={t('Sign in', 'تسجيل الدخول')} onPress={() => openAuth('login')} />
            <Button title={t('Create account', 'إنشاء حساب')} secondary onPress={() => openAuth('register')} />
            <View style={[s.benefits, { flexDirection: ar ? 'row-reverse' : 'row' }]}>
              <View style={s.benefit}><NavigationIcon name="bag" color={colors.primary} /><Copy style={[s.caption, s.centerCopy]}>{t('Track orders', 'تتبّع الطلبات')}</Copy></View>
              <View style={s.benefit}><NavigationIcon name="heart" color={colors.primary} /><Copy style={[s.caption, s.centerCopy]}>{t('Save favourites', 'حفظ المفضلات')}</Copy></View>
              <View style={s.benefit}><NavigationIcon name="account" color={colors.primary} /><Copy style={[s.caption, s.centerCopy]}>{t('Faster checkout', 'شراء أسرع')}</Copy></View>
            </View>
          </View> : <>
            <Row><View style={s.symbol}><NavigationIcon name="account" color={colors.primary} /></View><View style={s.grow}><Copy style={s.muted}>{t('Welcome back', 'مرحباً بعودتك')}</Copy><Copy style={s.productTitle}>{customer.email ?? customer.mobile_number}</Copy><Copy style={s.caption}>{customer.verified ? t('Verified account', 'حساب مؤكد') : t('Verification needed', 'مطلوب تأكيد الحساب')}</Copy></View></Row>
            {!customer.verified && <Button title={t('Verify account', 'تأكيد الحساب')} onPress={() => { authForm.edit({ identifier: customer.email ?? customer.mobile_number ?? '' }); openAuth('verify'); }} />}
            <Row>{([{ title: t('My orders', 'طلباتي'), detail: t('View all', 'عرض الكل'), icon: 'bag', panel: 'orders' }, { title: t('Wishlist', 'المفضلة'), detail: t('Saved items', 'المحفوظات'), icon: 'heart', panel: 'wishlist' }, { title: t('Addresses', 'العناوين'), detail: `${locations.length} ${t('saved', 'محفوظة')}`, icon: 'location', panel: 'addresses' }] as const).map(item => <Pressable key={item.panel} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => setPanel(item.panel)} style={[s.panel, { flex: 1, minHeight: 112, padding: 8, alignItems: 'center', justifyContent: 'center', gap: 8 }]}><NavigationIcon name={item.icon} size={25} color={colors.primary} /><Copy style={{ fontSize: 15, fontWeight: '600', textAlign: 'center' }}>{item.title}</Copy><Copy style={[s.caption, s.centerCopy]}>{item.detail}</Copy></Pressable>)}</Row>
            {!!orders[0] && <View style={s.panelCard}><Copy style={s.eyebrow}>{t('LATEST ORDER', 'أحدث طلب')}</Copy><Copy style={s.productTitle}>{t('Order', 'طلب')} #{orders[0].number}</Copy><Copy style={{ color: colors.primary }}>{status(orders[0].status)}</Copy><AmountRow label={dateTime(orders[0].created_at)} value={amount(orders[0].total, orders[0].currency)} /><Button title={t('Track order', 'تتبّع الطلب')} onPress={() => void openOrder(orders[0]!.id)} /></View>}
          </>}
          <View style={s.panel}><MenuRow title={t('Notifications', 'الإشعارات')} detail={t('Order updates', 'تحديثات الطلب')} onPress={() => setPanel('notifications')} /></View>
          <View style={s.panel}>{!customer && <MenuRow title={t('Wishlist', 'المفضلة')} detail={t('Keep your favourite products close', 'احتفظ بمنتجاتك المفضلة')} onPress={() => setPanel('wishlist')} />}<View style={s.divider} /><MenuRow title={t('Shopping assistant', 'مساعد التسوق')} detail={t('Find products and get help with your bag', 'اعثر على منتجات واحصل على مساعدة في سلتك')} onPress={() => { setNotice(''); setError(''); setPanel('assistant'); }} /></View>
          <Copy style={s.eyebrow}>{t('PREFERENCES', 'التفضيلات')}</Copy>
          <View style={s.panel}><MenuRow title={t('Language', 'اللغة')} detail={ar ? 'العربية' : 'English'} disabled={busy || uncertain} onPress={() => setPanel('language')} /></View>
          {!!customer && <><MenuRow title={t('Refresh account', 'تحديث الحساب')} disabled={busy} onPress={() => void act(async () => { await session.workflows.recover(); }, 'refresh')} /><MenuRow title={t('Sign out', 'تسجيل الخروج')} disabled={busy} onPress={() => void act(async () => { await session.actions.logout(); })} /></>}
        </>}

      </View>} />}
      {tab === 'bag' && customer && (!!count || uncertain) && <View style={[s.checkoutDock, { flexDirection: 'row', alignItems: 'center', gap: 16 }]}><View style={s.grow}><Copy style={s.caption}>{t('Items total', 'إجمالي المنتجات')}</Copy><Copy style={s.heading}>{amount(String(Math.max(0, Number(cart?.subtotal ?? '0') - Number(cart?.discount_amount ?? '0'))), cart?.currency)}</Copy></View><View style={s.grow}><Button title={uncertain ? t('Resolve pending order', 'متابعة الطلب المعلّق') : t('Checkout', 'إتمام الشراء')} disabled={busy || (!uncertain && !cart?.fully_reserved)} onPress={() => setCheckout(true)} /></View></View>}
      {bottomNavigation}
    </KeyboardAvoidingView>
    <ScreenSheet visible={!inlinePanel && (checkout || panel !== null || selected !== null)}
      headerRight={panel === 'assistant' ? <Pressable accessibilityRole="button" accessibilityLabel={t('Chat options', 'خيارات المحادثة')} onPress={() => setAssistantOptions(v => !v)} style={{ minHeight: 44, justifyContent: 'center' }}><Copy style={{ textAlign: 'center', fontSize: 24 }}>⋯</Copy></Pressable> : undefined}
      scroll={panel !== 'assistant' && panel !== 'filters' && panel !== 'wishlist'}
      bottomSheet={quickPurchase && selected !== null}
      fullScreen={(selected !== null && !quickPurchase) || panel === 'comparison' || panel === 'support'}
      footer={selected && <><ProductPurchaseBar showsDraftQuantity key={(purchaseVariant ?? selected).id} product={purchaseVariant ?? selected} locale={locale} quantity={purchaseQuantity} onQuantity={value => void act(async () => { await session.cart.quantity((purchaseVariant ?? selected).id, value); })} locked={busy || uncertain || assistantBusy} ready={selected.product_type !== 'configurable' || purchaseVariant !== null} hasAddress={!!client.pin} onAdd={quantity => add(purchaseVariant ?? selected, quantity)} onAddress={() => { setSelected(null); customer ? setPanel('addresses') : openAuth('login'); }} />{!quickPurchase && bottomNavigation}</>}
      title={selected && quickPurchase ? t('Add to cart', 'إضافة إلى السلة') : panel === 'support' ? t('Support center', 'مركز الدعم') : panel === 'comparison' ? t('Compare products', 'مقارنة المنتجات') : panel === 'coupon' ? t('Offers & promo codes', 'العروض وأكواد الخصم') : panel === 'notifications' ? t('Notifications', 'الإشعارات') : panel === 'filters' ? t('Filter & sort', 'تصفية وترتيب') : panel === 'assistant' ? t('Shopping assistant', 'مساعد التسوق') : panel === 'wishlist' ? t('Wishlist', 'المفضلة') : checkout ? t('Checkout', 'إتمام الشراء') : panel === 'auth' ? authTitle : panel === 'address' ? t('Add delivery address', 'إضافة عنوان توصيل') : panel === 'addresses' ? t('Addresses', 'العناوين') : panel === 'orders' ? t('My orders', 'طلباتي') : panel === 'order' ? t('Track order', 'تتبّع الطلب') : t('Product', 'المنتج')}
      close={() => { setCheckout(false); setSelected(null); setQuickPurchase(false); closePanel(); }}>
      {!inlinePanel && panelContent}
    </ScreenSheet>
  </SafeAreaView></UiContext.Provider>;
}

const CatalogProductCard = memo(function CatalogProductCard({ product, width, locale, busy, uncertain, open, add }: {
  product: LiveProduct; width: number; locale: Locale; busy: boolean; uncertain: boolean;
  open: (product: LiveProduct) => void; add: (product: LiveProduct) => void;
}) {
  const { colors } = useContext(UiContext);
  const s = useMemo(() => storefrontStyles(colors), [colors]);
  const ar = locale === 'ar';
  const url = imageURL(product);
  return <View testID={`catalog-product-${product.id}`} style={[s.card, { width }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={product.name} disabled={busy} onPress={() => open(product)}>
      <View style={[s.art, { backgroundColor: 'transparent' }]}>{url ? <Image accessibilityLabel={product.name} source={{ uri: url }} resizeMode="contain" style={s.image} /> : <Copy style={s.placeholder}>◇</Copy>}</View>
      <Copy style={s.productTitle}>{product.name}</Copy><Copy style={s.price}>{formatMoney(product.price, product.currency, locale)}</Copy>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${ar ? 'إضافة إلى السلة' : 'Add to cart'}: ${product.name}`} testID={`quick-add-${product.id}`}
      disabled={busy || uncertain} onPress={() => add(product)} style={{ minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', alignItems: 'center' }}>
      <NavigationIcon name="cart" color={colors.primary} />
    </Pressable>
  </View>;
});


function CategoryArtwork({ uri }: { uri: string | undefined | null }) {
  const { colors } = useContext(UiContext);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  return <View style={{ width: '100%', aspectRatio: 1, borderRadius: 14, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
    {uri && !failed ? <Image source={{ uri }} onError={() => setFailed(true)} resizeMode="contain" style={{ width: '100%', height: '100%' }} /> : <NavigationIcon name="catalog" color={colors.primary} />}
  </View>;
}
