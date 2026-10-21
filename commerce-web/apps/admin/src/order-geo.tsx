import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminOrderApi, locationAddress, type AdminIdentity } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { groupOrderLocations, orderAvatar, orderCustomerLabel } from './order-geo-logic';
import { GeographyMap } from './geography-map';
import './order-geo.css';

const statuses = ['placed', 'confirmed', 'fulfilling', 'shipped', 'delivered', 'cash_collected', 'cancelled', 'delivery_failed'];
const label = (value: string) => value.replaceAll('_', ' ');


export function OrderGeography({ who }: { who: AdminIdentity }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState('');
  const canViewCustomer = who.permissions.includes('*') || who.permissions.includes('customers.read');
  const query = useInfiniteQuery({
    queryKey: ['admin-orders', 'geography'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => adminOrderApi.list(pageParam),
    getNextPageParam: (last, pages) => last.length === 50 ? pages.reduce((count, page) => count + page.length, 0) : undefined,
  });
  const orders = useMemo(() => [...new Map((query.data?.pages.flat() ?? []).map(order => [order.id, order])).values()], [query.data]);
  const filtered = useMemo(() => orders.filter(order => {
    const day = order.created_at.slice(0, 10);
    return (!status || order.status === status) && (!from || day >= from) && (!to || day <= to) && `${order.number} ${orderCustomerLabel(order)} ${locationAddress(order.location)}`.toLowerCase().includes(search.trim().toLowerCase());
  }), [orders, search, status, from, to]);
  const points = useMemo(() => groupOrderLocations(filtered), [filtered]);
  const markers = useMemo(() => points.map(point => ({ ...point, avatar: orderAvatar(point.orders[0]), title: `${orderCustomerLabel(point.orders[0])} - ${point.orders.length} order(s)`, count: point.orders.length })), [points]);
  const mapped = points.flatMap(point => point.orders);
  const chosen = points.find(point => point.key === selected);
  return <main className="order-geo-page">
    <PageHeader title="Order geography" description="Delivery locations from placed orders" actions={<><Link className="button-link secondary" to="/sales/orders">Orders</Link><button className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Loading...' : 'Refresh'}</button></>} />
    <div className="catalog-toolbar order-geo-filters">
      <label>Search<input type="search" value={search} placeholder="Order, customer or address" onChange={event => setSearch(event.target.value)} /></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label>From (UTC)<input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></label>
      <label>To (UTC)<input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>
      <button className="text-button" onClick={() => { setSearch(''); setStatus(''); setFrom(''); setTo(''); setSelected(''); }}>Clear filters</button>
    </div>
    <Notice error>{query.error?.message}</Notice>
    <div className="order-geo-summary" role="status"><span><strong>{mapped.length}</strong> mapped orders</span><span><strong>{new Set(mapped.map(order => order.customer_id)).size}</strong> customers</span><span><strong>{points.length}</strong> locations</span><span><strong>{filtered.length - mapped.length}</strong> without valid coordinates</span></div>
    <p className="order-geo-scope">{orders.length} orders loaded, newest first{query.hasNextPage ? '. Load older orders to expand the overview.' : '.'}</p>
    {query.isPending ? <p role="status">Loading order locations...</p> : <div className="order-geo-layout">
      <GeographyMap label="Order delivery map" points={markers} selected={selected} onSelect={setSelected} />
      <aside className="order-geo-details" aria-label="Orders by location">
        <div className="order-geo-details-heading"><h2>{chosen ? 'Selected location' : 'Delivery locations'}</h2>{chosen && <button className="text-button" onClick={() => setSelected('')}>All locations</button>}</div>
        {!points.length && <p>No orders with valid coordinates match this view.</p>}
        {(chosen ? [chosen] : points).map(point => <section key={point.key} className="order-geo-location">
          <button className="order-geo-location-button" onClick={() => setSelected(point.key)} aria-pressed={selected === point.key}><span className="order-geo-list-avatar" aria-hidden="true">{orderAvatar(point.orders[0])}</span><span>{locationAddress(point.orders[0].location)}<small>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)} · {point.orders.length} order(s)</small></span></button>
          {point.orders.map(order => <article key={order.id} className="order-geo-order"><div><Link to={`/sales/orders/${order.id}`}>#{order.number}</Link><span className="badge">{label(order.status)}</span></div><p>{canViewCustomer ? <Link to={`/customers/profiles/${order.customer_id}`}>{orderCustomerLabel(order)}</Link> : orderCustomerLabel(order)}</p><small>{new Date(order.created_at).toLocaleDateString()} · {order.total} {order.currency}{order.location.location_method === 'neighborhood' ? ' · Approximate area location' : ''}</small></article>)}
        </section>)}
      </aside>
    </div>}
    {query.hasNextPage && <button className="secondary order-geo-load" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading older orders...' : 'Load older orders'}</button>}
  </main>;
}
