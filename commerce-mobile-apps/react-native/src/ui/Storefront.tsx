import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  BackHandler, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput,
  useWindowDimensions, View, type TextProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  bagLines, changeQuantity, emptyBag, filterProducts, localized, money, priceInCents,
  type Locale, type Product, type StoreId, type StorefrontConfiguration,
} from '../core/storefront';
import { strings } from '../core/strings';
import { BottomBarIcon } from './BottomBarIcon';

export const palettes = {
  light: { background: '#FCFAF6', surface: '#FFFFFF', tint: '#F0EDE5', text: '#202D27', muted: '#65716B', primary: '#245743', onPrimary: '#FFFFFF', border: '#DFE3DC', hero: '#E4EDDF' },
  dark: { background: '#14221C', surface: '#1D2E25', tint: '#2A3B30', text: '#F5F6EC', muted: '#BAC8BE', primary: '#BBDBAE', onPrimary: '#14221C', border: '#405146', hero: '#2A4130' },
};
export const UiContext = createContext({ colors: palettes.light, rtl: false, radius: 14 });
const artwork: Record<string, string> = { apple: '🍎', avocado: '🥑', bread: '🍞', bag: '👜', shirt: '👕', cup: '☕' };
type Tab = 'home' | 'catalog' | 'bag' | 'settings';

export function Copy({ style, ...props }: TextProps) {
  const { colors, rtl } = useContext(UiContext);
  return <Text {...props} style={[styles.text, { color: colors.text, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }, style]} />;
}
export function Row({ children }: { children: ReactNode }) {
  const { rtl } = useContext(UiContext);
  return <View style={[styles.row, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>{children}</View>;
}
export function Button({ title, onPress, secondary = false, selected, disabled = false, label }: {
  title: string; onPress: () => void; secondary?: boolean; selected?: boolean; disabled?: boolean; label?: string;
}) {
  const { colors, radius } = useContext(UiContext);
  return <Pressable accessibilityRole="button" accessibilityLabel={label ?? title}
    accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderRadius: radius, minHeight: 52, backgroundColor: secondary ? colors.tint : colors.primary,
      opacity: disabled ? 0.45 : pressed ? 0.7 : 1, borderColor: secondary ? colors.primary : 'transparent', borderWidth: selected ? 2 : 1 }]}>
    <Copy style={[styles.buttonText, { color: secondary ? colors.text : colors.onPrimary }]}>{title}</Copy>
  </Pressable>;
}
function ProductArt({ product, large = false }: { product: Product; large?: boolean }) {
  const { colors } = useContext(UiContext);
  return <View accessible={false} style={[styles.art, { backgroundColor: colors.tint }, large && styles.largeArt]}>
    <Text accessible={false} style={{ fontSize: large ? 100 : 64 }}>{artwork[product.symbol] ?? '◇'}</Text>
  </View>;
}

