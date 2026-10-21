import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fulfillmentPlanApi, type FulfillmentSettings, type InventorySource } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { ReasonField, reasonOptions } from './reason-field';

type Connection = FulfillmentSettings['sources'][number];
type Props = {
  source: InventorySource;
  canManage: boolean;
  onDirtyChange: (dirty: boolean) => void;
};

/** Pickup belongs to a store–location connection, never to the inventory source globally. */
export function LocationPickup({ source, canManage, onDirtyChange }: Props) {
  const query = useQuery({ queryKey: ['fulfillment-settings'], queryFn: fulfillmentPlanApi.settings });
  const [params] = useSearchParams();
  const [storeId, setStoreId] = useState<string | null>(params.get('store'));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const reportDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(value); }, [onDirtyChange]);
  const connected = query.data?.sources.filter(item => item.source_id === source.id) ?? [];
  const defaultStore = connected.length === 1 ? connected[0].store_id : query.data?.stores.length === 1 ? query.data.stores[0].id : '';
  const selectedId = storeId ?? defaultStore;
  const store = query.data?.stores.find(item => item.id === selectedId);
  const connection = connected.find(item => item.store_id === selectedId);
  function selectStore(next: string) {
    if (dirty && !window.confirm('Discard unsaved pickup changes and switch stores?')) return;
    setDirty(false); onDirtyChange(false); setStoreId(next);
  }
  return <section className="form-card location-pickup" aria-labelledby="location-pickup-heading">
    <h2 id="location-pickup-heading">Store pickup</h2>
    <p>Choose a store to manage this location’s pickup availability, collection instructions and preparation time.</p>
    {query.isPending ? <p role="status">Loading pickup settings…</p> : query.isError && !query.data ? <><Notice error>{query.error.message}</Notice><button type="button" className="secondary" onClick={() => void query.refetch()}>Retry pickup settings</button></> : <>
      {query.isError && <><Notice error>Pickup settings could not be refreshed. Your draft is preserved.</Notice><button type="button" onClick={() => void query.refetch()}>Retry pickup settings</button></>}
      {!query.data?.stores.length ? <p>No stores are available. <Link to="/system/configuration/fulfillment">Add a store in Delivery &amp; pickup settings</Link>.</p> : <>
        <label className="field">Store for pickup<select value={selectedId} disabled={busy} onChange={event => selectStore(event.target.value)}>
          <option value="">Choose a store</option>
          {selectedId && !store && <option value={selectedId}>Unavailable store</option>}
          {query.data.stores.map(item => <option key={item.id} value={item.id}>{item.name}{connected.some(link => link.store_id === item.id) ? ' · Connected' : ' · Not connected'}</option>)}
        </select></label>
        {selectedId && !store && <Notice error>The requested store is unavailable. Choose an available store before changing pickup settings.</Notice>}
        {store && <PickupForm key={store.id} source={source} store={store} connection={connection} canManage={canManage && !query.isError} onDirtyChange={reportDirty} onBusyChange={setBusy} />}
      </>}
    </>}
  </section>;
}

