import { useInterface } from './interface-locale';
import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { catalogApi, mediaUrl } from '@commerce/api-client';
import { useDeliveryKey } from './locations';
import { comparisonIds, comparisonLimit, comparisonValue, mergeComparison, toggleComparison } from './comparison-model';
import './comparison.css';
import { catalogPrice } from './catalog-price';
export type ComparisonClearResult = { removed: number; persisted: boolean };
const Context = createContext<{ ids: string[]; clearVersion: number; toggle: (id: string) => void; clear: () => ComparisonClearResult; add: (ids: string[]) => void } | null>(null);
export function ComparisonProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>(() => { try { return comparisonIds(sessionStorage.getItem('rocento-compare')); } catch { return []; } });
  const current = useRef(ids);
  const [clearVersion, setClearVersion] = useState(0);
  const update = useCallback((next: string[]) => {
    current.current = next;
    setIds(next);
    try {
      if (next.length) sessionStorage.setItem('rocento-compare', next.join(','));
      else sessionStorage.removeItem('rocento-compare');
      return true;
    } catch { return false; /* In-memory selection still works. */ }
  }, []);
  const toggle = useCallback((id: string) => { update(toggleComparison(current.current,id)); }, [update]);
  const clear = useCallback(() => {
    const removed = current.current.length;
    const persisted = update([]);
    setClearVersion(version => version + 1);
    return { removed, persisted };
  }, [update]);
  const add = useCallback((incoming: string[]) => { update(mergeComparison(current.current,incoming)); }, [update]);
  return <Context.Provider value={{ ids, clearVersion, toggle, clear, add }}>{children}</Context.Provider>;
}
export function useComparison() { return useContext(Context); }
export function CompareButton({ id, name }: { id: string; name: string }) {
  const {t:ui}=useInterface();
  const comparison = useContext(Context);
  if (!comparison) return null;
  const selected = comparison.ids.includes(id);
  return <button type="button" className="product-compare-button" aria-pressed={selected} aria-label={selected ? ui('comparison.remove','Remove {name} from comparison',{name}) : ui('comparison.add','Add {name} to comparison',{name})} disabled={!selected && comparison.ids.length >= comparisonLimit} onClick={() => comparison.toggle(id)}>{selected ? ui('comparison.selected','✓ Selected for comparison') : ui('comparison.compare','⇄ Compare')}</button>;
}
export function ComparisonTray() {
  const {t:ui}=useInterface();
  const comparison = useContext(Context);
  const location = useLocation();
  if (!comparison?.ids.length || ['/compare','/assistant','/checkout'].includes(location.pathname)) return null;
  return <aside className="comparison-tray" aria-label={ui("comparison.selection","Selected products for comparison")}><span>{ui("comparison.count","{count} of {limit} selected",{count:comparison.ids.length,limit:comparisonLimit})}</span><Link to="/compare">{ui("comparison.products","Compare products")}</Link><button type="button" onClick={comparison.clear}>{ui("common.clear","Clear")}</button></aside>;
}
export function ComparisonPage() {
  const { locale } = useInterface();
  const comparison = useContext(Context)!;
  const { add } = comparison;
  const [params, setParams] = useSearchParams();
  const incoming = params.get('products');
  const [invalidLink, setInvalidLink] = useState(false);
  useEffect(() => {
    if (incoming !== null) { const ids = comparisonIds(incoming); setInvalidLink(!ids.length); add(ids); const next = new URLSearchParams(params); next.delete('products'); setParams(next,{replace:true}); }
  }, [incoming, params, setParams, add]);
  const delivery = useDeliveryKey();
  const results = useQueries({ queries: comparison.ids.map(id => ({ queryKey:['comparison-product',id,delivery,locale], queryFn:() => catalogApi.product(id, locale), retry:false, staleTime:0 })) });
  const products = results.flatMap(result => result.data ? [result.data] : []);
  const ready = results.every(result => !result.isPending && !result.isError);
  const attributes = [...new Set(products.flatMap(product => Object.keys(product.attributes)))].sort();
  const rows = [
    {label:'Price',values:products.map(p => p.product_type === 'simple' ? `${catalogPrice(p).price} ${p.currency}` : 'Choose options for pricing')},
    {label:'Selling unit',values:products.map(p => p.unit || 'Not provided')},
    {label:'Availability',values:products.map(p => p.product_type !== 'simple' ? 'Choose options to check availability' : p.in_stock ? 'In stock' : 'Out of stock')},
    {label:'Description',values:products.map(p => p.description || 'Not provided')},
    ...attributes.map(key => ({label:key.replaceAll('_',' ').replaceAll('-',' '),values:products.map(p => comparisonValue(p.attributes[key]))})),
  ];
  return <main className="comparison-page"><header><div><p className="eyebrow">SIDE BY SIDE</p><h1>Compare products</h1><p>Select two to five products. Facts and prices come from the current catalog.</p></div><Link to="/search">Browse products</Link></header>
    {comparison.ids.length > 0 && <nav className="comparison-selection" aria-label="Comparison selection">{comparison.ids.map((id,index) => <button className="secondary" key={id} onClick={() => comparison.toggle(id)}>Remove {results[index]?.data?.name || `product ${index+1}`}</button>)}<button className="secondary" onClick={comparison.clear}>Clear all</button></nav>}
    {invalidLink && <p role="alert">That comparison link is invalid. Select products from the catalog.</p>}
    {comparison.ids.length < 2 && <p>Select {comparison.ids.length ? 'one more product' : 'at least two products'} to compare.</p>}
    {results.some(result => result.isPending) && <p role="status">Loading current product facts…</p>}
    {results.some(result => result.isError) && <p role="alert">A selected product is unavailable. Remove it or retry. <button className="secondary" onClick={() => results.forEach(result => { if(result.isError) void result.refetch(); })}>Retry</button></p>}
    {ready && products.length >= 2 && <><div className="comparison-table-wrap" role="region" aria-label="Product comparison" tabIndex={0}><table><caption>Current catalog facts. Missing details are marked “Not provided”. Prices in different currencies are not converted.</caption><thead><tr><th scope="col">Detail</th>{products.map(p => <th scope="col" key={p.id}>{p.media_ids[0] && <img src={mediaUrl(p.media_ids[0])} alt="" />}<Link to={`/products/${p.id}`}>{p.name}</Link></th>)}</tr></thead><tbody>{rows.map((row,index) => <tr key={index}><th scope="row">{row.label}</th>{row.values.map((value,index) => <td key={products[index].id}>{value}</td>)}</tr>)}</tbody></table></div><Link className="comparison-assistant" to={`/assistant?compare=${comparison.ids.join(',')}`}>Ask the shopping assistant about these products <span className="direction-icon" aria-hidden="true">→</span></Link></>}
    <p className="comparison-note">Stock can vary by delivery location. Final totals are confirmed at checkout.</p>
  </main>;
}
