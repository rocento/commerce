import '@commerce/ui/fonts.css';
import { useInterface } from './interface-locale';
import { takeThemeWarmup } from './theme-warmup';
import { CheckoutLoading } from './checkout-loading';
import { receiveThemePreview } from "./theme-preview";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, catalogApi, customerSessionHeaders, defaultTheme, localizeTheme, themeApi, validateTheme, type ThemeSection, type BestsellerPeriod } from '@commerce/api-client';
import { ProductCard, shopperCategories } from './catalog';
import { useDeliveryKey } from './locations';
import { themeDirection, tokenCss } from './theme-tokens';
import { ThemeContext, CollectionContext } from './theme-sections';
import { StorefrontImage, StorefrontImages } from './storefront-image';
import { configureDiscoveryAttribution } from './discovery-attribution';
export { tokenCss } from './theme-tokens';
export { useTheme, themeOptions, ThemeSections, ThemeGlobal, ThemePageView } from './theme-sections';
import { bestsellerDescription } from './bestsellers';
import './themes.css';
import './showcase.css';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { t: ui } = useInterface();
  const { pathname } = useLocation();
  const previewId = useMemo(() => new URLSearchParams(window.location.search).get('theme_preview'), []);
  const previewParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const delivery = useDeliveryKey();
  const [session, setSession] = useState(0);
  const [city, setCity] = useState(() => { try { return sessionStorage.getItem('commerce-theme-city') || ''; } catch { return ''; } });
  useEffect(() => { const update = () => setSession(v => v + 1); window.addEventListener('commerce-theme-session', update); return () => window.removeEventListener('commerce-theme-session', update); }, []);
  const channel = import.meta.env.VITE_SALES_CHANNEL || 'storefront';
  // Draft previews bypass shopper targeting. A session change must not unmount
  // the app and start another customer restore / preview request cycle.
  const queryKey = previewId ? ['theme-preview', previewId] : ['theme', channel, delivery, session, city];
  const query = useQuery({ queryKey, queryFn: async ({ signal }) => {
    const resolved = previewId ? { configuration: previewParams.has('preview_channel') ? await receiveThemePreview(previewId, previewParams.get('preview_parent') || '', previewParams.get('preview_channel') || '', signal) : await themeApi.preview(previewId), cities: [] as string[], images: {}, discovery_attribution_enabled: false } : await (session === 0 ? takeThemeWarmup(channel, city, delivery, !!customerSessionHeaders().Authorization) : undefined) || await themeApi.resolve(channel, city);
    const config = resolved.configuration;
    const errors = validateTheme(config);
    if (errors.length) throw new Error('Theme configuration could not be loaded');
    configureDiscoveryAttribution(resolved.discovery_attribution_enabled === true);
    return resolved;
  }, staleTime: previewId ? 0 : 30000, refetchInterval: previewId ? false : 30000, retry: false, placeholderData: keepPreviousData });
  const {locale, direction: localeDirection} = useInterface();
  const rawConfig = query.data?.configuration;
  const config = useMemo(() => {const base = localizeTheme(rawConfig || defaultTheme(), locale); return {...base,tokens:{...base.tokens,'layout.direction':localeDirection}};}, [rawConfig, locale, localeDirection]);
  const direction = themeDirection(config);
  useLayoutEffect(() => {
    const previous = document.documentElement.getAttribute('dir');
    document.documentElement.setAttribute('dir', direction);
    return () => {
      if (previous === null) document.documentElement.removeAttribute('dir');
      else document.documentElement.setAttribute('dir', previous);
    };
  }, [direction]);
  const css = useMemo(() => tokenCss(config, locale), [config, locale]);
  useEffect(() => { if (query.error) console.error('theme_resolution_failure', query.error); }, [query.error]);
  if (previewId && query.isPending) return <p role="status">Loading preview...</p>;
  if (previewId && query.error) return <main><h1>Preview unavailable</h1><p role="alert">{query.error instanceof ApiError && [401, 403].includes(query.error.status) ? "Open this draft from the signed-in admin theme editor. Preview access follows your admin role permissions." : query.error.message}</p><button onClick={() => void query.refetch()}>Retry preview</button></main>;
  // Never paint the built-in grocery fallback before the store's assigned
  // theme resolves. It is especially jarring for editorial storefronts.
  if (!query.data && query.isPending && pathname === "/checkout") return <div className="store-shell checkout-store-shell"><CheckoutLoading /></div>;
  if (!query.data && query.isPending) return <main className="theme-bootstrap" aria-busy="true"><span aria-hidden="true"></span><p>{ui("storefront.loading_your_store", "Loading your store")}</p></main>;
  if (!query.data && query.error) return <main className="theme-bootstrap"><h1>{ui("storefront.storefront_unavailable", "Storefront unavailable")}</h1><p role="alert">{ui("storefront.we_could_not_load_this_storefront_please_refresh_and_try_again", "We could not load this storefront. Please refresh and try again.")}</p></main>;
  return <ThemeContext.Provider value={config}><StorefrontImages.Provider value={query.data?.images || {}}><CollectionContext.Provider value={{ products: section => <Products section={section} />, categories: section => <Categories section={section} /> }}><style>{css}</style>{previewId && <div className="theme-preview-status" role="status">Draft preview</div>}{!previewId && !!query.data?.cities?.length && <label className="theme-city-selector">{ui("storefront.shopping_city", "Shopping city")} <select aria-label={ui("storefront.shopping_city", "Shopping city")} value={city} onChange={e => { setCity(e.target.value); try { sessionStorage.setItem('commerce-theme-city', e.target.value); } catch { /* Session storage may be disabled. */ } }}><option value="">{ui("storefront.no_city_preference", "No city preference")}</option>{query.data.cities.map(name => <option key={name}>{name}</option>)}</select></label>}{children}</CollectionContext.Provider></StorefrontImages.Provider></ThemeContext.Provider>;
}
function Products({ section: s }: { section: ThemeSection }) {
  const { t: ui, locale } = useInterface();
  const delivery = useDeliveryKey();
  const query = string(s, 'query');
  const category = string(s, 'category');
  const bestsellers = s.component === 'best_sellers';
  const period = String(s.settings.period || 'last_month') as BestsellerPeriod;
  const limit = Number(s.settings.limit || 8);
  const q = useQuery({ queryKey: ['theme-products', delivery, query, category, bestsellers, period, limit, locale], queryFn: async () => { if (bestsellers) { const result = await catalogApi.bestsellers(period, limit, locale); return { hits: result.products, scope: result.scope }; } return { ...await catalogApi.search({ q: query, ...(category ? { category_id: category } : {}) }, undefined, locale), scope: undefined }; }, staleTime: 30000 });
  return <section className="theme-section"><h2>{string(s, 'heading')}</h2>{bestsellers && <p>{bestsellerDescription(period, q.data?.scope)}</p>}{q.isPending ? <p role="status">{ui("storefront.loading_products", "Loading products...")}</p> : q.error ? <p role="alert">{ui("storefront.products_are_temporarily_unavailable", "Products are temporarily unavailable.")}</p> : bestsellers && !q.data?.hits.length ? <p>{ui("storefront.no_best_sellers_for_this_period_yet", "No best sellers for this period yet.")}</p> : <div className="theme-grid">{q.data?.hits.slice(0, Number(s.settings.limit)).map(p => <ProductCard key={p.id} product={p} />)}</div>}</section>;
}
function Categories({ section: s }: { section: ThemeSection }) {
  const { t: ui, locale } = useInterface();
  const delivery = useDeliveryKey();
  const q = useQuery({ queryKey: ['categories', locale], queryFn: () => catalogApi.categories(locale) });
  const base = shopperCategories(q.data ?? []);
  const availability = useQuery({ queryKey: ['theme-category-availability', base.map(c => c.id), delivery], enabled: base.length > 0, staleTime: 30000, queryFn: ({ signal }) => catalogApi.categoryAvailability(signal) });
  return <section className="theme-section"><h2>{string(s, 'heading')}</h2>{q.error ? <p role="alert">{ui("storefront.categories_are_temporarily_unavailable", "Categories are temporarily unavailable.")}</p> : <nav className={s.component === 'category_showcase' ? 'theme-category-showcase' : 'theme-category-showcase theme-category-grid'} aria-label={string(s, 'heading')}>{shopperCategories(q.data ?? [], { availability: availability.data }).slice(0, Number(s.settings.limit)).map(c => <Link to={`/categories/${c.id}`} key={c.id}>{c.thumbnail ? <StorefrontImage id={c.thumbnail} metadata={c.images?.[c.thumbnail]} alt="" sizes="(max-width: 640px) 50vw, 25vw" loading="lazy" /> : <span className="theme-category-placeholder" aria-hidden="true">{c.name.slice(0, 1)}</span>}<span>{c.name}</span></Link>)}</nav>}</section>;
}

const string = (s: ThemeSection, key: string) => String(s.settings[key] || '');
