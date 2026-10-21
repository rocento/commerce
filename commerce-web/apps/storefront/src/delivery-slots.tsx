import { useInterface } from './interface-locale';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { capacityApi, type CapacityHold, type DeliverySlot } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
export function DeliverySlots({ locationId, onSelected, locked }: { locationId: string; onSelected: () => void; locked: boolean }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [hold, setHold] = useState<CapacityHold | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now);
  const options = useQuery({ queryKey: ['delivery-slots', locationId, date], queryFn: () => capacityApi.options(locationId, date), enabled: !locked, refetchInterval: 30000, retry: false });
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = hold && Date.parse(hold.expires_at) <= now;
  async function select(slot: DeliverySlot) {
    setBusy(true); setError('');
    try { const result = await capacityApi.hold(slot, locationId, crypto.randomUUID()); setHold(result); onSelected(); await options.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Please choose another delivery window.'); await options.refetch(); }
    finally { setBusy(false); }
  }
  if (locked || options.data?.enabled === false) return null;
  return <section className="checkout-section"><h2>{ui("storefront.delivery_window", "Delivery window")}</h2><p>{ui("storefront.choose_an_available_time_your_window_is_held_temporarily_while_you_complete_checkout", "Choose an available time. Your window is held temporarily while you complete checkout.")}</p>
    <label>{ui("storefront.delivery_date", "Delivery date")} <input type="date" value={date} disabled={busy} onChange={e => setDate(e.target.value)} /></label>
    <Notice error>{message((error || options.error?.message) || '')}</Notice>
    {hold && !expired && <p role="status">{ui("fulfillment.hold_remaining", "Window reserved \u00b7 {minutes} minutes remaining", {minutes:Math.max(0, Math.ceil((Date.parse(hold.expires_at)-now)/60000))})}</p>}
    {expired && <Notice error>{ui("storefront.your_delivery_hold_expired_select_a_window_again_before_confirming_your_order", "Your delivery hold expired. Select a window again before confirming your order.")}</Notice>}
    {options.isLoading && <p role="status">{ui("storefront.checking_delivery_availability", "Checking delivery availability…")}</p>}
    {!options.isLoading && options.data?.enabled && options.data.slots.length === 0 && <p>{ui("storefront.no_delivery_windows_are_available_on_this_date_try_another_day", "No delivery windows are available on this date. Try another day.")}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>{options.data?.slots.map(slot => <button type="button" className="secondary" key={slot.schedule_id + slot.starts_at} disabled={busy} aria-pressed={!!hold && !expired && hold.source_id === slot.source_id && hold.method === slot.method && hold.starts_at === slot.starts_at} onClick={() => void select(slot)}>
      {new Date(slot.starts_at).toLocaleTimeString(locale === "ar" ? "ar" : undefined, { timeZone: slot.timezone, hour: '2-digit', minute: '2-digit' })}–{new Date(slot.ends_at).toLocaleTimeString(locale === "ar" ? "ar" : undefined, { timeZone: slot.timezone, hour: '2-digit', minute: '2-digit' })}<br /><small>{message(slot.method.replaceAll('_', ' '))} · {slot.timezone}</small>
    </button>)}</div>
  </section>;
}
