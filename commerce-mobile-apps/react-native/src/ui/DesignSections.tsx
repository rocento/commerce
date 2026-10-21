import { useContext, useEffect, useState, useRef } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import type { CommerceClient, Category, LiveProduct, Locale } from '../core/commerce';
import { categoryImageURL, imageURL } from '../core/commerce';
import type { DesignAction, DesignSection, StorefrontDesign } from '../core/design';
import { formatMoney } from '../core/formatMoney';
import { Button, Copy, UiContext } from './Storefront';

function BannerImage({ uri, label, editorial }: { uri: string; label: string; editorial: boolean }) {
  const [ratio, setRatio] = useState(1);
  return <Image source={{ uri }} accessibilityLabel={label}
    style={{ width: '100%', ...(editorial ? { aspectRatio: ratio } : { height: 96 }) }} resizeMode="contain"
    onLoad={({ nativeEvent: { source } }) => {
      if (source.width > 0 && source.height > 0) setRatio(source.width / source.height);
    }} />;
}

export function BannerGallery({ section, radius, navigate, sources }: { sources?: ImageSourcePropType[]; section: Extract<DesignSection, { type: 'heroBanner' }>; radius: number; navigate: (action?: DesignAction, path?: string) => void }) {
  const { rtl } = useContext(UiContext);
  const [width, setWidth] = useState(320);
  const scroll = useRef<ScrollView>(null);
  const images = sources || [section.image, ...(section.additionalImages || [])].map(uri => ({ uri }));
  const cardWidth = width * (images.length > 1 ? section.layout === 'portrait' ? 0.78 : 0.88 : 1);
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollTo({ x: section.layout === 'portrait' && images.length >= 3 ? cardWidth + 12 : 0, animated: false }), 0);
    return () => clearTimeout(timer);
  }, [cardWidth, section.id, section.layout, images.length]);
  return <View onLayout={e => setWidth(e.nativeEvent.layout.width)}>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={images.length > 1} snapToInterval={cardWidth + 12} decelerationRate="fast" contentContainerStyle={{ gap: 12, paddingHorizontal: (width - cardWidth) / 2, flexDirection: rtl ? 'row-reverse' : 'row' }}>
      {images.map((source, index) => <Pressable key={index} accessibilityRole="button" accessibilityLabel={`${section.accessibilityLabel[rtl ? 'ar' : 'en']} · ${index + 1}`} onPress={() => navigate(section.action, section.path)} style={{ width: cardWidth, aspectRatio: section.layout === 'portrait' ? 2 / 3 : 3, borderRadius: radius, overflow: 'hidden' }}>
        <Image source={source} style={{ width: '100%', height: '100%' }} resizeMode={section.imageFit || 'cover'} />
      </Pressable>)}
    </ScrollView>
  </View>;
}

