import '@commerce/ui/fonts.css';
import { PublicNotificationBell } from '../storefront-notifications';
import { PublicInterfaceProvider, useInterface } from '../interface-locale';
import { PurchaseAssurance } from "../purchase-assurance";
import { InstallApp } from "../install-app";
import { ProductPrice } from "../product-price";
import '../comparison.css';
import { bestsellerDescription } from '../bestsellers';
import { PublicBestsellers } from './bestsellers';
import { MerchantIdentity, ContentContext, Comparison } from './merchant';
import { PublicationImage, PublicImages, PublicPrimaryImage } from './image';
import { PublicSearch } from './search';
import { Router } from 'react-router-dom';
import { localizeTheme, type ThemeSection, type BestsellerPeriod } from '@commerce/api-client';
import { ContentBlocks } from '../content-blocks';
import { CollectionContext, ThemeContext, ThemeGlobal, ThemePageView, themeOptions } from '../theme-sections';
import { themeDirection, tokenCss } from '../theme-tokens';
import type { PublicProduct, PublicSnapshot } from './types';
import '@commerce/ui/styles.css';
import '../style.css';
import '../themes.css';
import '../showcase.css';
import '../content.css';
import '../catalog.css';
import './public.css';

const destination = (to: unknown) => typeof to === 'string' ? to : `${(to as { pathname: string }).pathname || ''}${(to as { search?: string }).search || ''}`;
const navigator = {
  createHref: destination,
  go: (n: number) => window.history.go(n),
  push: (to: unknown) => window.location.assign(destination(to)),
  replace: (to: unknown) => window.location.replace(destination(to)),
};
function Card({ product: p }: { product: PublicProduct }) {
  const {t: ui}=useInterface();
  return <article className="product-card"><a href={`/products/${p.slug}`}>{p.image_id && <PublicationImage id={p.image_id} alt={p.image_alt || p.name} sizes="(max-width: 640px) 50vw, 25vw" />}<h3>{p.name}</h3></a><p>{p.product_type === "simple" ? <ProductPrice price={p.price} originalPrice={p.original_price} currency={p.currency} unit={p.unit}/> : ui("public.choose_options_for_pricing", "Choose options for pricing")}</p></article>;
}
function Grid({ products }: { products: PublicProduct[] }) {
  return <div className="theme-grid product-grid">{products.map(p => <Card key={p.id} product={p} />)}</div>;
}
export function PublicPage({ snapshot }: { snapshot: PublicSnapshot }) {
  return <PublicInterfaceProvider locale={snapshot.locale} initialBundle={snapshot.interface_bundle}><PublicPageContent snapshot={snapshot}/></PublicInterfaceProvider>;
}
function PublicPageContent({ snapshot }: { snapshot: PublicSnapshot }) {
  const {t: ui,direction}=useInterface();
  const localizedTheme=localizeTheme(snapshot.theme,snapshot.locale);
  const s = {...snapshot, theme:{...localizedTheme,tokens:{...localizedTheme.tokens,'layout.direction':direction}}};
  const category = s.categories.find(c => c.id === s.category_id);
  const p = s.product;
  const hero = [...s.theme.global.top, ...(s.theme.pages[s.kind as keyof typeof s.theme.pages] || [])].find(section => section.enabled && ['hero', 'editorial_hero'].includes(section.component) && section.settings.image);
  const primaryImage = p?.image_id || (hero ? String(hero.settings.image) : s.content?.blocks.find(block => block.image_id)?.image_id) || null;
  const ancestors = []; const seen = new Set<string>();
  let ancestor = category;
  while (ancestor && !seen.has(ancestor.id)) { ancestors.unshift(ancestor); seen.add(ancestor.id); ancestor = s.categories.find(c => c.id === ancestor?.parent_id); }
  const headerOptions = themeOptions(s.theme, 'header_options', 'top');
  const heritage = s.theme.global.top.some(section => section.enabled && section.component === 'presentation' && section.settings.style === 'heritage');
  const collection = (section: ThemeSection) => {
    const categoryId = String(section.settings.category || '');
    const products = (s.collections[section.id] || []).filter(item => section.component !== 'recommendations' || !p || (item.id !== p.id && item.category_id === p.category_id));
    if (section.component === 'best_sellers') return <PublicBestsellers heading={String(section.settings.heading || 'Best sellers')} period={String(section.settings.period || 'last_month') as BestsellerPeriod} limit={Math.max(1, Math.min(24, Number(section.settings.limit || 8)))} locale={s.locale}>
      <section className="theme-section"><h2>{String(section.settings.heading || 'Best sellers')}</h2><p>{bestsellerDescription(String(section.settings.period || 'last_month'))}</p>{products.length ? <Grid products={products} /> : <p>{ui("storefront.no_best_sellers_for_this_period_yet", "No best sellers for this period yet.")}</p>}<a href="/search">{ui("storefront.browse_all_products", "Browse all products")}</a></section>
    </PublicBestsellers>;
    if (!products.length) return null;
    return <section className="theme-section"><h2>{String(section.settings.heading || '')}</h2><Grid products={products} /><a href={categoryId && s.categories.find(c => c.id === categoryId) ? `/categories/${s.categories.find(c => c.id === categoryId)!.slug}` : '/search'}>{ui("storefront.browse_all_products", "Browse all products")}</a></section>;
  };
  const categories = (section: ThemeSection) => <section className="theme-section"><h2>{String(section.settings.heading || '')}</h2><nav className="theme-category-showcase">{s.categories.slice(0, Number(section.settings.limit || 8)).map(c => <a href={`/categories/${c.slug}`} key={c.id}>{c.thumbnail && <PublicationImage id={c.thumbnail} alt={c.name} />}<span>{c.name}</span></a>)}</nav></section>;
  const pagination = <nav aria-label={ui("public.pagination", "Pagination")}>{s.page > 1 && <a rel="prev" href={`${s.path}?page=${s.page - 1}`}>{ui("public.previous_page", "Previous page")}</a>}<span>{ui("public.page_page", "Page {page}", {page:s.page})}</span>{s.has_next && <a rel="next" href={`${s.path}?page=${s.page + 1}`}>{ui("public.next_page", "Next page")}</a>}</nav>;
  return <PublicImages.Provider value={s.images}><PublicPrimaryImage.Provider value={primaryImage}><Router location={s.path} navigator={navigator}><ThemeContext.Provider value={s.theme}><CollectionContext.Provider value={{ products: collection, categories }}><style>{tokenCss(s.theme, s.locale)}</style><div lang={s.locale} dir={s.locale.split('-')[0] === 'ar' ? 'rtl' : themeDirection(s.theme)} id="store-top" className="store-shell" data-presentation={String(s.theme.global.top.find(section => section.enabled && section.component === 'presentation')?.settings.style || 'standard')}>
    <ThemeGlobal location="top" header={<header className="store-header"><a className="brand" href="/">{headerOptions.image && s.images[String(headerOptions.image)] ? <PublicationImage className="header-custom-logo" id={String(headerOptions.image)} alt={String(headerOptions.alt || s.site_name)} style={{ width: Number(headerOptions.logo_width) }} /> : s.site_name}</a><div className={heritage ? "header-left-tools public-header-left" : "header-search-zone"}>{heritage && headerOptions.show_location === 'on' && <a href="/delivery-location">{ui("storefront.delivery_location_2", "Delivery location")}</a>}<PublicSearch /></div><nav aria-label={ui("storefront.shopper_tools", "Shopper tools")}>{!heritage && headerOptions.show_location === 'on' && <a href="/delivery-location">{ui("storefront.delivery_location_2", "Delivery location")}</a>}<PublicNotificationBell/><a href="/cart">{ui("storefront.cart", "Cart")}</a><details className="header-account-menu"><summary className="header-link">{ui("navigation.account", "My account")}</summary><div className="header-account-options"><a href="/account">{ui("navigation.account", "My account")}</a><a href="/assistant">{ui("storefront.shopping_assistant", "Shopping assistant")}</a><a href="/support">{ui("storefront.support", "Support")}</a></div></details></nav></header>} navigation={<nav className="category-nav" aria-label={ui("storefront.shop_categories", "Shop categories")}><a href="/search">{ui("storefront.shop_all", "Shop all")}</a>{s.categories.map(c => <a key={c.id} href={`/categories/${c.slug}`}>{c.name}</a>)}</nav>} />
    {s.status !== 200 ? <main><h1>{s.status === 410 ? ui("public.this_page_has_been_permanently_removed", "This page has been permanently removed") : ui("storefront.page_not_found", "Page not found")}</h1><a href="/">{ui("public.return_to_the_store", "Return to the store")}</a></main> : <>
      {s.kind !== 'home' && <nav className="public-breadcrumbs" aria-label={ui("storefront.breadcrumb", "Breadcrumb")}><a href="/">{s.site_name}</a>{ancestors.map(c => <a key={c.id} href={`/categories/${c.slug}`}>{c.name}</a>)}<span>{p?.name || s.content?.title}</span></nav>}
      {s.kind === 'home' && <><ThemePageView page="home" heading={s.site_name} />{s.content && <section className="content-page"><h2>{s.content.title}</h2><ContentBlocks blocks={s.content.blocks} /></section>}<section className="theme-section"><h2>{ui("public.browse_our_catalog", "Browse our catalog")}</h2><Grid products={s.products} />{pagination}</section></>}
      {s.kind === 'category' && <ThemePageView page="category"><main><h1>{category?.name}</h1><p>{category?.description}</p><p>{s.availability}</p><nav aria-label={ui("public.subcategories", "Subcategories")}>{s.categories.filter(c => c.parent_id === category?.id).map(c => <a key={c.id} href={`/categories/${c.slug}`}>{c.name}</a>)}</nav><h2>{ui("storefront.products", "Products")}</h2><Grid products={s.products} />{pagination}</main></ThemePageView>}
      {s.kind === 'product' && p && <ThemePageView page="product"><PublicProductDetail snapshot={s} product={p} /></ThemePageView>}
      {s.kind === 'content' && s.content && <main className="content-page"><h1>{s.content.title}</h1><ContentContext snapshot={s} /><ContentBlocks blocks={s.content.blocks} /><Comparison snapshot={s} /></main>}
      {s.guides.length > 0 && <section className="theme-section"><h2>{ui("public.related_guides", "Related guides")}</h2><nav aria-label={ui("public.related_guides", "Related guides")}>{s.guides.map(guide => <a key={guide.path} href={guide.path}>{guide.title}</a>)}</nav></section>}
    </>}
    {s.status === 200 && <MerchantIdentity snapshot={s} />}
    <ThemeGlobal location="bottom" footer={<><p>{s.site_name}</p><InstallApp /></>} />
  </div></CollectionContext.Provider></ThemeContext.Provider></Router></PublicPrimaryImage.Provider></PublicImages.Provider>;
}

