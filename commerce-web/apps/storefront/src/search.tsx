import { shoppingLocationKey } from './interface-routing';
import { useInterface } from './interface-locale';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { catalogApi, mediaUrl, type Product } from '@commerce/api-client';
import { useDeliveryKey } from './use-delivery-key';
import './search.css';
import { useTheme } from './theme-sections';
import { themeDirection } from './theme-tokens';
import { findSearchMatch } from './search-match';

function Thumbnail({ product }: { product: Product }) {
  const { t: ui } = useInterface();
  const [failed, setFailed] = useState(false);
  return <span className="search-thumbnail">{product.media_ids[0] && !failed
    ? <img src={mediaUrl(product.media_ids[0])} alt="" onError={() => setFailed(true)} />
    : <span aria-label={ui("storefront.image_unavailable", "Image unavailable")}>◇</span>}</span>;
}
function Match({ text, query }: { text: string; query: string }) {
  const match = findSearchMatch(text, query);
  return !match ? <>{text}</> : <>{text.slice(0, match.start)}<mark>{text.slice(match.start, match.end)}</mark>{text.slice(match.end)}</>;
}
export type SearchInitialState = { value: string; focused: boolean; selectionStart: number | null; selectionEnd: number | null };
export function SearchBar({ initialState }: { initialState?: SearchInitialState } = {}) {
  const { t: ui, locale } = useInterface();
  const direction = themeDirection(useTheme());
  const location = useLocation(), navigate = useNavigate(), delivery = useDeliveryKey();
  const [value, setValue] = useState(initialState?.value ?? new URLSearchParams(location.search).get('q') ?? '');
  const [debounced, setDebounced] = useState(value.trim());
  const [open, setOpen] = useState(initialState?.focused ?? false), [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const id = useId();
  const previousLocation = useRef(shoppingLocationKey(location.pathname, location.search));
  useLayoutEffect(() => {
    if (initialState?.focused) {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(initialState.selectionStart, initialState.selectionEnd);
    }
  }, [initialState]);
  const [panelWidth, setPanelWidth] = useState(0);
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const resize = () => {
      const box = root.current!.getBoundingClientRect();
      setPanelWidth(Math.max(0, Math.min(window.innerWidth <= 700 ? box.width : 680, (direction === 'rtl' ? box.right : window.innerWidth - box.left) - 20)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [open, direction]);
  useEffect(() => {
    const next = shoppingLocationKey(location.pathname, location.search);
    if (previousLocation.current === next) return;
    previousLocation.current = next;
    setValue(new URLSearchParams(location.search).get('q') ?? '');
    setOpen(false); setActive(-1);
  }, [location.pathname, location.search]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 200);
    return () => clearTimeout(timer);
  }, [value]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const results = useQuery({
    queryKey: ['search-suggestions', debounced, delivery, locale],
    queryFn: ({ signal }) => catalogApi.search({ q: debounced, ...(debounced ? {} : { in_stock: true }) }, signal, locale),
    enabled: open,
    staleTime: 15000,
    retry: 1,
  });
  const pending = value.trim() !== debounced || results.isPending;
  const candidates = results.data?.hits ?? [];
  // Favor complete product cards for discovery; preserve engine relevance for typed queries.
  const ranked = debounced ? candidates : [...candidates].sort((a, b) => Number(b.media_ids.length > 0) - Number(a.media_ids.length > 0));
  const products = pending || results.isError ? [] : ranked.slice(0, 6);
  const selected = active >= 0 ? products[active] : undefined;
  useEffect(() => {
    if (open && selected) document.getElementById(`${id}-${selected.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, id]);
  function search() { setOpen(false); setActive(-1); navigate(`/search?q=${encodeURIComponent(value.trim())}`); }
  return <div className="store-search" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <form className="search-bar" role="search" onSubmit={event => { event.preventDefault(); search(); }}>
      <span aria-hidden="true">⌕</span>
      <input ref={input} role="combobox" aria-label={ui("search.label", "Search products")} aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? `${id}-results` : undefined}
        aria-activedescendant={open && selected ? `${id}-${selected.id}` : undefined}
        autoComplete="off" value={value} maxLength={200} placeholder={ui("search.placeholder", "Search products, brands and essentials")}
        onFocus={() => setOpen(true)} onChange={event => { setValue(event.target.value); setActive(-1); setOpen(true); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { setOpen(false); setActive(-1); event.preventDefault(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true);
            if (products.length) setActive(index => event.key === 'ArrowDown' ? (index + 1) % products.length : (index <= 0 ? products.length - 1 : index - 1));
          }
          if (event.key === 'Enter' && open && selected) { event.preventDefault(); setOpen(false); navigate(`/products/${selected.id}`); }
        }} />
      {value && <button type="button" className="search-clear icon-button" aria-label={ui("search.clear", "Clear search")} onClick={() => { setValue(''); setActive(-1); input.current?.focus(); setOpen(true); }}>×</button>}
      <button type="submit" className="search-submit" aria-label={ui("storefront.search", "Search")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
      </button>
    </form>
    {open && <div className="search-suggestions" style={{ width: panelWidth || undefined }}>
      <div className="search-suggestions-heading"><strong>{value.trim() ? ui("storefront.matching_products", "Matching products") : ui("storefront.explore_products", "Explore products")}</strong><span>{value.trim() ? ui("storefront.find_your_next_essential", "Find your next essential") : ui("storefront.available_picks_from_our_catalog", "Available picks from our catalog")}</span></div>
      <div role="status" className="search-feedback" aria-live="polite">
        {pending ? ui("storefront.searching_products", "Searching products…") : results.isError ? ui("storefront.search_is_temporarily_unavailable", "Search is temporarily unavailable.") : products.length === 0 ? ui("search.no_matches", "No products found for “{query}”. Try a shorter term or check the spelling.", {query:value.trim()}) : ui('search.result_count', '{count} results', {count:results.data?.total ?? 0})}
      </div>
      {results.isError && !pending && <button className="search-retry" type="button" onClick={() => void results.refetch()}>{ui("common.retry", "Try again")}</button>}
      <ul id={`${id}-results`} role="listbox" aria-label={ui("storefront.suggested_products", "Suggested products")} aria-busy={pending}>
        {products.map((product, index) => <li key={product.id} id={`${id}-${product.id}`} role="option" aria-selected={active === index}
          onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()}
          onClick={() => { setOpen(false); navigate(`/products/${product.id}`); }}>
          <Thumbnail key={`${product.id}-${product.media_ids[0]}`} product={product} />
          <span className="search-product-copy"><strong><Match text={product.name} query={debounced} /></strong><small>{product.product_type === 'simple' ? ui("search.per_unit", "Per {unit} \u00b7 {availability}", {unit:product.unit,availability:product.in_stock?ui("storefront.available","Available"):ui("storefront.currently_unavailable","Currently unavailable")}) : ui("storefront.options_available", "Options available")}</small></span>
          <span className="search-product-price">{product.product_type === 'simple' ? new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en-US', { style: 'currency', currency: product.currency }).format(Number(product.price)) : ui("storefront.view_options", "View options")}<span aria-hidden="true">↗</span></span>
        </li>)}
      </ul>
      <div className="search-suggestions-footer"><span>{ui("storefront.to_browse_enter_to_open_esc_to_close", "↑ ↓ to browse · Enter to open · Esc to close")}</span><Link to={`/search?q=${encodeURIComponent(value.trim())}`} onClick={() => setOpen(false)}>{value.trim() ? ui("storefront.view_all_results", "View all results") : ui("storefront.browse_all_products", "Browse all products")} <span className="direction-icon" aria-hidden="true">→</span></Link></div>
    </div>}
  </div>;
}