export function Storefront({ configuration }: { configuration: StorefrontConfiguration }) {
  const [store, setStore] = useState<StoreId>('market');
  const [locale, setLocale] = useState<Locale>('en');
  const [tab, setTab] = useState<Tab>('home');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const snapshot = configuration.getSnapshot(store);
  const { catalog } = snapshot;
  const [bag, setBag] = useState(() => emptyBag(catalog));
  const colors = palettes.light;
  const rtl = locale === 'ar';
  const t = strings(locale);
  const { width, fontScale } = useWindowDimensions();
  const columns = fontScale > 1.4 || width < 360 ? 1 : width > 700 ? 3 : 2;
  const lines = bagLines(bag, catalog);
  const count = lines.reduce((total, line) => total + line.quantity, 0);
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const currency = catalog.products[0]?.currency ?? 'USD';
  const products = filterProducts(catalog, tab === 'catalog' ? query : '', tab === 'catalog' ? category : null);
  const change = (product: Product, delta: number) => setBag(current => changeQuantity(current, catalog, product.id, delta));
  const switchStore = (next: StoreId) => {
    if (next === store) return;
    setStore(next);
    setBag(emptyBag(configuration.getSnapshot(next).catalog));
    setSelected(null);
    setQuery('');
    setCategory(null);
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab === 'home') return false;
      setTab('home');
      return true;
    });
    return () => subscription.remove();
  }, [tab]);

  const productCard = ({ item }: { item: Product }) => <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={localized(item, locale)} onPress={() => setSelected(item)}>
      <ProductArt product={item} />
      <Copy style={styles.productName}>{localized(item, locale)}</Copy>
      <Copy style={styles.price}>{money(priceInCents(item.price), item.currency, locale)}</Copy>
    </Pressable>
    <Button title={t.add} label={`${t.add}: ${localized(item, locale)}`} onPress={() => change(item, 1)} disabled={!item.in_stock || (bag.quantities[item.id] ?? 0) >= 99} secondary />
    {(bag.quantities[item.id] ?? 0) > 0 && <Copy accessibilityLiveRegion="polite" style={styles.caption}>{t.added}: {bag.quantities[item.id]}</Copy>}
  </View>;

  return <UiContext.Provider value={{ colors, rtl, radius: 14 }}>
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <StatusBar style="dark" />
      <View style={styles.shell}>
        <View style={[styles.header, { borderColor: colors.border }]}>
          <Row>
            <View style={styles.grow}>
              <Copy style={[styles.wordmark, { writingDirection: 'ltr' }]}>rocento.</Copy>
              <Copy style={[styles.caption, { color: colors.muted }]}>{localized(snapshot.name, locale)}</Copy>
            </View>
            <Button title={rtl ? 'English' : 'العربية'} label={rtl ? 'Switch to English' : 'التبديل إلى العربية'} secondary onPress={() => setLocale(rtl ? 'en' : 'ar')} />
          </Row>
        </View>

        {(tab === 'home' || tab === 'catalog') && <FlatList
          key={`${store}-${tab}-${columns}-${locale}`} data={products} numColumns={columns}
          keyExtractor={product => product.id} renderItem={productCard} keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content} columnWrapperStyle={columns > 1 ? { gap: 12, flexDirection: rtl ? 'row-reverse' : 'row' } : undefined}
          ListHeaderComponent={<View style={styles.stack}>
            {tab === 'home' ? <>
              <View style={[styles.hero, { backgroundColor: colors.hero }]}>
                <Copy style={[styles.eyebrow, { color: colors.primary }]}>{t.preview}</Copy>
                <Copy accessibilityRole="header" style={styles.heroTitle}>{store === 'market' ? t.marketTitle : t.boutiqueTitle}</Copy>
                <Copy style={[styles.subtitle, { color: colors.muted }]}>{store === 'market' ? t.marketSubtitle : t.boutiqueSubtitle}</Copy>
                <Button title={t.shop} onPress={() => setTab('catalog')} />
              </View>
              <Copy accessibilityRole="header" style={styles.heading}>{t.featured}</Copy>
            </> : <>
              <Copy accessibilityRole="header" style={styles.heading}>{t.catalog}</Copy>
              <TextInput accessibilityLabel={t.search} placeholder={t.search} placeholderTextColor={colors.muted}
                value={query} onChangeText={setQuery} autoCorrect={false} returnKeyType="search"
                style={[styles.search, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }]} />
              <Row>
                <Button title={t.all} secondary selected={category === null} onPress={() => setCategory(null)} />
                {catalog.categories.map(item => <Button key={item.id} title={localized(item, locale)} secondary selected={category === item.id} onPress={() => setCategory(item.id)} />)}
              </Row>
            </>}
          </View>}
          ListEmptyComponent={<View style={styles.empty}>
            <Copy style={styles.heading}>{t.noResults}</Copy><Copy>{t.trySearch}</Copy>
            <Button title={t.clear} onPress={() => { setQuery(''); setCategory(null); }} />
          </View>}
          ListFooterComponent={<Copy style={[styles.notice, { color: colors.muted }]}>{t.previewNotice}</Copy>}
        />}

        {tab === 'bag' && <ScrollView contentContainerStyle={styles.content}>
          <Copy accessibilityRole="header" style={styles.heading}>{t.bag} · {count}</Copy>
          {lines.length === 0 ? <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🛍️</Text><Copy style={styles.heading}>{t.emptyTitle}</Copy>
            <Copy style={{ color: colors.muted }}>{t.emptyText}</Copy><Button title={t.shop} onPress={() => setTab('catalog')} />
          </View> : <>
            {lines.map(({ product, quantity, subtotal }) => <View key={product.id} style={[styles.bagCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Copy style={styles.productName}>{artwork[product.symbol]} {localized(product, locale)}</Copy>
              <Copy style={styles.price}>{money(subtotal, product.currency, locale)}</Copy>
              <Row>
                <Button title="−" label={`${t.decrease}: ${localized(product, locale)}`} secondary onPress={() => change(product, -1)} />
                <Copy accessibilityLiveRegion="polite" style={styles.quantity}>{quantity}</Copy>
                <Button title="+" label={`${t.increase}: ${localized(product, locale)}`} secondary disabled={quantity >= 99 || !product.in_stock} onPress={() => change(product, 1)} />
                <Button title={t.remove} secondary onPress={() => change(product, -quantity)} />
              </Row>
            </View>)}
            <View style={[styles.summary, { borderColor: colors.border }]}>
              <Row><Copy style={[styles.heading, styles.grow]}>{t.subtotal}</Copy><Copy style={styles.heading}>{money(total, currency, locale)}</Copy></Row>
            </View>
          </>}
          <Copy style={[styles.notice, { color: colors.muted }]}>{t.previewNotice}</Copy>
        </ScrollView>}

        {tab === 'settings' && <ScrollView contentContainerStyle={[styles.content, styles.stack]}>
          <Copy accessibilityRole="header" style={styles.heading}>{t.preferences}</Copy>
          <Copy style={styles.productName}>{t.language}</Copy>
          <Row>{(['en', 'ar'] as const).map(value => <Button key={value} title={value === 'en' ? 'English' : 'العربية'} selected={locale === value} secondary onPress={() => setLocale(value)} />)}</Row>
          <Copy style={styles.productName}>{t.store}</Copy>
          <Row>{(['market', 'boutique'] as const).map(value => <Button key={value} title={localized(configuration.getSnapshot(value).name, locale)} selected={store === value} secondary onPress={() => switchStore(value)} />)}</Row>
          <Copy style={{ color: colors.muted }}>{t.storeNotice}</Copy>
          <View style={[styles.hero, { backgroundColor: colors.hero }]}>
            <Copy style={styles.productName}>{t.about}</Copy><Copy style={{ color: colors.muted }}>{t.aboutText}</Copy>
          </View>
        </ScrollView>}

        <View style={[styles.tabs, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          {(['home', 'catalog', 'bag', 'settings'] as const).map(value => <Pressable key={value}
            accessibilityRole="tab" accessibilityLabel={value === 'bag' ? `${t.bag}, ${count} ${t.items}` : t[value]}
            accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)} style={styles.tab}>
            <View style={[styles.tabMarker, { backgroundColor: tab === value ? colors.hero : 'transparent' }]}>
              <BottomBarIcon name={value} selected={tab === value} color={tab === value ? colors.primary : colors.muted} />
            </View>
            <Copy style={[styles.tabLabel, { color: tab === value ? colors.primary : colors.muted }]}>{t[value]}{value === 'bag' && count > 0 ? ` (${count})` : ''}</Copy>
          </Pressable>)}
        </View>
      </View>
    </SafeAreaView>

    <Modal visible={selected !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelected(null)}>
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        {selected && <ScrollView contentContainerStyle={[styles.content, styles.stack]}>
          <Button title={t.close} secondary onPress={() => setSelected(null)} />
          <ProductArt product={selected} large />
          <Copy accessibilityRole="header" style={styles.heading}>{localized(selected, locale)}</Copy>
          <Copy style={styles.heading}>{money(priceInCents(selected.price), selected.currency, locale)}</Copy>
          <Copy style={{ color: colors.primary }}>{selected.in_stock ? t.available : t.unavailable}</Copy>
          <Copy style={{ color: colors.muted }}>{locale === 'ar' ? selected.descriptionAr : selected.description}</Copy>
          <Button title={t.add} disabled={!selected.in_stock || (bag.quantities[selected.id] ?? 0) >= 99} onPress={() => change(selected, 1)} />
          {(bag.quantities[selected.id] ?? 0) > 0 && <Copy accessibilityLiveRegion="polite">{t.added}: {bag.quantities[selected.id]}</Copy>}
          <Copy style={[styles.notice, { color: colors.muted }]}>{t.previewNotice}</Copy>
        </ScrollView>}
      </SafeAreaView>
    </Modal>
  </UiContext.Provider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, shell: { flex: 1, width: '100%', maxWidth: 960, alignSelf: 'center' },
  header: { paddingHorizontal: 22, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { gap: 10, alignItems: 'center', flexWrap: 'wrap' }, grow: { flex: 1 },
  text: { fontSize: 16, lineHeight: 24 }, wordmark: { fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -1.5 },
  caption: { fontSize: 12, lineHeight: 20 }, content: { padding: 20, paddingBottom: 32 }, stack: { gap: 16 },
  hero: { borderRadius: 24, padding: 24, gap: 18 }, eyebrow: { fontSize: 11, lineHeight: 18, fontWeight: '800', letterSpacing: 1.5 },
  heroTitle: { fontSize: 40, lineHeight: 47, fontWeight: '700', letterSpacing: -1.5 },
  subtitle: { fontSize: 16, lineHeight: 25 }, heading: { fontSize: 24, lineHeight: 34, fontWeight: '700', marginVertical: 8 },
  card: { flex: 1, padding: 12, marginTop: 14, borderRadius: 20, borderWidth: 1, gap: 8, maxWidth: '100%' },
  art: { minHeight: 138, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  largeArt: { minHeight: 260 }, productName: { fontSize: 17, lineHeight: 25, fontWeight: '600' },
  price: { fontSize: 17, lineHeight: 28, fontWeight: '700', marginTop: 5 },
  button: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, justifyContent: 'center' },
  buttonText: { textAlign: 'center', fontSize: 16, lineHeight: 22, fontWeight: '600' },
  search: { minHeight: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, fontSize: 16 },
  notice: { fontSize: 13, lineHeight: 21, marginTop: 24 }, empty: { alignItems: 'stretch', gap: 16, paddingVertical: 40 },
  emptyIcon: { fontSize: 60 }, bagCard: { padding: 18, borderWidth: 1, borderRadius: 20, gap: 12, marginTop: 14 },
  quantity: { minWidth: 24, textAlign: 'center', fontWeight: '700' }, summary: { marginTop: 24, borderTopWidth: 1, paddingTop: 16 },
  tabs: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 10 },
  tab: { flex: 1, alignItems: 'center', gap: 3, minHeight: 56 }, tabMarker: { paddingHorizontal: 16, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  tabLabel: { textAlign: 'center', fontSize: 12, lineHeight: 20, fontWeight: '600' },
});
