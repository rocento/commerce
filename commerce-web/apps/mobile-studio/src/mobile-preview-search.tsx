import { useEffect, useState } from 'react';
import { mobileApi, type MobileCatalog, type MobileCatalogSearch, type MobileCatalogProduct, type MobilePreviewCategory } from '@commerce/api-client';
import { PreviewProductSheet } from './mobile-preview-sheet';
import { catalogError } from './mobile-catalog';
import './mobile-native-search.css';
type Filters = { attributes: Record<string, unknown>; q: string; collection: string; sort: string; inStock: boolean; min: string; max: string };
const defaults = (): Filters => ({ attributes: {}, q: '', collection: '', sort: 'relevance', inStock: false, min: '', max: '' });
export function usePreviewSearch(merchant: string, locale: 'en' | 'ar', enabled: boolean, collection = '') {
  const scope = `${merchant}:${locale}:${collection}`;
  const [form, setForm] = useState({ scope, filters: { ...defaults(), collection } });
  const [query, setQuery] = useState({ scope, filters: { ...defaults(), collection }, offset: 0, retry: 0 });
  const filters = form.scope === scope ? form.filters : { ...defaults(), collection };
  const applied = query.scope === scope ? query : { scope, filters: { ...defaults(), collection }, offset: 0, retry: 0 };
  const baseKey = JSON.stringify([scope, applied.filters, applied.retry]);
  const requestKey = `${baseKey}:${applied.offset}`;
  const [result, setResult] = useState<{ baseKey: string; requestKey: string; data?: MobileCatalog; error?: string }>({ baseKey: '', requestKey: '' });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const f = applied.filters;
    const request: MobileCatalogSearch = { q: f.q.trim(), collection: f.collection || undefined, sort: f.sort, in_stock: f.inStock || undefined, min_price: f.min || undefined, max_price: f.max || undefined, offset: applied.offset, attribute_filters: Object.keys(f.attributes).length ? JSON.stringify(f.attributes) : undefined };
    mobileApi.searchCatalog(merchant, locale, request, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.merchantId !== merchant || data.locale !== locale) throw new Error('Catalog scope mismatch');
      setResult(previous => {
        const products = applied.offset && previous.baseKey === baseKey ? [...(previous.data?.products || []), ...data.products] : data.products;
        return { baseKey, requestKey, data: { ...data, products: [...new Map(products.map(p => [p.id, p])).values()] } };
      });
    }).catch(error => { if (!controller.signal.aborted) setResult(previous => ({ baseKey, requestKey, data: previous.baseKey === baseKey ? previous.data : undefined, error: catalogError(error) })); });
    return () => controller.abort();
  }, [merchant, locale, enabled, requestKey]);
  const current = result.baseKey === baseKey ? result : undefined;
  return {
    filters,
    discard: () => setForm({ scope, filters: { ...applied.filters, attributes: { ...applied.filters.attributes } } }),
    resetDraft: () => setForm({ scope, filters: { ...defaults(), collection } }),
    chooseCategory: (collection: string) => { const next = { ...applied.filters, collection }; setForm({ scope, filters: next }); setQuery({ scope, filters: next, offset: 0, retry: applied.retry + 1 }); },
    data: current?.data, error: current?.error, loading: enabled && current?.requestKey !== requestKey,
    edit: (patch: Partial<Filters>) => setForm({ scope, filters: { ...filters, ...patch } }),
    apply: () => setQuery({ scope, filters, offset: 0, retry: applied.retry + 1 }),
    reset: (selectedCollection = collection) => { const filters = { ...defaults(), collection: selectedCollection }; setForm({ scope, filters }); setQuery({ scope, filters, offset: 0, retry: applied.retry + 1 }); },
    retry: () => setQuery({ ...applied, retry: applied.retry + 1, offset: 0 }),
    more: () => { if (current?.data?.nextOffset != null) setQuery({ ...applied, offset: current.data.nextOffset }); },
  };
}
export function PreviewSearch({ search, categories, locale, open, category, back, platform, reactNative = false }: {
  platform: 'iOS' | 'Android'; reactNative?: boolean;
  category?: MobilePreviewCategory; back?: () => void;
  search: ReturnType<typeof usePreviewSearch>; categories: MobilePreviewCategory[]; locale: 'en' | 'ar';
  open: (product: MobileCatalogProduct) => void; formatPrice: (price: string, currency: string) => string;
}) {
  const ar = locale === 'ar', t = (en: string, arabic: string) => ar ? arabic : en;
  const [filterOpen, setFilterOpen] = useState(false);
  const f = search.filters;
  const low = f.min === '' ? 0 : Number(f.min), high = f.max === '' ? Infinity : Number(f.max);
  const invalidRange = !Number.isFinite(low) || low < 0 || high < low || (f.max !== '' && !Number.isFinite(high));
  return <section className="ms-search-screen ms-native-search" aria-label={t('Product search', 'البحث عن المنتجات')}>
    {category ? <div className="ms-category-selection"><button type="button" className="ms-browse-back" onClick={back}>{t("← Back", "→ رجوع")}</button><h3>{categories.find(c => c.id === f.collection)?.name || category.name}</h3></div> : <h3 className="ms-native-search-title">{t('Search products', 'البحث عن المنتجات')}</h3>}
    <div className="ms-category-chips"><button type="button" className="ms-filter-trigger" onClick={() => { search.discard(); setFilterOpen(true); }}>{t('Filter & sort', 'تصفية وترتيب')}</button>{categories.map(c => <button type="button" key={c.id} aria-pressed={f.collection === c.id} onClick={() => search.chooseCategory(c.id)}>{c.name}</button>)}</div>
    {filterOpen && <PreviewProductSheet platform={platform} locale={locale} title={t('Filter & sort','تصفية وترتيب')} close={() => { search.discard(); setFilterOpen(false); }} footer={<button type="button" className="ms-cart-primary" disabled={invalidRange} onClick={() => { search.apply(); setFilterOpen(false); }}>{t('Show results','عرض النتائج')}</button>}>
    <div className="ms-filter-heading"><span>{t('Refine your results','حدد النتائج المناسبة')}</span><button type="button" onClick={search.resetDraft}>{t('Reset','إعادة تعيين')}</button></div>
    <form noValidate className="ms-search-form" onSubmit={event => { event.preventDefault(); if (!invalidRange) { search.apply(); setFilterOpen(false); } }}>
      {!reactNative && <label className="ms-search-query">{t('Search products', 'البحث عن المنتجات')}<input type="search" maxLength={120} value={f.q} placeholder={t('Search products', 'البحث عن المنتجات')} onChange={e => search.edit({ q: e.target.value })} /></label>}
      {reactNative && <><h3>{t("Category","الفئة")}</h3><div className="ms-category-chips">{[{id:"",name:t("All categories","جميع الفئات")},...categories].map(c=><button type="button" key={c.id} aria-pressed={f.collection===c.id} onClick={()=>search.edit({collection:c.id})}>{c.name}</button>)}</div><h3>{t("Sort by","ترتيب حسب")}</h3><div className="ms-filter-radios" role="radiogroup" aria-label={t("Sort by","ترتيب حسب")}>{["relevance","price_asc","price_desc","name_asc","name_desc"].map((sort,i)=><label key={sort}><input type="radio" name="preview-sort" checked={f.sort===sort} onChange={()=>search.edit({sort})}/>{[t("Relevance","الأكثر صلة"),t("Price: low to high","السعر: الأقل أولاً"),t("Price: high to low","السعر: الأعلى أولاً"),t("Name: A–Z","الاسم: تصاعدياً"),t("Name: Z–A","الاسم: تنازلياً")][i]}</label>)}</div><h3>{t("Price range","نطاق السعر")}</h3></>}
      {!reactNative && <div className="ms-search-filter-grid">{!category && <label>{t('Category', 'الفئة')}<select value={f.collection} onChange={e => search.edit({ collection: e.target.value })}><option value="">{t('All categories', 'جميع الفئات')}</option>{categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>}
      <label>{t('Sort by', 'ترتيب حسب')}<select value={f.sort} onChange={e => search.edit({ sort: e.target.value })}>
        <option value="relevance">{t('Relevance', 'الأكثر صلة')}</option><option value="price_asc">{t('Price: low to high', 'السعر: الأقل أولاً')}</option><option value="price_desc">{t('Price: high to low', 'السعر: الأعلى أولاً')}</option><option value="name_asc">{t('Name: A–Z', 'الاسم: تصاعدياً')}</option><option value="name_desc">{t('Name: Z–A', 'الاسم: تنازلياً')}</option>
        {search.data?.attributes?.filter(a => a.is_visible_on_front && a.metadata?.status !== 'disabled' && a.metadata?.sortable && !['name','price'].includes(a.attribute_code)).flatMap(a => ['asc','desc'].map(order => <option key={`${a.attribute_code}:${order}`} value={`${a.attribute_code}:${order}`}>{a.label}: {order === 'asc' ? t('ascending', 'تصاعدياً') : t('descending', 'تنازلياً')}</option>))}
      </select></label></div>}
      <div className="ms-price-range">
        <label>{t('Min price', 'أقل سعر')}<input type="number" min="0" step="any" placeholder={t('Min price', 'أقل سعر')} value={f.min} onChange={e => search.edit({ min: e.target.value })} /></label>
        <label>{t('Max price', 'أعلى سعر')}<input type="number" min="0" step="any" placeholder={t('Max price', 'أعلى سعر')} value={f.max} onChange={e => search.edit({ max: e.target.value })} /></label>
      </div><label className="ms-search-stock"><input type="checkbox" checked={f.inStock} role={platform === 'iOS' ? 'switch' : 'checkbox'} onChange={e => search.edit({ inStock: e.target.checked })} />{t('In stock only', 'المتوفر فقط')}</label>
      {search.data?.attributes?.filter(a => a.is_filterable && a.is_visible_on_front && a.metadata?.status !== 'disabled').sort((a,b) => (a.metadata?.display_order || 0) - (b.metadata?.display_order || 0)).map(a => {
        const raw = f.attributes[a.attribute_code], selected = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
        const counts = search.data?.facets?.[a.attribute_code];
        const options = a.input_type === 'boolean' ? [{ value: 'true', label: t('Yes', 'نعم') }, { value: 'false', label: t('No', 'لا') }] : a.options.length ? a.options : Object.keys(counts || {}).map(value => ({ value, label: value }));
        const choices = [...options, ...selected.filter(v => !options.some(o => o.value === v)).map(value => ({ value, label: value }))].filter(o => !a.metadata?.facetable || !search.data?.facets || (counts?.[o.value] || 0) > 0 || selected.includes(o.value));
        const multiple = choices.length > 0 || ['boolean', 'select', 'multiselect', 'single_select', 'multi_select'].includes(a.input_type);
        const update = (values: string[]) => {
          const attributes = { ...f.attributes };
          if (!values.length) delete attributes[a.attribute_code];
          else { const typed = values.map(v => a.input_type === 'boolean' ? v === 'true' : ['integer','decimal','measurement','price'].includes(a.input_type) ? Number(v) : v); attributes[a.attribute_code] = multiple ? typed : typed[0]; }
          search.edit({ attributes });
        };
        const AttributeGroup = platform === 'iOS' ? 'details' : 'div';
        return <AttributeGroup className="ms-native-attribute" key={a.attribute_code}>{platform === 'iOS' ? <summary>{a.label}</summary> : <p>{a.label}</p>}{multiple ? choices.map(o => <label className="ms-search-stock" key={o.value}><input type="checkbox" role={platform === 'iOS' ? 'switch' : 'checkbox'} checked={selected.includes(o.value)} onChange={e => update(e.target.checked ? [...selected, o.value] : selected.filter(v => v !== o.value))} />{o.label}</label>) : <label>{a.label}<input value={selected[0] || ''} type={['integer','decimal','measurement','price'].includes(a.input_type) ? 'number' : a.input_type === 'date' ? 'date' : 'text'} step="any" onChange={e => update(e.target.value ? [e.target.value] : [])} /></label>}</AttributeGroup>;
      })}
      {invalidRange && <p role="alert">{t('Enter a valid price range.', 'أدخل نطاق أسعار صالحاً.')}</p>}
    </form></PreviewProductSheet>}
    {search.loading && <p className="ms-search-feedback" role="status">{t('Loading products', 'جارٍ تحميل المنتجات')}</p>}
    {search.error && <div className="ms-search-feedback" role="alert"><p>{ar ? 'تعذر تحميل المنتجات' : search.error}</p><button type="button" onClick={search.retry}>{t('Retry search', 'إعادة محاولة البحث')}</button></div>}
    {search.data && <>
      <p className="ms-search-count" role="status">{search.data.total ?? search.data.products.length} {t('products', 'منتج')}</p>
      {!search.loading && !search.error && !search.data.products.length && <p className="ms-search-feedback">{t('No products match. Try resetting the filters.', 'لا توجد منتجات مطابقة. جرّب إعادة تعيين الفلاتر.')}</p>}
      <div className="ms-products">{search.data.products.map(product => <button type="button" className="ms-product" key={product.id} aria-label={`${t('View', 'عرض')} ${product.name}`} onClick={() => open(product)}>
        <div className="ms-product-art">{product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span>{t('No image', 'لا توجد صورة')}</span>}</div>
        <b>{product.name}</b><small>{product.price} {product.currency}</small>
      </button>)}</div>
      {search.data.nextOffset != null && <button type="button" className="ms-search-more" disabled={search.loading} onClick={search.more}>{t('Load more products', 'عرض المزيد من المنتجات')}</button>}
    </>}
  </section>;
}
