import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminCustomerApi, locationAddress } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { fetchGridPage } from './grids';
import { GeographyMap } from './geography-map';
import { customerGeoName, groupLocations, loadGeoDetails } from './geography-logic';

export function CustomerGeography() {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [defaultsOnly, setDefaultsOnly] = useState(true);
  const [selected, setSelected] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['admin-customers', 'geography'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchGridPage('customers', pageParam, signal);
      const profiles = await loadGeoDetails(page.items, customer => adminCustomerApi.profile(customer.id), signal);
      return { profiles, next: page.next_cursor };
    },
    getNextPageParam: last => last.next ?? undefined,
  });
  const profiles = useMemo(() => [...new Map((query.data?.pages.flatMap(page => page.profiles) ?? []).map(profile => [profile.account.id, profile])).values()], [query.data]);
  const groups = [...new Set(profiles.map(profile => profile.customer_group))].sort();
  const entries = useMemo(() => profiles.filter(customer => !group || customer.customer_group === group).flatMap(customer => customer.locations.filter(location => (!defaultsOnly || location.is_default) && `${customerGeoName(customer)} ${customer.account.email ?? ''} ${customer.account.mobile_number ?? ''} ${locationAddress(location)}`.toLowerCase().includes(search.trim().toLowerCase())).map(location => ({ customer, location }))), [profiles, search, group, defaultsOnly]);
  const points = useMemo(() => groupLocations(entries, entry => entry.location), [entries]);
  const markers = useMemo(() => points.map(point => ({ ...point, avatar: customerGeoName(point.entries[0].customer).split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), count: new Set(point.entries.map(entry => entry.customer.account.id)).size, title: [...new Set(point.entries.map(entry => customerGeoName(entry.customer)))].join(', ') })), [points]);
  const mapped = points.flatMap(point => point.entries);
  const chosen = points.find(point => point.key === selected);
  return <main className="order-geo-page">
    <PageHeader title="Customer geography" description="Explore customers by their default delivery address. Switch to all saved addresses for a broader view." actions={<><Link className="button-link secondary" to="/customers/profiles">Customer profiles</Link><button className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Loading...' : 'Refresh'}</button></>} />
    <div className="catalog-toolbar order-geo-filters">
      <label>Search<input type="search" placeholder="Customer, contact or address" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Customer group<select value={group} onChange={event => setGroup(event.target.value)}><option value="">All groups</option>{groups.filter(Boolean).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Addresses<select value={defaultsOnly ? 'default' : 'all'} onChange={event => setDefaultsOnly(event.target.value === 'default')}><option value="default">Default addresses only</option><option value="all">All saved addresses</option></select></label>
      <button className="text-button" onClick={() => { setSearch(''); setGroup(''); setDefaultsOnly(true); setSelected(''); }}>Clear filters</button>
    </div>
    <Notice error>{query.error?.message}</Notice>
    <div className="order-geo-summary" role="status"><span><strong>{new Set(mapped.map(entry => entry.customer.account.id)).size}</strong> mapped customers</span><span><strong>{mapped.length}</strong> saved addresses</span><span><strong>{points.length}</strong> locations</span><span><strong>{entries.length - mapped.length}</strong> addresses without valid coordinates</span></div>
    <p className="order-geo-scope">{profiles.length} customers loaded · {profiles.filter(profile => defaultsOnly ? !profile.locations.some(location => location.is_default) : !profile.locations.length).length} without {defaultsOnly ? 'a default address' : 'saved addresses'}.{query.hasNextPage ? ' Load more customers to expand the map and group list.' : ''} Filters apply to loaded customers.</p>
    {query.isPending ? <p role="status">Loading customer locations...</p> : <div className="order-geo-layout">
      <GeographyMap label="Customer addresses map" points={markers} selected={selected} onSelect={setSelected} />
      <aside className="order-geo-details" aria-label="Customers by location">
        <div className="order-geo-details-heading"><h2>{chosen ? 'Selected location' : 'Customer locations'}</h2>{chosen && <button className="text-button" onClick={() => setSelected('')}>All locations</button>}</div>
        {!points.length && <p>No customer addresses with valid coordinates match this view.</p>}
        {(chosen ? [chosen] : points).map(point => <section key={point.key} className="order-geo-location">
          <button className="order-geo-location-button" aria-pressed={selected === point.key} onClick={() => setSelected(point.key)}><span>{locationAddress(point.entries[0].location)}<small>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)} · {new Set(point.entries.map(entry => entry.customer.account.id)).size} customer(s)</small></span></button>
          {point.entries.map(({ customer, location }) => <article className="order-geo-order" key={`${customer.account.id}-${location.id}`}><div><Link to={`/customers/profiles/${customer.account.id}`}>{customerGeoName(customer)}</Link>{location.is_default && <span className="badge">Default</span>}</div><p>{customer.account.email || customer.account.mobile_number || 'No contact details'}</p><p>{locationAddress(location)}</p><small>{customer.customer_group} · {location.custom_label || location.label}{location.location_method === 'neighborhood' ? ' · Approximate area location' : ''}</small></article>)}
        </section>)}
      </aside>
    </div>}
    {query.hasNextPage && <button className="secondary order-geo-load" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading customers...' : 'Load more customers'}</button>}
  </main>;
}
