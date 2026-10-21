import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminOrderApi, locationAddress } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { GeographyMap } from './geography-map';
import { catalogSales, groupLocations, salesTotals } from './geography-logic';

export function CatalogGeography() {
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['admin-orders', 'catalog-geography'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const details = await adminOrderApi.sales(pageParam);
      return { details, count: details.length };
    },
    getNextPageParam: (last, pages) => last.count === 50 ? pages.reduce((count, page) => count + page.count, 0) : undefined,
  });
  const details = useMemo(() => [...new Map((query.data?.pages.flatMap(page => page.details) ?? []).map(detail => [detail.order.id, detail])).values()], [query.data]);
  const products = useMemo(() => [...new Map(details.flatMap(detail => detail.items).map(item => [item.product_id, item])).values()].sort((a, b) => a.name.localeCompare(b.name)), [details]);
  const sales = useMemo(() => catalogSales(details, { search, product, from, to }), [details, search, product, from, to]);
  const points = useMemo(() => groupLocations(sales, sale => sale.order.location), [sales]);
  const markers = useMemo(() => points.map(point => ({ ...point, avatar: 'P', count: new Set(point.entries.map(sale => sale.item.product_id)).size, title: `${point.entries.map(sale => sale.item.name).filter((name, index, names) => names.indexOf(name) === index).join(', ')} · ${salesTotals(point.entries)}` })), [points]);
  const mapped = points.flatMap(point => point.entries);
  const mappedOrders = new Set(mapped.map(sale => sale.order.id));
  const chosen = points.find(point => point.key === selected);
  return <main className="order-geo-page">
    <PageHeader title="Catalog geography" description="See where your products sell, pinned to order delivery locations." actions={<><Link className="button-link secondary" to="/catalog/products">Products</Link><button className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Loading...' : 'Refresh'}</button></>} />
    <div className="catalog-toolbar order-geo-filters">
      <label>Search<input type="search" placeholder="Product, SKU or address" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Product<select value={product} onChange={event => setProduct(event.target.value)}><option value="">All products</option>{products.map(item => <option key={item.product_id} value={item.product_id}>{item.name} · {item.sku}</option>)}</select></label>
      <label>From (UTC)<input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></label>
      <label>To (UTC)<input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>
      <button className="text-button" onClick={() => { setSearch(''); setProduct(''); setFrom(''); setTo(''); setSelected(''); }}>Clear filters</button>
    </div>
    <Notice error>{query.error?.message}</Notice>
    <div className="order-geo-summary" role="status"><span><strong>{new Set(mapped.map(sale => sale.item.product_id)).size}</strong> products</span><span><strong>{new Set(mapped.map(sale => sale.order.id)).size}</strong> mapped orders</span><span><strong>{points.length}</strong> locations</span><span><strong>{salesTotals(mapped)}</strong> product sales</span><span><strong>{new Set(sales.filter(sale => !mappedOrders.has(sale.order.id)).map(sale => sale.order.id)).size}</strong> orders without valid coordinates</span></div>
    <p className="order-geo-scope">{details.length} orders loaded, newest first{query.hasNextPage ? '. Load older orders to expand the map and product list.' : '.'} Sales use order line totals after discounts, excluding cancelled and failed deliveries. Refunds are not deducted. Currencies are shown separately.</p>
    {query.isPending ? <p role="status">Loading product sales locations...</p> : <div className="order-geo-layout">
      <GeographyMap label="Product sales map" points={markers} selected={selected} onSelect={setSelected} />
      <aside className="order-geo-details" aria-label="Products by location">
        <div className="order-geo-details-heading"><h2>{chosen ? 'Selected location' : 'Sales locations'}</h2>{chosen && <button className="text-button" onClick={() => setSelected('')}>All locations</button>}</div>
        {!points.length && <p>No product sales with valid coordinates match this view.</p>}
        {(chosen ? [chosen] : points).map(point => <section key={point.key} className="order-geo-location">
          <button className="order-geo-location-button" aria-pressed={selected === point.key} onClick={() => setSelected(point.key)}><span className="order-geo-list-avatar" aria-hidden="true">P</span><span>{locationAddress(point.entries[0].order.location)}<small>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)} · {salesTotals(point.entries)}</small></span></button>
          {point.entries.map((sale, index) => <article className="order-geo-order" key={`${sale.order.id}-${index}`}><div><strong>{sale.item.name}</strong><Link to={`/sales/orders/${sale.order.id}`}>#{sale.order.number}</Link></div><p>{sale.item.sku} · {sale.item.quantity} {sale.item.unit}</p><small>{salesTotals([sale])} · {sale.order.status.replaceAll('_', ' ')}{sale.order.location.location_method === 'neighborhood' ? ' · Approximate area location' : ''}</small></article>)}
        </section>)}
      </aside>
    </div>}
    {query.hasNextPage && <button className="secondary order-geo-load" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading older orders...' : 'Load older orders'}</button>}
  </main>;
}