function PublicProductDetail({ snapshot: s, product: p }: { snapshot: PublicSnapshot; product: PublicProduct }) {
  const {t: ui}=useInterface();
  const style = s.theme.global.top.find(section => section.enabled && section.component === 'presentation')?.settings.style;
  const heritage = style === 'heritage';
  const price = <><p className="detail-price">{p.product_type === 'simple' ? <ProductPrice price={p.price} originalPrice={p.original_price} currency={p.currency} unit={p.unit}/> : ui("public.choose_options_for_pricing", "Choose options for pricing")}</p><p>{ui("public.catalog_price_final_pricing_is_confirmed_in_your_cart", "Catalog price. Final pricing is confirmed in your cart.")}</p></>;
  const attributes = <dl id="specifications" className="product-attributes">{Object.entries(p.attributes).map(([key,value]) => <div key={key} id={`spec-${encodeURIComponent(key)}`}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>;
  const shop = <a className="theme-cta" href={`/products/${p.id}?shop=1`}>{ui("public.choose_options_and_add_to_cart", "Choose options and add to cart")}</a>;
  return <main className={`product-main${!heritage && style !== 'showcase' ? ' product-main-grocery' : ''}`}><div className={`product-detail${heritage ? '' : ' product-detail-grocery'}`}>
    <section className="product-media-panel" aria-label="Product image"><div className="detail-image">{p.image_id && s.images[p.image_id] ? <PublicationImage id={p.image_id} alt={p.image_alt || p.name} primary /> : <span className="product-placeholder" aria-label={ui("storefront.image_unavailable", "Image unavailable")}>❧</span>}</div></section>
    <section className={heritage ? 'buy-box' : 'product-summary'}><h1>{p.name}</h1><a className="product-compare-button" href={`/compare?products=${p.id}`}>{ui("comparison.compare", "⇄ Compare")}</a><p>{ui("public.sold_by_brand", "Sold by {brand}", {brand:s.site_name})}</p>{p.sku && <p>{ui("public.sku", "SKU:")}{" "}{p.sku}</p>}<div className="product-overview"><h2>{ui("storefront.product_overview", "Product overview")}</h2><p className="product-description">{p.description}</p>{attributes}</div>{heritage && <>{price}<p>{s.availability}</p>{shop}</>}</section>
    {!heritage && <aside className="purchase-panel" aria-label={ui("storefront.purchase_options", "Purchase options")}><div className="purchase-card purchase-card-refined"><span className="purchase-label">{ui("storefront.price", "Price")}</span>{price}{shop}</div><PurchaseAssurance kind="delivery" title={ui("storefront.delivery_availability_2", "Delivery & availability")}><p>{s.availability}</p><a href="/delivery-location">{ui("storefront.set_delivery_location", "Set delivery location")}<span className="direction-icon" aria-hidden="true">→</span></a></PurchaseAssurance><PurchaseAssurance kind="secure" title={ui("checkout.secure", "Secure checkout")}><p>{ui("storefront.review_your_items_and_final_total_before_placing_your_order", "Review your items and final total before placing your order.")}</p></PurchaseAssurance></aside>}
  </div>{s.parent_product && <p>{ui("public.product_family", "Product family:")}<a href={`/products/${s.parent_product.slug}`}>{s.parent_product.name}</a></p>}{s.family.length > 0 && <section><h2>{p.product_type === 'configurable' ? 'Available variants' : 'Related components'}</h2>{s.variant_dimensions.length > 0 && <p>{ui("public.variants_vary_by", "Variants vary by:")}{s.variant_dimensions.join(', ')}</p>}{s.family.map(item => <article key={item.id}><h3><a href={`/products/${item.slug}`}>{item.name}</a></h3><p>{item.description}</p><p>{ui("public.sku", "SKU:")}{item.sku}</p>{item.image_id && <PublicationImage id={item.image_id} alt={item.image_alt || item.name} />}<p>{item.product_type === 'simple' ? <ProductPrice price={item.price} originalPrice={item.original_price} currency={item.currency} unit={item.unit}/> : ui("public.choose_options_for_pricing", "Choose options for pricing")}</p><dl>{Object.entries(item.attributes).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></article>)}</section>}{s.products.some(item => item.id !== p.id) && <section><h2>{ui("public.more_in_this_category", "More in this category")}</h2><Grid products={s.products.filter(item => item.id !== p.id).slice(0, 4)} /></section>}</main>;
}
