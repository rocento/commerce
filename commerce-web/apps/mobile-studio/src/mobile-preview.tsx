import { MobileBannerGallery } from "./mobile-banner-gallery";
import { PreviewVariants, usePreviewVariants } from './mobile-preview-variants';
import { MobilePreviewStatus } from './mobile-preview-status';
import { PreviewAssistant } from './mobile-preview-assistant';
import { PreviewInformation } from './mobile-preview-information';
import { PreviewSupport } from './mobile-preview-support';
import { PreviewPreferences, usePreviewPreferences } from './mobile-preview-preferences';
import './mobile-native-products.css';
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  mobileApi,
  type MobileConfig,
  type MobileAction,
  type MobileAsset,
  type MobileSection,
  type MobileCatalogProduct,
  type MobilePreviewCategory,
} from "@commerce/api-client";
import { PreviewWishlist, usePreviewProfile } from "./mobile-preview-profile";
import { PreviewSearch, usePreviewSearch } from "./mobile-preview-search";
import { useNativePreviewCheckout } from "./mobile-native-checkout-model";
import { NativeCartCheckout, NativeCheckoutControls } from "./mobile-native-checkout";
import { NativeAddressDialog } from "./mobile-native-address";
import { usePreviewCart } from "./mobile-preview-cart";
import { useMobileCatalog } from "./mobile-catalog";
import { MobilePreviewIcon, type PreviewPlatform } from "./mobile-preview-icon";
import { PreviewProductSheet } from "./mobile-preview-sheet";
import { PreviewAccount } from "./mobile-preview-account";
import "./mobile-preview-native.css";
import "./mobile-preview-parity.css";
const english: Record<string, string> = {
  about: "About us", privacy: "Privacy policy", terms: "Terms & conditions", help: "Help & support", contact: "Contact us", notifications: "Notifications", settings: "App settings",
  home: "Home",
  categories: "Categories",
  deals: "Deals",
  cart: "Cart",
  account: "Account",
  wishlist: "Wishlist",
  search: "Search",
};
const arabic: Record<string, string> = {
  about: "من نحن", privacy: "سياسة الخصوصية", terms: "الشروط والأحكام", help: "المساعدة والدعم", contact: "تواصل معنا", notifications: "الإشعارات", settings: "إعدادات التطبيق",
  home: "الرئيسية",
  categories: "الأقسام",
  deals: "العروض",
  cart: "السلة",
  account: "الحساب",
  wishlist: "المفضلة",
  search: "بحث",
};
export const previewTargets = {
  "ios-swift": { platform: "iOS", label: "iOS (Swift)", description: "Browser simulation · SwiftUI target" },
  "android-kotlin": { platform: "Android", label: "Android (Kotlin)", description: "Browser simulation · Compose target" },
  "ios-react-native": { platform: "iOS", label: "iOS (React Native)", description: "React Native · Shared browser simulation" },
  "android-react-native": { platform: "Android", label: "Android (React Native)", description: "React Native · Shared browser simulation" },
} as const;
export type PreviewTarget = keyof typeof previewTargets;
type PreviewProps = {
  environment?: "staging" | "production";
  savedRevision?: number;
  hasLocalChanges?: boolean;
  target?: PreviewTarget | "both";
  readOnly?: boolean; config: MobileConfig; assets: MobileAsset[];
  locale: "en" | "ar"; width: number; select: (id: string) => void; selected?: string;
};
export function MobilePreview(props: PreviewProps) {
  const catalog = useMobileCatalog(props.config, props.locale);
  const [editing, setEditing] = useState(false);
  return <>
    <MobilePreviewStatus environment={props.environment} config={props.config} savedRevision={props.savedRevision} hasLocalChanges={props.hasLocalChanges} readOnly={props.readOnly} />
    <div className="ms-catalog-status" role="status">
      <span>{catalog.results.__catalog__?.data ? `Live catalog · ${new URL(catalog.results.__catalog__.data.source).hostname}` : catalog.results.__catalog__?.error || 'Connecting merchant catalog…'}</span>
      <button type="button" onClick={catalog.refresh}>Refresh catalog</button>
    </div>
    <div className="ms-native-preview-tools">
      <label><input type="checkbox" disabled={props.readOnly} checked={!props.readOnly && editing} onChange={e => setEditing(e.target.checked)} /> Show section editing controls</label>
      <span>Simulated devices · Demo shopping session</span>
    </div>
    <div className="ms-devices">{(props.target && props.target !== "both" ? [props.target] : ["ios-swift", "android-kotlin"] as PreviewTarget[]).map(target =>
      <PreviewDevice {...props} target={target} key={`${props.config.tenantId}:${target}`} platform={previewTargets[target].platform} editing={!props.readOnly && editing} catalog={catalog} />
    )}</div>
  </>;
}
function PreviewDevice({ config, assets, locale: chosenLocale, width, select, selected, platform, target = "ios-swift", editing, catalog: sharedCatalog }: Omit<PreviewProps, "target"> & {
  target: PreviewTarget; platform: PreviewPlatform; editing: boolean; catalog: ReturnType<typeof useMobileCatalog>;
}) {
  // Keep the device viewport fixed; fit the whole phone without reflowing its UI.
  const screenWidth = width || (platform === "iOS" ? 402 : 412);
  const screenHeight = width ? Math.round(width * 2.16) : (platform === "iOS" ? 874 : 915);
  const frameWidth = screenWidth + (platform === "iOS" ? 16 : 12);
  const deviceRef = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState(frameWidth);
  useEffect(() => {
    const element = deviceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [language, setLanguage] = useState({ chosenLocale, value: chosenLocale });
  useEffect(() => setLanguage({ chosenLocale, value: chosenLocale }), [chosenLocale]);
  const locale = language.chosenLocale === chosenLocale ? language.value : chosenLocale;
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [tab, setActiveTab] = useState('home');
  const activeTab = tab === 'about' || tab === 'privacy' || tab === 'terms' || tab === 'help' || tab === 'contact' || tab === 'notifications' || tab === 'settings' || tab === 'search' || tab === 'wishlist' || config.navigation.tabs.some(item => item === tab) ? tab : config.navigation.tabs[0];
  const [signedIn, setSignedIn] = useState(true);
  const [customerIdentifier,setCustomerIdentifier]=useState('preview@example.com');
  const [actionError, setActionError] = useState('');
  const [comparison, setComparison] = useState<MobileCatalogProduct[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const [accountNavigation, setAccountNavigation] = useState(0);
  const [accountScreen, setAccountScreen] = useState<'home'|'orders'|'addresses'>('home');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<string[]>([]);
  const profile = usePreviewProfile(config.tenantId, target.endsWith("react-native") ? target : platform);
  const cart = usePreviewCart(config.tenantId);
  const checkout = useNativePreviewCheckout(config.tenantId, cart, profile, target.endsWith("react-native") ? target : platform);
  const scope = `${config.tenantId}:${locale}`;
  const [navigation, setNavigation] = useState<{ scope: string; category?: MobilePreviewCategory; product?: MobileCatalogProduct }>({ scope });
  const view = navigation.scope === scope ? navigation : { scope };
  const variants = usePreviewVariants(config.tenantId,locale,view.product,checkout.state.addresses.find(a=>a.id===checkout.state.selectedAddress));
  const purchaseProduct = variants.configurable ? variants.selected : view.product;
  const purchaseQuantity = cart.lines.find(line => line.product.id === purchaseProduct?.id)?.quantity ?? 0;
  const changePurchaseQuantity = (value: number) => { if (!purchaseProduct) return; checkout.invalidate(); if (value === 0) cart.remove(purchaseProduct.id); else cart.quantity(purchaseProduct.id, value); };
  const nativeVariantDetail = !target.endsWith("react-native") && !!variants.selected;
  const detailProduct = nativeVariantDetail ? variants.selected! : view.product!;
  useEffect(()=>{if(nativeVariantDetail)deviceRef.current?.querySelector(".ms-sheet-content")?.scrollTo({top:0});},[nativeVariantDetail,variants.selected?.id]);
  const openCategory = (category: MobilePreviewCategory) => { setActiveTab("categories"); setNavigation({ scope, category }); };
  const openProduct = (product: MobileCatalogProduct) => {  setAssistantOpen(false); setNavigation({ ...view, scope, product }); };
  const browsing = locale !== chosenLocale;
  const browsingCatalog = useMobileCatalog(config, locale, undefined, browsing, sharedCatalog.revision);
  const { results, refresh } = browsing ? browsingCatalog : sharedCatalog;
  const catalog = results.__catalog__;
  const search = usePreviewSearch(config.tenantId, locale, activeTab === "search");
  const deals = usePreviewSearch(config.tenantId, locale, activeTab === "deals");
  const categorySearch = usePreviewSearch(config.tenantId, locale, activeTab === "categories" && Boolean(view.category), view.category?.id);

  const loading = locale === 'ar' ? 'جارٍ تحميل الكتالوج…' : 'Loading merchant catalog…';
  const empty = locale === 'ar' ? 'لا توجد منتجات في هذه المجموعة' : 'No products in this collection.';
  const formatPrice = (price: string, currency: string) => {
    try { return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { style: 'currency', currency }).format(Number(price)); }
    catch { return `${price} ${currency}`; }
  };
  const retryCatalogImage = (image: HTMLImageElement) => {
    if (config.screens.home.layout !== "storefront") return;
    const source = new URL(image.src);
    if (/^\/api\/v1\/catalog\/media\/[a-f0-9-]+\/content$/.test(source.pathname) && source.searchParams.has("width")) {
      source.searchParams.delete("width");
      image.src = source.href;
    }
  };
  const categories = (ids?: string[], tiles = false) => {
    if (!catalog) return <p className="ms-catalog-message">{loading}</p>;
    if (catalog.error) return <p className="ms-catalog-message">{locale === 'ar' ? 'تعذر تحميل كتالوج التاجر' : catalog.error}</p>;
    const all = catalog.data?.categories || [];
    const list = ids ? (tiles ? ids.flatMap(id => { const category = all.find(c => c.id === id || c.slug === id); return category ? [category] : []; }) : all.filter(c => ids.includes(c.id) || ids.includes(c.slug))) : all;
    if (ids && !list.length) return null;
    if (!list.length) return <p className="ms-catalog-message">{locale === 'ar' ? 'لا توجد فئات' : 'No categories available.'}</p>;
    return <div className={`ms-categories${ids ? " ms-category-text-links" : ""}`}>{list.map((category, index) => <button type="button" className="ms-category-link" aria-pressed={category ? view.category?.id === category.id : undefined} disabled={!category} onClick={() => category && openCategory(category)} key={category?.id || index}>
      {tiles && category?.imageUrl && <img src={category.imageUrl} alt="" loading="lazy" onError={e => retryCatalogImage(e.currentTarget)} />}
      <strong>{category?.name || (locale === 'ar' ? 'الفئة غير متاحة' : 'Category unavailable')}</strong>{!ids && platform === 'iOS' && <span className="ms-category-chevron" aria-hidden="true">›</span>}
    </button>)}</div>;
  };
  function products(collection: string, limit?: number) {
    const result = results[collection];
    if (!result) return <p className="ms-catalog-message" role="status">{loading}</p>;
    if (result.error) return <div className="ms-catalog-message" role="alert"><p>{locale === 'ar' ? 'تعذر تحميل هذه المجموعة' : result.error}</p><button type="button" onClick={refresh}>{locale === 'ar' ? 'إعادة المحاولة' : 'Retry'}</button></div>;
    if (!result.data?.products.length) return <p className="ms-catalog-message">{empty}</p>;
    return result.data.products.slice(0, limit ?? 24).map(product => <button type="button" className="ms-product" key={product.id} onClick={() => openProduct(product)} aria-label={`${locale === 'ar' ? 'عرض' : 'View'} ${product.name}`}>
      <div className="ms-product-art">{product.imageUrl ? <img src={product.imageUrl} alt="" loading="eager" onError={e => retryCatalogImage(e.currentTarget)} /> : <span>{locale === 'ar' ? 'لا توجد صورة' : 'No image'}</span>}</div>
      <b>{product.name}</b>
      <small>{config.screens.home.layout === "storefront" ? formatPrice(product.price, product.currency) : `${product.price} ${product.currency}`}</small>
    </button>);
  }
  const preferences = usePreviewPreferences(config.tenantId, target.endsWith("react-native") ? target : platform);
  const palette = config.brand.light;
  const safeColor = (v: string, fallback: string) =>
    /^#[a-f\d]{6}$/i.test(v) ? v : fallback;
  const style = {
    "--phone-outline": '#79747E',
    "--phone-primary": safeColor(palette.primary, "#245D46"),
    "--phone-on-primary": safeColor(palette.onPrimary, "#FFFFFF"),
    "--phone-bg": safeColor(palette.background, "#F5F7F4"),
    "--phone-surface": safeColor(palette.surface, "#FFFFFF"),
    "--phone-text": safeColor(palette.text, "#15281E"),
    "--phone-radius": `${{ none: 0, small: 8, medium: 18, large: 28 }[config.brand.radiusToken]}px`,
    "--phone-space": config.brand.density === "compact" ? "12px" : "20px",
    "--phone-height": `${screenHeight}px`,
    width: screenWidth,
    maxWidth: "none",
    zoom: Math.min(1, availableWidth / frameWidth),
  } as CSSProperties;
  const copy = (key: string) =>
    config.localization.messages[locale]?.[key] ||
    config.localization.messages[config.localization.defaultLocale]?.[key] ||
    `[${key}]`;
  const url = (id: string) => {
    const a = assets.find((a) => a.id === id);
    return a && mobileApi.assetUrl(config.tenantId, a);
  };
  const labels = locale === "ar" ? arabic : english;
  const closeProduct = () => setNavigation({ scope, category: view.category });
  const changeTab = (next: string) => { setAccountNavigation(v=>v+1); setAccountScreen('home'); setActiveTab(next); setNavigation({ scope, category: next === 'categories' ? view.category : undefined }); setActionError(''); };
  function openAction(action: MobileAction) {
    setActionError('');
    if (action.type === 'openTab') { changeTab(action.tab); return; }
    if (action.type === 'openCategory') {
      const category = catalog?.data?.categories.find(c => c.id === action.categoryId || c.slug === action.categoryId);
      openCategory(category || { id: action.categoryId, slug: action.categoryId, name: t('Collection', 'المجموعة'), imageUrl: null });
      return;
    }
    const product = Object.values(results).flatMap(r => r.data?.products || []).find(p => p.id === action.productId);
    if (product) openProduct(product);
    else setActionError(t('This product is not available in the preview catalog.', 'هذا المنتج غير متاح في كتالوج المعاينة.'));
  }
  const grocery = catalog?.data?.source.includes('grocery.') ?? true;
  function editorialCopy(p: { headingKey?: string; bodyKey?: string; eyebrowKey?: string }) {
    return <>{p.eyebrowKey && <span className="ms-editorial-eyebrow">{copy(p.eyebrowKey)}</span>}{p.headingKey && <h3>{copy(p.headingKey)}</h3>}{p.bodyKey && <p>{copy(p.bodyKey)}</p>}</>;
  }
  function editorialLink(p: { labelKey?: string; storefrontPath?: string; action?: MobileAction }) {
    if (!p.labelKey) return null;
    if (p.storefrontPath && catalog?.data?.source) return <a className="ms-editorial-cta" href={catalog.data.source + p.storefrontPath} target="_blank" rel="noopener noreferrer">{copy(p.labelKey)} <span aria-hidden="true">↗</span></a>;
    return p.action ? <button className="ms-editorial-cta" onClick={() => openAction(p.action!)}>{copy(p.labelKey)} <span aria-hidden="true">↗</span></button> : null;
  }
  function section(s: MobileSection) {
    switch (s.type) {
      case "heroBanner":
        if (s.props.layout) return <article className="ms-editorial">
          <MobileBannerGallery section={s} label={copy(s.props.accessibilityLabelKey)} url={url} open={() => openAction(s.props.action)} />
          {s.props.appearance && <div className="ms-editorial-copy">{editorialCopy(s.props)}{editorialLink(s.props)}</div>}
        </article>;
        if (s.props.appearance) return <article className={`ms-editorial ms-editorial-${s.props.appearance}`}>
          {url(s.props.imageAssetId) && <img className="ms-editorial-image" src={url(s.props.imageAssetId)} alt={copy(s.props.accessibilityLabelKey)} />}
          <div className="ms-editorial-copy">{editorialCopy(s.props)}{editorialLink(s.props)}</div>
        </article>;
        return (
          <button type="button" className="ms-hero" aria-label={copy(s.props.accessibilityLabelKey)} onClick={() => openAction(s.props.action)}>
            <div className="ms-hero-art">
              {url(s.props.imageAssetId) && <img src={url(s.props.imageAssetId)} alt="" />}
              {!url(s.props.imageAssetId) && <span className="ms-hero-symbol" aria-hidden="true">{grocery ? '❧' : '◇'}</span>}
              <span className="ms-hero-arrow" aria-hidden="true">↗</span>
            </div>
            <strong>{grocery ? t('A little fresher.\nA little better.', 'طازج أكثر.\nأفضل كل يوم.') : t('Good things,\nfound here.', 'أشياء جميلة،\nتجدها هنا.')}</strong>
            <span>{t('Explore the collection', 'استكشف المجموعة')}</span>
          </button>
        );
      case "richText":
        if (s.props.appearance) return <article className={`ms-editorial ms-editorial-${s.props.appearance}`}><div className="ms-editorial-copy">{editorialCopy(s.props)}{s.props.headingKey ? <p>{copy(s.props.textKey)}</p> : <h3>{copy(s.props.textKey)}</h3>}{editorialLink(s.props)}</div></article>;
        return <p>{copy(s.props.textKey)}</p>;
      case "spacer":
        return (
          <div
            style={{
              height: { small: 8, medium: 16, large: 32 }[s.props.size],
            }}
            aria-label={`${s.props.size} space`}
          />
        );
      case "categoryGrid":
        return (
          <>
            <h4>{copy(s.props.titleKey)}</h4>
            <div className={s.props.appearance === "tiles" ? "ms-category-tiles" : undefined}>{categories(s.props.categoryIds, s.props.appearance === "tiles")}</div>
          </>
        );
      case "productCarousel":
      case "productGrid":
        return (
          <>
            <h4>{copy(s.props.titleKey)}</h4>
            <div
              className={`ms-products ${s.type === "productCarousel" ? "ms-carousel" : ""}`}
              style={
                s.type === "productGrid"
                  ? {
                      gridTemplateColumns: `repeat(${s.props.columns},minmax(0,1fr))`,
                    }
                  : undefined
              }
            >
              {products(s.props.collectionId, s.props.limit)}
            </div>
          </>
        );
    }
  }
  const bottomNavigation = (<nav aria-label={`${platform} preview tabs`}>
          {config.navigation.tabs.map(item => <button type="button" key={item} onClick={() => changeTab(item)} aria-current={activeTab === item ? 'page' : undefined}>
            <span className="ms-tab-icon" aria-hidden="true"><MobilePreviewIcon name={config.navigation.icons?.[item] ?? item} platform={platform} /></span>
            {labels[item]}{item === 'cart' && cart.count > 0 && <span className="ms-cart-badge">{cart.count}</span>}
          </button>)}
        </nav>);
  return <figure ref={deviceRef} className="ms-device" style={{ width: "100%", maxWidth: frameWidth, flex: `0 1 ${frameWidth}px` }} data-testid={`preview-${platform}`} data-preview-target={target} dir={locale === "ar" && config.localization.rtlEnabled ? "rtl" : "ltr"}>
    <figcaption>{previewTargets[target].label}<span>{previewTargets[target].description}</span></figcaption>
    <div className={`ms-phone ms-native-phone ms-${platform.toLowerCase()}${config.screens.home.layout === "storefront" ? " ms-storefront-layout" : ""}`} style={style} data-active-screen={activeTab} data-screen-width={screenWidth} data-screen-height={screenHeight}
      dir={locale === 'ar' && config.localization.rtlEnabled ? 'rtl' : 'ltr'} lang={locale}>
      <div className="ms-device-status" aria-hidden="true"><span>9:41</span><i className="ms-camera-cutout" /><span className="ms-system-symbols">▂▅▇ <svg viewBox="0 0 20 14" width="16" height="12"><path d="M1 4Q10-3 19 4M4 7Q10 2 16 7M7 10Q10 7 13 10" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="10" cy="13" r="1" fill="currentColor"/></svg><i className="ms-battery" /></span></div>
      <div className="ms-native-app" ref={element => { if (element) element.inert = Boolean(view.product || checkout.state.addressOpen || assistantOpen); }}>
        <header className="ms-native-toolbar ms-native-store-header">
          <div className="ms-native-header-row">
            <button type="button" className="ms-native-location-trigger" aria-label={t('Choose delivery location','اختيار موقع التوصيل')} onClick={()=>checkout.openAddress()}><MobilePreviewIcon name="location" platform={platform}/><span><small>{t('Deliver to','التوصيل إلى')}</small>{checkout.state.addresses.find(a=>a.id===checkout.state.selectedAddress)?.street && <strong>{checkout.state.addresses.find(a=>a.id===checkout.state.selectedAddress)?.street}</strong>}</span></button>
            <button type="button" className="ms-native-assistant" data-testid="open-notifications" aria-label={t('Notifications','الإشعارات')} onClick={()=>changeTab('notifications')}><MobilePreviewIcon name="notifications" platform={platform}/></button>
            <button type="button" className="ms-native-assistant" data-testid="open-assistant" aria-label={t('Shopping assistant','مساعد التسوق')} onClick={()=>setAssistantOpen(true)}><MobilePreviewIcon name="assistant" platform={platform}/></button>
          </div>
          <form className="ms-native-header-search" onSubmit={event=>{event.preventDefault();search.apply();changeTab('search');}}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input aria-label={t('Header search','البحث في رأس التطبيق')} placeholder={t('Search products','البحث عن المنتجات')} value={search.filters.q} onChange={event=>search.edit({q:event.target.value})}/>{search.filters.q && <button type="submit" aria-label={t('Submit header search','تنفيذ البحث في رأس التطبيق')}>→</button>}</form>
        </header>
        <div className="ms-phone-content" key={`${scope}:${activeTab}:${view.category?.id || ''}`}>
          {actionError && <p role="alert">{actionError}</p>}
          {activeTab === 'home' ? <>
            {config.screens.home.sections.map(s => <section className={`ms-preview-section${editing && selected === s.id ? ' is-selected' : ''}`} key={s.id} aria-label={sectionLabel(s)}>
              {editing && <button type="button" className="ms-section-edit" aria-label={`Edit ${sectionLabel(s)}`} aria-pressed={selected === s.id} onClick={() => select(s.id)}>{t('Edit section', 'تعديل القسم')}</button>}
              {section(s)}
            </section>)}
          </> : activeTab === 'categories' ? <div className="ms-category-screen ms-native-categories">
            {view.category ? <PreviewSearch reactNative={target.endsWith("react-native")} platform={platform} key={view.category.id} search={categorySearch} category={view.category} back={() => setNavigation({ scope })} categories={catalog?.data?.categories || []} locale={locale} open={openProduct} formatPrice={formatPrice} /> : categories()}
          </div> : activeTab === 'search' ? <PreviewSearch reactNative={target.endsWith("react-native")} platform={platform} search={search} categories={catalog?.data?.categories || []} locale={locale} open={openProduct} formatPrice={formatPrice} />
          : activeTab === 'deals' ? <section className="ms-native-deals" aria-label={t('Deals','العروض')}><h2>{t('Deals','العروض')}</h2><p>{t('Current offers, with savings shown upfront.','العروض الحالية مع توضيح التوفير.')}</p>
            <div className="ms-native-deal-grid">{deals.data?.products.filter(p=>p.originalPrice != null && Number(p.price)<Number(p.originalPrice)).map(product=><button type="button" className="ms-product" key={product.id} onClick={()=>openProduct(product)} aria-label={`${t('View','عرض')} ${product.name}`}><div className="ms-product-art">{product.imageUrl ? <img src={product.imageUrl} alt="" onError={e=>retryCatalogImage(e.currentTarget)}/> : <span>{t('No image','لا توجد صورة')}</span>}</div><b>{product.name}</b><small>{formatPrice(product.price,product.currency)}</small><del>{formatPrice(product.originalPrice!,product.currency)}</del><small>{t('Save','وفّر')} {formatPrice(String(Number(product.originalPrice)-Number(product.price)),product.currency)}</small></button>)}</div>
            {deals.loading ? <p role="status">{loading}</p> : deals.error ? <p role="alert">{t('Unable to load deals. Please retry.','تعذر تحميل العروض. يرجى المحاولة.')}</p> : !deals.data?.products.some(p=>p.originalPrice != null && Number(p.price)<Number(p.originalPrice)) && <p>{deals.data?.nextOffset != null ? t('No offers in these products. Explore more below.','لا توجد عروض في هذه المنتجات. استكشف المزيد أدناه.') : t('No deals available right now','لا توجد عروض حالياً')}</p>}
            {(deals.error || deals.data?.nextOffset != null) && <button className="ms-native-text-button" disabled={deals.loading} onClick={()=>deals.error ? deals.retry() : deals.more()}>{deals.error?t('Retry','إعادة المحاولة'):t('Explore more deals','استكشف المزيد من العروض')}</button>}
          </section>
          : activeTab === 'wishlist' && signedIn ? <PreviewWishlist profile={profile} locale={locale} platform={platform} shop={() => changeTab('categories')} open={openProduct} currentProducts={[...Object.values(results).flatMap(r=>r.data?.products || []),...(search.data?.products || []),...(categorySearch.data?.products || [])]} />
          : activeTab === 'cart' && signedIn ? <NativeCartCheckout checkout={checkout} locale={locale} platform={platform} formatPrice={formatPrice} account={() => changeTab('account')} shop={() => changeTab('home')} />
          : activeTab === 'about' || activeTab === 'privacy' || activeTab === 'terms' ? <PreviewInformation screen={activeTab} locale={locale} brand={config.brand.displayName} version={config.configVersion} account={()=>changeTab('account')} navigate={changeTab} contact={()=>changeTab('contact')}/>
          : activeTab === 'help' || activeTab === 'contact' ? <PreviewSupport screen={activeTab} locale={locale} orders={signedIn?checkout.state.orders:[]} account={()=>changeTab('account')} contact={()=>changeTab('contact')}/>
          : activeTab === 'settings' || activeTab === 'notifications' ? <PreviewPreferences platform={platform} screen={activeTab} locale={locale} setLocale={value=>setLanguage({chosenLocale,value})} preferences={preferences} orders={signedIn?checkout.state.orders:[]} back={()=>changeTab('account')} settings={()=>changeTab('settings')} openOrder={id=>{checkout.selectOrder(id);changeTab('account');setAccountScreen('orders');requestAnimationFrame(()=>document.querySelector(`[data-testid="preview-${platform}"] .ms-order-history-detail`)?.scrollIntoView({block:'start'}));}} version={config.configVersion}/>
          : <PreviewAccount shop={()=>changeTab("categories")} key={accountNavigation} initialScreen={accountScreen} wishlistEnabled={config.features.wishlist} openInformation={changeTab} openHelp={()=>changeTab('help')} openContact={()=>changeTab('contact')} openSettings={()=>changeTab('settings')} openNotifications={()=>changeTab('notifications')} customerIdentifier={customerIdentifier} setCustomerIdentifier={setCustomerIdentifier} profile={profile} openWishlist={() => changeTab("wishlist")} checkout={checkout} formatPrice={formatPrice} locale={locale} platform={platform} signedIn={signedIn} setSignedIn={value => { setSignedIn(value); if (!value) { cart.clear(); checkout.reset(); } }} configVersion={config.configVersion} showConnection={activeTab === 'account'} />}

        </div>
        {bottomNavigation}
      </div>
      <div className="ms-gesture-bar" aria-hidden="true" />
      {view.product && <PreviewProductSheet platform={platform} locale={locale} close={closeProduct} fullScreen title={t('Product','المنتج')} footer={<><div className="ms-purchase-bar">
        <div className="ms-purchase-row"><div><small>{t('Price per item','سعر القطعة')}</small><strong>{formatPrice((purchaseProduct || view.product).price,(purchaseProduct || view.product).currency)}</strong></div>{purchaseQuantity > 0 && <div className="ms-purchase-quantity" role="group" aria-label={t('Quantity','الكمية')}><button type="button" aria-label={t('Decrease quantity','تقليل الكمية')} disabled={checkout.state.pending} onClick={()=>changePurchaseQuantity(purchaseQuantity-1)}>−</button><output aria-label={t('Current quantity','الكمية الحالية')}>{purchaseQuantity}</output><button type="button" aria-label={t('Increase quantity','زيادة الكمية')} disabled={purchaseQuantity>=99 || checkout.state.pending} onClick={()=>changePurchaseQuantity(purchaseQuantity+1)}>+</button></div>}</div>
        {purchaseQuantity === 0 && <button type="button" className="ms-cart-primary" disabled={checkout.state.pending || (signedIn && (!purchaseProduct || !cart.canAdd(purchaseProduct)))} onClick={()=>{if(!signedIn){changeTab('account');return;}checkout.invalidate();if(purchaseProduct)cart.add(purchaseProduct,1);}}>{!signedIn ? t('Sign in to shop','سجل الدخول للتسوق') : variants.configurable && !purchaseProduct ? t('Choose an option','اختر أحد الخيارات') : !purchaseProduct?.inStock ? t('Out of stock','غير متوفر') : t('Add to cart','إضافة إلى السلة')}</button>}
        {cart.lines.some(line=>line.product.id===purchaseProduct?.id)&&<div className="ms-added-to-cart" role="status"><span>{t('In cart','في السلة')}: {cart.lines.find(line=>line.product.id===purchaseProduct?.id)!.quantity}</span><button type="button" onClick={()=>changeTab('cart')}>{t('View cart','عرض السلة')}</button></div>}
      </div>{bottomNavigation}</>}>
        <article className="ms-product-detail ms-native-product" aria-label={locale === 'ar' ? 'تفاصيل المنتج' : 'Product details'}>
                  <div className="ms-detail-image">{detailProduct.imageUrl ? <img src={detailProduct.imageUrl} alt={detailProduct.name} onError={e => retryCatalogImage(e.currentTarget)} /> : <svg className="ms-detail-placeholder" aria-label={t("No image","لا توجد صورة")} viewBox="0 0 100 80" fill="none" stroke="currentColor" strokeWidth="6"><rect x="5" y="5" width="90" height="70" rx="10"/><circle cx="31" cy="28" r="9" fill="currentColor" stroke="none"/><path d="M8 61 30 42 45 55 64 38 92 58V70H8Z" fill="currentColor" stroke="none"/></svg>}</div>
                  <div className="ms-detail-overview"><h2>{detailProduct.name}</h2>
                  <p className="ms-detail-price">{target.endsWith("react-native") ? formatPrice(detailProduct.price, detailProduct.currency) : `${detailProduct.price} ${detailProduct.currency}`}{detailProduct.unit && <small> / {detailProduct.unit}</small>}</p>
                  {detailProduct.originalPrice && <p><del>{formatPrice(detailProduct.originalPrice, detailProduct.currency)}</del></p>}
                  <p className="ms-detail-description">{detailProduct.description || ''}</p>
                  <p className="ms-stock">{detailProduct.inStock ? (locale === 'ar' ? 'متوفر' : 'Available') : (locale === 'ar' ? 'غير متوفر' : 'Out of stock')}</p>
                  </div>
                  {signedIn && config.features.wishlist && config.screens.product?.showWishlist !== false && <button type="button" className="ms-wishlist-toggle" aria-label={profile.wishlist.some(p=>p.id===detailProduct.id) ? t('Remove from wishlist', 'إزالة من المفضلة') : t('Save to wishlist', 'حفظ في المفضلة')} aria-pressed={profile.wishlist.some(p=>p.id===detailProduct!.id)} onClick={() => profile.toggle(detailProduct!)}><MobilePreviewIcon name="wishlist" platform={platform} /></button>}
                  {config.screens.product?.showCompare !== false && <div className="ms-product-compare">
                    <button type="button" aria-label={t('Compare this product','مقارنة هذا المنتج')} aria-pressed={comparison.some(p=>p.id===detailProduct.id)} disabled={comparison.length>=5 && !comparison.some(p=>p.id===detailProduct.id)} onClick={()=>setComparison(items=>items.some(p=>p.id===detailProduct.id)?items.filter(p=>p.id!==detailProduct.id):[...items,detailProduct])}><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="8" height="18"/><rect x="14" y="3" width="8" height="18"/></svg></button>
                    {!!comparison.length && <button type="button" aria-label={t('Compare products','مقارنة المنتجات')} onClick={()=>setShowComparison(v=>!v)}>↔</button>}
                    {showComparison && <div>{comparison.map(product=><div key={product.id}><strong>{product.name}</strong><p>{formatPrice(product.price,product.currency)}</p><button type="button" onClick={()=>setComparison(items=>items.filter(p=>p.id!==product.id))}>{t('Remove','إزالة')}</button></div>)}</div>}
                  </div>}
                  {!nativeVariantDetail && <PreviewVariants state={variants} locale={locale} choose={id=>{variants.choose(id);}} location={()=>checkout.openAddress()} />}

                </article>
      </PreviewProductSheet>}
      {assistantOpen && <PreviewAssistant messages={assistantMessages} setMessages={setAssistantMessages} platform={platform} locale={locale} close={()=>setAssistantOpen(false)} bag={()=>{setAssistantOpen(false);changeTab('cart');}} openProduct={product=>{setAssistantOpen(false);openProduct(product);}} products={[...new Map(Object.values(results).flatMap(r=>r.data?.products || []).map(p=>[p.id,p])).values()]} />}
      {checkout.state.addressOpen && <NativeAddressDialog checkout={checkout} locale={locale} platform={platform} />}
    </div>
      <div className="ms-device-preview-utility"><button type="button" className="ms-open-search" aria-label={t('Search store', 'البحث في المتجر')} onClick={() => { changeTab('search'); }}>{t('Search store', 'البحث في المتجر')}</button><span>{t('Demo shopping · No real orders or assistant requests', 'تسوق تجريبي · لا توجد طلبات أو محادثات حقيقية')}</span></div>
      <NativeCheckoutControls checkout={checkout} locale={locale} />
  </figure>;
}
function sectionLabel(s: MobileSection) { return `${s.type} ${s.id}`; }