export function DesignSections({ design, client, locale, categories, navigate, openProduct }: {
  design: StorefrontDesign; client: CommerceClient; locale: Locale; categories: Category[];
  navigate: (action?: DesignAction, path?: string) => void; openProduct: (product: LiveProduct) => void;
}) {
  return <>{design.sections.map(section => <DesignSectionView key={section.id} {...{ section, design, client, locale, categories, navigate, openProduct }} />)}</>;
}
export function DesignSectionView({ section, design, client, locale, categories, navigate, openProduct }: Parameters<typeof DesignSections>[0] & { section: DesignSection }) {
  const { colors, rtl } = useContext(UiContext);
  const [products, setProducts] = useState<LiveProduct[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const collection = section.type === 'productGrid' || section.type === 'productCarousel' ? section.collection : undefined;
  useEffect(() => {
    if (!collection) return;
    const controller = new AbortController(); setState('loading'); setProducts([]);
    void client.designCollection(collection, controller.signal).then(value => { if (!controller.signal.aborted) { setProducts(value); setState('ready'); } }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [client, collection, locale, retry]);
  const box = { gap: design.spacing, borderRadius: design.radius, backgroundColor: colors.surface, padding: design.spacing };
  if (section.type === 'spacer') return <View testID={`section-${section.id}`} style={{ height: section.size }} />;
  if (section.type === 'richText' || section.type === 'heroBanner') {
    const copy = <View style={[box, { backgroundColor: section.appearance === 'campaign' ? colors.surface : colors.background }]}>
      {section.eyebrow && <Copy>{section.eyebrow[locale]}</Copy>}
      {section.heading && <Copy accessibilityRole="header" style={{ fontSize: 28, fontWeight: '700' }}>{section.heading[locale]}</Copy>}
      {section.body ? <Copy>{section.body[locale]}</Copy> : section.type === 'richText' && <Copy>{section.text[locale]}</Copy>}
      {section.label && (section.action || section.path) && <Button title={section.label[locale]} onPress={() => navigate(section.action, section.path)} />}
    </View>;
    return <View testID={`section-${section.id}`} style={{ borderRadius: design.radius, overflow: 'hidden', backgroundColor: colors.background }}>
      {section.type === 'heroBanner' && section.layout && <BannerGallery section={section} radius={design.radius} navigate={navigate} />}
      {section.type === 'heroBanner' && !section.layout && <Pressable accessibilityRole="button" accessibilityLabel={section.accessibilityLabel[locale]} onPress={() => navigate(section.action, section.path)}>
        <BannerImage key={section.image} uri={section.image} label={section.accessibilityLabel[locale]} editorial={!!section.appearance} />
      </Pressable>}
      {(section.type === 'richText' || section.appearance) && copy}
    </View>;
  }
  if (section.type === 'categoryGrid') return <View testID={`section-${section.id}`} style={{ gap: design.spacing }}>
    <Copy accessibilityRole="header" style={{ fontSize: 24, fontWeight: '600' }}>{section.title[locale]}</Copy>
    <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', flexWrap: 'wrap', gap: design.spacing }}>
      {section.categories.map(id => {
        const category = categories.find(c => c.id === id || c.slug === id);
        if (!category) return null;
        const open = () => navigate({ type: 'openCategory', categoryId: id });
        const thumbnail = categoryImageURL(category);
        return section.appearance === 'tiles'
          ? <Pressable key={id} accessibilityRole="button" accessibilityLabel={category.name} onPress={open} style={{ width: '46%', gap: 8 }}>
              {thumbnail && <Image source={{ uri: thumbnail }} style={{ width: '100%', aspectRatio: 1, borderRadius: design.radius }} resizeMode="contain" />}
              <Copy style={{ fontSize: 14, fontWeight: '600' }}>{category.name}</Copy>
            </Pressable>
          : <View key={id} style={{ width: '100%' }}><Button title={category.name} secondary onPress={open} /></View>;
      })}
    </View>
  </View>;
  const cards = products.slice(0, section.limit).map(product => <Pressable key={product.id} accessibilityRole="button" accessibilityLabel={product.name} onPress={() => openProduct(product)} style={[box, { width: section.type === 'productCarousel' ? 200 : section.columns === 2 ? '47%' : '100%' }]}>
    {!!imageURL(product) && <Image source={{ uri: imageURL(product)! }} style={{ width: '100%', aspectRatio: 1 }} resizeMode="contain" />}
    <Copy style={{ fontWeight: '600' }}>{product.name}</Copy><Copy>{formatMoney(product.price, product.currency, locale)}</Copy>
  </Pressable>);
  return <View testID={`section-${section.id}`} style={{ gap: design.spacing }}>
    <Copy accessibilityRole="header" style={{ fontSize: 24, fontWeight: '600' }}>{section.title[locale]}</Copy>
    {state === 'loading' && <ActivityIndicator color={colors.primary} />}
    {state === 'error' && <><Copy accessibilityRole="alert">{locale === 'ar' ? 'تعذر تحميل المنتجات' : 'Unable to load this collection'}</Copy><Button title={locale === 'ar' ? 'إعادة المحاولة' : 'Retry'} onPress={() => setRetry(v => v + 1)} /></>}
    {state === 'ready' && !products.length && <Copy>{locale === 'ar' ? 'لا توجد منتجات' : 'No products in this collection'}</Copy>}
    {section.type === 'productCarousel' ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: design.spacing, flexDirection: rtl ? 'row-reverse' : 'row' }}>{cards}</ScrollView> : <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', flexWrap: 'wrap', gap: design.spacing }}>{cards}</View>}
  </View>;
}