function PickupForm({ source, store, connection, canManage, onDirtyChange, onBusyChange }: Props & { onBusyChange: (busy: boolean) => void; store: FulfillmentSettings['stores'][number]; connection?: Connection }) {
  const cache = useQueryClient();
  const action = useAction();
  const defaults: Connection = { store_id: store.id, source_id: source.id, pickup_enabled: false, pickup_instructions: '', preparation_minutes: 30 };
  const [initial, setInitial] = useState<Connection>(connection ?? defaults);
  const [form, setForm] = useState<Connection>(connection ?? defaults);
  const [reason, setReason] = useState('');
  const [connected, setConnected] = useState(!!connection);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  const changed = JSON.stringify(form) !== JSON.stringify(initial);
  // The location editor owns the sole router blocker for both independent forms.
  useEffect(() => { onDirtyChange(changed || !!reason || action.busy); }, [changed, reason, action.busy, onDirtyChange]);
  const stale = !!connection !== connected || !!connection && (connection.pickup_enabled !== initial.pickup_enabled || connection.pickup_instructions !== initial.pickup_instructions || connection.preparation_minutes !== initial.preparation_minutes);
  const validation = stale ? 'These pickup settings changed since you opened them. Reload the latest settings before saving.' : !Number.isInteger(form.preparation_minutes) || form.preparation_minutes < 1 || form.preparation_minutes > 1440
    ? 'Preparation time must be a whole number from 1 to 1440 minutes.'
    : new TextEncoder().encode(form.pickup_instructions).length > 1000 ? 'Pickup instructions must fit within 1000 UTF-8 bytes. Shorten the instructions before saving.' : new TextEncoder().encode(reason.trim()).length > 300 ? 'The change reason is too long. Shorten it before saving.' : '';
  const canSave = canManage && !action.busy && !validation && !!reason.trim() && new TextEncoder().encode(reason.trim()).length <= 300 && (changed || !connected);
  function update<K extends keyof Connection>(key: K, value: Connection[K]) {
    setForm(previous => ({ ...previous, [key]: value })); action.setError(''); action.setMessage('');
  }
  return <form onSubmit={event => { event.preventDefault(); if (!canSave) return; void action.run(async () => {
    await fulfillmentPlanApi.saveSource(form, reason.trim());
    setInitial(form); setConnected(true); setReason('');
    cache.setQueryData<FulfillmentSettings>(['fulfillment-settings'], current => current ? { ...current, sources: [...current.sources.filter(item => item.store_id !== store.id || item.source_id !== source.id), form] } : current);
    await Promise.all([cache.invalidateQueries({ queryKey: ['fulfillment-settings'] }), cache.invalidateQueries({ queryKey: ['capacity-config'] })]);
    action.setMessage(`Pickup settings saved for ${store.name}.`);
  }); }}>
    <p><strong>{store.name}</strong> · {connected ? 'Connected to this location' : 'Saving will connect this location to this store'}</p>
    {!store.resolved.pickup_enabled && <p role="note">Store pickup is off for {store.name}. Existing pickup settings are preserved; customers cannot collect here until store pickup is enabled. <Link to={`/system/configuration/fulfillment?store=${encodeURIComponent(store.id)}`}>Manage store policy</Link>.</p>}
    {!source.is_enabled && <p role="note">This inventory location is disabled. Enable it and make stock available before offering collection.</p>}
    {!canManage && <p>Read-only pickup settings. Changes require fulfillment settings and pickup management permissions.</p>}
    <fieldset disabled={!canManage || action.busy}>
      <legend className="sr-only">Pickup settings for {store.name}</legend>
      <label className="checkbox"><input type="checkbox" role="switch" aria-label="Accept pickup at this location" checked={form.pickup_enabled} disabled={!store.resolved.pickup_enabled} onChange={event => update('pickup_enabled', event.target.checked)} />Accept pickup at this location</label>
      <div className="form-grid">
        <label className="field">Pickup instructions<textarea rows={3} maxLength={1000} value={form.pickup_instructions} placeholder="Where to collect the order and what to bring" onChange={event => update('pickup_instructions', event.target.value)} /></label>
        <label className="field">Preparation time (minutes)<input type="number" min={1} max={1440} step={1} required value={Number.isNaN(form.preparation_minutes) ? '' : form.preparation_minutes} onChange={event => update('preparation_minutes', event.target.value === '' ? NaN : Number(event.target.value))} /></label>
      </div>
      {canManage && <ReasonField label="Location change reason" options={reasonOptions.location} value={reason} onValueChange={setReason} />}
    </fieldset>
    <p className="help">Pickup also requires stock at this location. Manage quantities in Inventory; scheduled pickup calendars are managed in Delivery &amp; pickup → Scheduling &amp; capacity.</p>
    <Notice error>{validation || action.error}</Notice>{stale && <button type="button" className="secondary" disabled={action.busy} onClick={() => { if ((changed || reason) && !window.confirm('Discard your pickup draft and reload the latest settings?')) return; setInitial(connection ?? defaults); setForm(connection ?? defaults); setConnected(!!connection); setReason(''); action.setError(''); action.setMessage(''); }}>Reload latest pickup settings</button>}<Notice>{action.message}</Notice>
    {canManage && <div className="form-actions"><button disabled={!canSave}>{action.busy ? 'Saving pickup…' : connected ? 'Save pickup settings' : 'Connect store and save pickup'}</button>{(changed || reason) && <button type="button" className="secondary" disabled={action.busy} onClick={() => { setForm(initial); setReason(''); action.setError(''); action.setMessage(''); }}>Discard pickup changes</button>}</div>}
  </form>;
}
