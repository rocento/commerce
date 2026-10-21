import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { adminCustomerApi } from '@commerce/api-client';
import './customer-journey.css';

type IconName = 'visit' | 'categories' | 'search' | 'products' | 'cart' | 'checkout' | 'purchase' | 'arrow' | 'clock' | 'desktop' | 'download' | 'close';
function JourneyIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    visit: <><rect x="3" y="4" width="18" height="15" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01m2 6 3 8 1.5-3.5L20 16z"/></>,
    categories: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    products: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/></>,
    cart: <><path d="M2 3h3l3 12h11l3-9H6M9 18h10"/><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/></>,
    checkout: <><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h4M14 15h4"/></>,
    purchase: <><path d="M5 7h14l2 14H3L5 7Z M8 8V6a4 4 0 0 1 8 0v2M8 14l3 3 5-5"/></>,
    arrow: <path d="M4 12h16m-5-5 5 5-5 5"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    desktop: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

type Journey = Awaited<ReturnType<typeof adminCustomerApi.journey>>;
type Activity = Journey['events'][number];
type Range = { from: string; to: string };
const presentation: Record<Activity['kind'], { title: string; icon: IconName; color: string; tint: string }> = {
  visit: { title: 'Store visited', icon: 'visit', color: '#4577bd', tint: '#edf3fc' },
  page_view: { title: 'Page viewed', icon: 'visit', color: '#4577bd', tint: '#edf3fc' },
  category_view: { title: 'Category explored', icon: 'categories', color: '#8761b5', tint: '#f4effa' },
  search: { title: 'Products searched', icon: 'search', color: '#966b2a', tint: '#fff6e5' },
  product_view: { title: 'Product viewed', icon: 'products', color: '#b7664e', tint: '#fff0ea' },
  'cart.item_added': { title: 'Added to cart', icon: 'cart', color: '#327e8c', tint: '#eaf6f8' },
  'cart.item_removed': { title: 'Removed from cart', icon: 'cart', color: '#77726b', tint: '#f4f2ef' },
  'shopping.proposal_created': { title: 'Basket proposed', icon: 'products', color: '#8761b5', tint: '#f4effa' },
  'shopping.cart_applied': { title: 'Basket applied to cart', icon: 'cart', color: '#327e8c', tint: '#eaf6f8' },
  checkout: { title: 'Checkout quoted', icon: 'checkout', color: '#616fab', tint: '#eff0fa' },
  purchase: { title: 'Order placed', icon: 'purchase', color: '#3d8056', tint: '#edf7ef' },
  order_status: { title: 'Order status changed', icon: 'purchase', color: '#3d8056', tint: '#edf7ef' },
};
const readable = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
function initialRange(): Range {
  const today = new Date();
  const from = new Date(today); from.setUTCDate(today.getUTCDate() - 29);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}
