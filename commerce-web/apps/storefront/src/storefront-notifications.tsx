import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, customerApi, deliveryKey, safeNotificationPath, storefrontNotificationApi, type StorefrontNotification } from '@commerce/api-client';
import { useInterface } from './interface-locale';
import './storefront-notifications.css';

type Cursor = { before: string; before_id: string };
type Inbox = { items: StorefrontNotification[]; unread_count: number; snapshot_at: string; next_cursor: Cursor | null; audience: 'guest' | 'customer' };
const activeNotification = (item: StorefrontNotification) => !item.expires_at || Date.parse(item.expires_at) > Date.now();

function Bell({ small = false, header = false }: { small?: boolean; header?: boolean }) {
  return <svg className={header ? 'header-icon' : small ? 'sn-small-icon' : 'sn-icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 6-3 7-3 9h18c0-2-3-3-3-9M10 21h4M12 2V1"/></svg>;
}

/** Keying the instance removes old personalized content before another viewer renders. */
export function StorefrontNotificationBell({ customerId, ready }: { customerId?: string; ready: boolean }) {
  const [location, setLocation] = useState(deliveryKey);
  useEffect(() => {
    const changed = () => setLocation(deliveryKey());
    window.addEventListener('commerce-delivery', changed);
    changed();
    return () => window.removeEventListener('commerce-delivery', changed);
  }, []);
  return <NotificationInbox key={`${customerId || 'guest'}:${ready}:${location}`} customerId={customerId} ready={ready}/>;
}

/** Public HTML stays anonymous; restore the session only after hydration. */
export function PublicNotificationBell() {
  const { t } = useInterface();
  const [session, setSession] = useState<{ ready: boolean; customerId?: string; error: boolean }>({ ready: false, error: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void customerApi.restore().then(customer => { if (current) setSession({ ready: true, customerId: customer.id, error: false }); }).catch(value => {
      if (current) setSession(value instanceof ApiError && value.status === 401 ? { ready: true, error: false } : { ready: false, error: true });
    });
    return () => { current = false; };
  }, [retry]);
  if (session.error) return <div className="sn-root"><button className="header-link icon-control sn-bell" title={t('notifications.session_error', 'Notifications are unavailable. Retry your session.')} aria-label={t('notifications.retry_session', 'Retry notifications')} onClick={() => { setSession({ ready: false, error: false }); setRetry(value => value + 1); }}><Bell header/><span className="sn-badge" aria-hidden="true">!</span></button></div>;
  return <StorefrontNotificationBell ready={session.ready} customerId={session.customerId}/>;
}

function NotificationInbox({ customerId, ready }: { customerId?: string; ready: boolean }) {
  const { t, locale, direction } = useInterface();
  const panelId = useId(), route = useLocation();
  const [offer, setOffer] = useState<StorefrontNotification | null>(null);
  const productReference = route.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?products\/([^/]+)\/?$/)?.[1];
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<Inbox | null>(null), [loading, setLoading] = useState(false), [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(''), [mutationError, setMutationError] = useState(''), [busy, setBusy] = useState<string | null>(null), [announcement, setAnnouncement] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), bell = useRef<HTMLButtonElement>(null);
  const active = useRef(true), request = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), inFlight = useRef(false);
  const visitSubmitted = useRef<string | null>(null), seenItems = useRef<Map<string, string> | null>(null), deliveryPolls = useRef<number[]>([]);
  const inboxRef = useRef(inbox), generation = useRef(0);
  const translate = useRef(t); translate.current = t;
  inboxRef.current = inbox;
  const refresh = useCallback(async (older = false) => {
    if (!ready) return;
    const cursor = older ? inboxRef.current?.next_cursor : null;
    if (older && !cursor) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const version = ++generation.current;
    if (older) setLoadingOlder(true); else { setLoading(true); setLoadingOlder(false); }
    setError('');
    try {
      let result = await storefrontNotificationApi.list({ filter: 'all', limit: 20, ...(cursor ?? {}) }, controller.signal);
      if (!active.current || controller.signal.aborted || version !== generation.current) return;
      // Refuse an audience mismatch instead of displaying a response from an old session.
      if (result.audience !== (customerId ? 'customer' : 'guest')) { setInbox(null); throw new Error('Notification audience changed.'); }
      // List first: anonymous visitors need the server-minted inbox cookie before
      // triggering an offer. Personal delivery never enters cached product HTML.
      if (!older && !seenItems.current) seenItems.current = new Map(result.items.map(item => [item.id, item.published_at]));
      if (!older && productReference && visitSubmitted.current !== productReference && document.visibilityState === 'visible') {
        try {
          const delivery = await storefrontNotificationApi.productView(decodeURIComponent(productReference), controller.signal);
          visitSubmitted.current = productReference;
          if (delivery.queued) {
            // Bounded follow-up reads; matching runs in the separate worker.
            // Normal 45-second polling handles a longer backlog without blocking shopping.
            deliveryPolls.current.forEach(window.clearTimeout);
            deliveryPolls.current = [1000, 3000, 8000].map(delay => window.setTimeout(() => {
              if (active.current && document.visibilityState === 'visible' && !inFlight.current) void refresh();
            }, delay));
          }
          if (delivery.delivered && active.current && !controller.signal.aborted && version === generation.current) {
            const updated = await storefrontNotificationApi.list({ filter: 'all', limit: 20 }, controller.signal);
            if (updated.audience !== (customerId ? 'customer' : 'guest')) throw new Error('Notification audience changed.');
            result = updated;
            if (active.current && !controller.signal.aborted && version === generation.current) {
              setOffer(result.items.find(item => delivery.notification_ids.includes(item.id) && activeNotification(item)) ?? null);
            }
          }
        } catch {
          // A product visit must not break the inbox or product page. A later
          // refresh retries safely; server grants are unique per campaign/viewer.
        }
      }
      if (!active.current || controller.signal.aborted || version !== generation.current) return;
      if (!older && seenItems.current) {
        // Repeated campaigns retain their publication ID but receive a new delivery
        // timestamp. Read/unread changes and repeated polls are not new deliveries.
        const incoming = result.items.find(item => item.kind === 'journey' && !item.read_at && activeNotification(item) && seenItems.current!.get(item.id) !== item.published_at);
        if (incoming) setOffer(incoming);
        result.items.forEach(item => seenItems.current!.set(item.id, item.published_at));
      }
      setInbox(current => ({ ...result, items: older && current ? [...new Map([...current.items, ...result.items].filter(activeNotification).map(item => [item.id, item])).values()] : result.items.filter(activeNotification), snapshot_at: older && current ? current.snapshot_at : result.snapshot_at }));
    } catch (value) {
      if (!active.current || controller.signal.aborted || version !== generation.current) return;
      if (value instanceof ApiError && (value.status === 401 || value.status === 403)) setInbox(null);
      setError(translate.current('notifications.load_error', 'We couldn’t load your notifications. Please try again.'));
    } finally {
      if (active.current && !controller.signal.aborted && version === generation.current) { setLoading(false); setLoadingOlder(false); }
    }
  }, [ready, customerId, productReference]);
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    return () => { active.current = false; deliveryPolls.current.forEach(window.clearTimeout); request.current?.abort(); mutation.current?.abort(); element?.close(); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const tick = () => { if (document.visibilityState === 'visible' && !inFlight.current) void refresh(); };
    const interval = window.setInterval(tick, 45000);
    document.addEventListener('visibilitychange', tick);
    return () => { deliveryPolls.current.forEach(window.clearTimeout); deliveryPolls.current = []; window.clearInterval(interval); document.removeEventListener('visibilitychange', tick); request.current?.abort(); };
  }, [ready, refresh]);
  useEffect(() => {
    if (!ready) return;
    setInbox(null);
    void refresh();
  }, [ready, refresh]);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { setOpen(false); }, [route.pathname, route.search]);

  function close() { setOpen(false); bell.current?.focus(); }
  function openInbox() { if (!ready) return; setOffer(null); setOpen(true); setMutationError(''); setAnnouncement(''); void refresh(); }
  async function markRead(item: StorefrontNotification) {
    if (item.read_at || inFlight.current) return;
    request.current?.abort(); generation.current++; setLoading(false); setLoadingOlder(false);
    inFlight.current = true; setBusy(item.id); setMutationError('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const result = await storefrontNotificationApi.read(item.id, { read: true }, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setInbox(current => current ? { ...current, unread_count: result.unread_count, items: current.items.map(value => value.id === item.id ? { ...value, read_at: result.read_at } : value) } : current);
      setAnnouncement(t('notifications.marked_read', 'Notification marked as read.'));
      void refresh();
    } catch (value) {
      if (!active.current || controller.signal.aborted) return;
      if (value instanceof ApiError && (value.status === 401 || value.status === 403)) setInbox(null);
      if (value instanceof ApiError && (value.status === 404 || value.status === 410)) {
        setInbox(current => current ? { ...current, items: current.items.filter(notification => notification.id !== item.id) } : current);
        setMutationError(t('notifications.unavailable', 'This notification has expired or is no longer available.')); void refresh();
      } else setMutationError(t('notifications.update_error', 'We couldn’t update this notification. Please try again.'));
    } finally { if (active.current && !controller.signal.aborted) { inFlight.current = false; setBusy(null); } }
  }
  async function markAllRead() {
    if (!inbox?.snapshot_at || !inbox.unread_count || inFlight.current) return;
    request.current?.abort(); generation.current++; setLoading(false); setLoadingOlder(false);
    inFlight.current = true; setBusy('all'); setMutationError('');
    const through = inbox.snapshot_at;
    const controller = new AbortController(); mutation.current = controller;
    try {
      const result = await storefrontNotificationApi.readAll({ through }, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setInbox(current => current ? { ...current, unread_count: result.unread_count, items: current.items.map(item => Date.parse(item.published_at) <= Date.parse(through) ? { ...item, read_at: item.read_at || through } : item) } : current);
      setAnnouncement(t('notifications.all_marked_read', 'Notifications in this view have been marked as read.'));
      void refresh();
    } catch (value) {
      if (active.current && !controller.signal.aborted) {
        if (value instanceof ApiError && (value.status === 401 || value.status === 403)) setInbox(null);
        setMutationError(t('notifications.update_error', 'We couldn’t update this notification. Please try again.'));
      }
    } finally { if (active.current && !controller.signal.aborted) { inFlight.current = false; setBusy(null); } }
  }
  const unread = inbox?.unread_count ?? 0;
  const items = inbox?.items.filter(activeNotification) ?? [];
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return <div className="sn-root" dir={direction}>
    {offer && activeNotification(offer) && <aside className="sn-offer" role="status" aria-live="polite"><div><strong dir="auto">{offer.title}</strong><p dir="auto">{offer.body}</p><button className="sn-offer-action" onClick={openInbox}>{t('notifications.view_offer', 'View offer')}</button></div><button className="sn-offer-close" aria-label={t('notifications.dismiss_offer', 'Dismiss offer')} onClick={() => setOffer(null)}>×</button></aside>}
    <button ref={bell} type="button" className="header-link icon-control sn-bell" aria-label={unread ? t('notifications.open_unread', 'Notifications, {count} unread', { count: unread }) : t('notifications.title', 'Notifications')} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} disabled={!ready} onClick={openInbox}><Bell header/>{unread > 0 && <span className="sn-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}</button>
    <dialog ref={dialog} id={panelId} className="sn-dialog" dir={direction} aria-labelledby={`${panelId}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
      <div className="sn-dialog-head"><div><h2 id={`${panelId}-title`}>{t('notifications.title', 'Notifications')}{unread > 0 && <span>{unread}</span>}</h2></div><button className="sn-close" aria-label={t('notifications.close', 'Close notifications')} onClick={close}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
      <div className="sn-toolbar"><button className="sn-text-button" disabled={!!busy || !unread || !inbox || loading} onClick={() => void markAllRead()}>{t('notifications.mark_all', 'Mark all as read')}</button></div>
      <div className="sn-content" aria-busy={loading || loadingOlder}>
        {error && <div className="sn-error" role="alert"><p>{error}</p><button onClick={() => void refresh()}>{t('common.retry', 'Try again')}</button></div>}
        {mutationError && <div className="sn-error" role="alert">{mutationError}</div>}
        {loading && !inbox && <div className="sn-empty" role="status"><span className="sn-empty-icon"><Bell/></span><p>{t('notifications.loading', 'Loading your notifications…')}</p></div>}
        {!loading && !error && inbox && items.length === 0 && <div className="sn-empty"><span className="sn-empty-icon"><Bell/></span><h3>{t('notifications.empty_title', 'A little quiet for now')}</h3><p>{t('notifications.empty_hint', 'Store news and useful updates will appear here.')}</p></div>}
        <ol className="sn-list">{items.map(item => { const path = item.cta_path && safeNotificationPath(item.cta_path) ? item.cta_path : null; return <li className="sn-item" data-unread={!item.read_at} key={item.id}><span className="sn-item-symbol" aria-hidden="true"><Bell small/></span><article><div className="sn-item-meta"><span>{item.kind === 'journey' ? t('notifications.personal', 'For you') : t('notifications.store_news', 'Store news')}</span>{!item.read_at && <span className="sn-unread-dot" aria-label={t('notifications.unread', 'Unread')}/>}</div><button type="button" className="sn-item-open" onClick={() => void markRead(item)} disabled={!!busy}><span className="sn-sr-only">{t(item.read_at ? 'notifications.marked_read' : 'notifications.mark_read', item.read_at ? 'Notification marked as read.' : 'Mark read')}: </span><span className="sn-item-title" dir="auto">{item.title}</span><span className="sn-item-body" dir="auto">{item.body}</span></button>{path && item.cta_label && <Link className="sn-cta" to={path} onClick={() => { void markRead(item); close(); }}>{item.cta_label}<span aria-hidden="true">{direction === 'rtl' ? '←' : '→'}</span></Link>}<div className="sn-item-footer"><time dateTime={item.published_at}>{date(item.published_at)}</time></div>{item.expires_at && <small className="sn-expires">{t('notifications.expires', 'Available until {date}', { date: date(item.expires_at) })}</small>}</article></li>; })}</ol>
        {inbox?.next_cursor && <div className="sn-load-older"><button disabled={loading || loadingOlder || !!busy} onClick={() => void refresh(true)}>{loadingOlder ? t('common.loading', 'Loading…') : t('notifications.load_older', 'Load older notifications')}</button></div>}
      </div>
      <div className="sn-footer"><span>{t('notifications.footer_hint', 'Updates stay here until they expire or are removed.')}</span><button className="sn-text-button" disabled={loading || !!busy} onClick={() => void refresh()}>{loading ? t('common.loading', 'Loading…') : t('notifications.refresh', 'Refresh')}</button></div>
      <span className="sn-sr-only" role="status">{announcement}</span>
    </dialog>
  </div>;
}