function invalidRange(range: Range) {
  const span = (Date.parse(range.to) - Date.parse(range.from)) / 86400000;
  return !Number.isFinite(span) || span < 0 || span > 89;
}
function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}
function details(event: Activity): string {
  const d = event.details;
  if (event.kind === 'search') return `“${d.query || ''}”${d.result_count !== undefined ? ` · ${d.result_count} results` : ''}`;
  if (event.kind === 'purchase') return `Order #${d.order_number}${d.amount && d.currency ? ` · ${d.amount} ${d.currency}` : ''}${d.item_count !== undefined ? ` · ${d.item_count} items` : ''}`;
  if (event.kind === 'order_status') return `Order #${d.order_number} · ${readable(d.status || '')}`;
  if (event.kind === 'checkout') return `${d.amount && d.currency ? `${d.amount} ${d.currency} quoted` : 'Checkout quote prepared'} · Purchase not yet confirmed`;
  if (event.kind === 'shopping.proposal_created') return `${readable(d.mode || 'Shopping')} · Proposal only; cart unchanged`;
  if (event.kind === 'shopping.cart_applied') return `${readable(d.mode || 'Shopping')} · Approved cart update saved`;
  return [d.product_name || d.category_name || d.path || d.product_id || 'Recorded cart change', d.quantity !== undefined ? `Quantity ${d.quantity}` : ''].filter(Boolean).join(' · ');
}
function CustomerActivity({ id, canManageNotifications }: { id: string; canManageNotifications: boolean }) {
  const [range, setRange] = useState(initialRange);
  const [draft, setDraft] = useState(range);
  const [showTimes, setShowTimes] = useState(true);
  const [selected, setSelected] = useState<Activity | null>(null);
  const [exported, setExported] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const query = useInfiniteQuery({
    queryKey: ['admin-customer-journey', id, range.from, range.to],
    initialPageParam: undefined as Journey['next_cursor'] | undefined,
    queryFn: ({ pageParam, signal }) => adminCustomerApi.journey(id, { ...range, ...(pageParam || {}), limit: 50 }, signal),
    getNextPageParam: page => page.next_cursor ?? undefined,
    retry: false,
  });
  const data = query.data?.pages[0];
  const events = [...new Map(query.data?.pages.flatMap(page => page.events).map(event => [event.id, event]) || []).values()]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
  useEffect(() => { const previous = document.title; document.title = `${data?.customer.name || 'Customer'} journey · Rocento`; return () => { document.title = previous; }; }, [data?.customer.name]);
  function exportJourney() {
    if (!data) return;
    const body = { customer: data.customer, from: data.from, to: data.to, timezone: 'UTC', includes_orders: data.includes_orders, older_events_available: !!query.hasNextPage, events };
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `customer-journey-${id}-${range.from}-${range.to}-displayed.json`; link.click(); URL.revokeObjectURL(url); setExported(true);
  }
  return <div className="cj-page"><main className="cj-main">
    <div className="cj-breadcrumb"><Link to="/customers/profiles">Customers</Link><span>/</span><Link to={`/customers/profiles/${id}`}>{data?.customer.name || 'Customer profile'}</Link><span>/</span><strong>Shopping journey</strong></div>
    <div className="cj-title-row"><div><div className="cj-eyebrow">RECORDED CUSTOMER ACTIVITY</div><h1>Shopping journey</h1><p>Visits, shopping decisions and saved commerce activity for this customer.</p></div><button className="cj-export" disabled={!events.length || query.isFetching} onClick={exportJourney}><JourneyIcon name="download" size={16}/>Export displayed events</button></div>
    {data && <section className="cj-session" aria-label="Selected customer"><div className="cj-customer"><span className="cj-avatar" aria-hidden="true">{data.customer.name.slice(0, 2).toUpperCase()}</span><div><strong>{data.customer.name}</strong><span>{data.customer.email || data.customer.id}</span></div></div>{canManageNotifications && <Link to={`/marketing/notifications?customer_id=${encodeURIComponent(id)}`}>Create journey notification →</Link>}<Link to={`/customers/profiles/${id}`}>View customer profile →</Link></section>}
    <form className="cj-filters" onSubmit={event => { event.preventDefault(); if (!invalidRange(draft)) { setRange({ ...draft }); setExported(false); } }}>
      <label>From (UTC)<input type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })}/></label>
      <label>To (UTC)<input type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })}/></label>
      <button type="submit" disabled={invalidRange(draft) || query.isFetching}>Apply dates</button>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh activity</button>
      <span>Up to 90 days per view</span>
    </form>
    {invalidRange(draft) && <p role="alert" className="cj-error">Choose a start and end date no more than 90 days apart.</p>}
    <p className="cj-coverage">Cart, checkout and order events come from saved commerce records. Browsing is recorded after sign-in; older anonymous visits are not linked to this customer.</p>
    {data && !data.includes_orders && <p className="cj-coverage">Checkout and order activity is hidden because your role does not have Orders read access.</p>}
    {query.isPending && <p role="status" className="cj-empty">Loading this customer’s activity…</p>}
    {query.isError && <div role="alert" className="cj-error"><p>{query.error.message}</p><button className="secondary" onClick={() => void query.refetch()}>Retry activity</button></div>}
    {data && <section className="cj-journey" aria-labelledby="cj-journey-heading">
      <div className="cj-journey-heading"><div><h2 id="cj-journey-heading">Recorded events</h2><span className="cj-event-count">{events.length} shown</span></div><label className="cj-toggle"><input type="checkbox" checked={showTimes} onChange={event => setShowTimes(event.target.checked)}/>Timestamps</label></div>
      {events.length === 0 ? <div className="cj-empty"><JourneyIcon name="clock" size={30}/><h3>No activity recorded in this range</h3><p>Try another date range. Only events linked to this customer appear here.</p></div> : <>
        {query.hasNextPage && <div className="cj-load"><button className="secondary" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load older events'}</button><span>The most recent activity is shown first. Loaded events run chronologically below.</span></div>}
        <ol className="cj-events">{events.map((event, index) => { const view = presentation[event.kind]; return <li className="cj-event" key={event.id} style={{ '--event-color': view.color, '--event-tint': view.tint } as CSSProperties}>
          <article className="cj-card">
            <div className="cj-card-lead">
              <span className="cj-event-icon"><JourneyIcon name={view.icon} size={21}/></span>
              <div className="cj-card-meta">
                <span className={`cj-source cj-source-${event.source}`}>{event.source === 'commerce' ? 'Commerce record' : 'Storefront activity'}</span>
                <span className="cj-step">{String(index + 1).padStart(2, '0')}</span>
              </div>
            </div>
            <div className="cj-card-top"><h3>{view.title}</h3></div>
            <p className="cj-card-detail">{details(event)}</p>
            <div className="cj-card-footer">{showTimes && <time dateTime={event.occurred_at}>{timestamp(event.occurred_at)} UTC</time>}<div>{event.details.order_id && <Link to={`/sales/orders/${event.details.order_id}`}>View order</Link>}<button className="text-button" onClick={() => { setSelected(event); dialog.current?.showModal(); }}>Event details <JourneyIcon name="arrow" size={14}/></button></div></div>
          </article>
          {index < events.length - 1 && <span className="cj-connector" aria-hidden="true">
            <span className="cj-connector-forward"/>
            <span className="cj-connector-turn"><svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M100 0V20H0V40" fill="none" vectorEffect="non-scaling-stroke"/></svg></span>
          </span>}
        </li>; })}</ol>
      </>}
      <div className="cj-journey-footer"><span>{data.from} — {data.to} · UTC</span><span>{events.filter(event => event.kind === 'purchase').length} order placement events shown</span></div>
    </section>}
    <p className="cj-page-footer">Recorded history can span multiple visits. An order placement is not proof that payment has been collected.</p>
    <span className="cj-sr-only" role="status">{exported ? 'Displayed customer activity exported as JSON.' : ''}</span>
  </main>
    <dialog ref={dialog} className="cj-dialog" onClose={() => setSelected(null)} onClick={event => { if (event.target === dialog.current) dialog.current.close(); }} aria-labelledby="cj-dialog-title">
      <button className="cj-dialog-close" aria-label="Close event details" onClick={() => dialog.current?.close()}><JourneyIcon name="close"/></button>
      {selected && <><span className="cj-eyebrow">{selected.source === 'commerce' ? 'SAVED COMMERCE RECORD' : 'BROWSER-REPORTED ACTIVITY'}</span><h2 id="cj-dialog-title">{presentation[selected.kind].title}</h2><time dateTime={selected.occurred_at}>{timestamp(selected.occurred_at)} UTC</time><p>{details(selected)}</p><dl className="cj-detail-list"><div><dt>Customer ID</dt><dd>{id}</dd></div><div><dt>Event ID</dt><dd>{selected.id}</dd></div>{selected.session_id && <div><dt>Browser session</dt><dd>{selected.session_id}</dd></div>}{Object.entries(selected.details).map(([key, value]) => <div key={key}><dt>{readable(key)}</dt><dd>{key === 'payment_method' && value === 'cod' ? 'Cash on delivery' : String(value)}</dd></div>)}</dl></>}
    </dialog>
  </div>;
}
export function CustomerJourney({ canManageNotifications = false }: { canManageNotifications?: boolean }) {
  const { id } = useParams();
  if (!id) return <div className="cj-page"><main className="cj-main"><div className="cj-title-row"><div><div className="cj-eyebrow">CUSTOMER ACTIVITY</div><h1>Shopping journey</h1><p>Open a customer profile and select See journey to view their recorded activity.</p></div></div><Link className="primary-link" to="/customers/profiles">Choose a customer →</Link></main></div>;
  return <CustomerActivity key={id} id={id} canManageNotifications={canManageNotifications}/>;
}
