import { ReasonField, reasonOptions } from "./reason-field";
import { useUnsavedChanges } from './unsaved-changes';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fulfillmentPlanApi, msiApi, type FulfillmentCapabilities } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { PageHeader } from './page-header';
import './fulfillment-settings.css';

type BooleanCapability = { [K in keyof FulfillmentCapabilities]: FulfillmentCapabilities[K] extends boolean ? K : never }[keyof FulfillmentCapabilities];
const sections = ['Methods & scheduling', 'Capacity & routing', 'Delivery coverage', 'Store locations'] as const;
function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="fs-panel"><header><h2>{title}</h2><p>{description}</p></header><div className="fs-panel-body">{children}</div></section>;
}

export function FulfillmentSettings({ canManage, canPickup, canInventory = false, canReadInventory = false }: { canManage: boolean; canPickup: boolean; canInventory?: boolean; canReadInventory?: boolean }) {
  const query = useQuery({ queryKey: ['fulfillment-settings'], queryFn: fulfillmentPlanApi.settings });
  const cache = useQueryClient();
  const action = useAction();
  const [params] = useSearchParams();
  const [store, setStore] = useState(params.get('store') ?? '');
  const [locationToOpen, setLocationToOpen] = useState('');
  const [section, setSection] = useState<(typeof sections)[number]>(sections[0]);
  const [draft, setDraft] = useState<FulfillmentCapabilities | null>(null);
  const [reason, setReason] = useState('');
  const [cityInput, setCityInput] = useState<string | null>(null);
  const [restore, setRestore] = useState(false);
  const [addingStore, setAddingStore] = useState(false);
  const newStoreId = useRef<string>();
  const [holdsInventory, setHoldsInventory] = useState(false);
  const [branchStock, setBranchStock] = useState('');
  const stocks = useQuery({queryKey: ['inventory', 'stocks'], queryFn: msiApi.stocks, enabled: canInventory && addingStore && holdsInventory});
  const [branchAddress, setBranchAddress] = useState('');
  const [branchDelivery, setBranchDelivery] = useState(true);
  const [branchPickup, setBranchPickup] = useState(false);
  const [name, setName] = useState('');
  const [storeReason, setStoreReason] = useState('');
  const selected = store ? query.data?.stores.find(s => s.id === store) : query.data?.stores[0];
  const c = draft ?? selected?.resolved;
  const changedKeys = c && selected ? (Object.keys(c) as (keyof FulfillmentCapabilities)[]).filter(key => JSON.stringify(c[key]) !== JSON.stringify(selected.resolved[key])) : [];
  const dirty = changedKeys.length > 0;
  const unsaved = dirty || !!name || !!storeReason || holdsInventory || !!branchAddress;
  const sources = query.data?.sources.filter(s => s.store_id === selected?.id) ?? [];
  const pickupCount = sources.filter(s => s.pickup_enabled).length;
  const validation = c && (!c.delivery_enabled && !c.pickup_enabled ? 'Enable at least one fulfillment method before saving.' : c.delivery_enabled && !c.asap_delivery_enabled && !c.scheduled_delivery_enabled ? 'Enable ASAP or scheduled delivery before saving.' : c.delivery_city_ids.length > 500 ? 'Delivery coverage supports up to 500 city IDs.' : '');

  useUnsavedChanges(unsaved);

  async function refresh() {
    await Promise.all([cache.invalidateQueries({ queryKey: ['fulfillment-settings'] }), cache.invalidateQueries({ queryKey: ['capacity-config'] }), cache.invalidateQueries({ queryKey: ['inventory'] })]);
  }
  function clearFeedback() { action.setError(''); action.setMessage(''); }
  function chooseStore(id: string) {
    if (dirty && !window.confirm('Discard unsaved changes and switch stores?')) return;
    setStore(id); setLocationToOpen(''); setDraft(null); setCityInput(null); setReason(''); setRestore(false); clearFeedback();
  }
  function toggle(key: BooleanCapability, value: boolean) {
    if (!c) return;
    const next = { ...c, [key]: value };
    if (key === 'delivery_enabled' && !value) { next.scheduled_delivery_enabled = false; next.asap_delivery_enabled = false; next.customer_delivery_slot_selection_enabled = false; next.split_order_scheduling_enabled = false; }
    if (key === 'delivery_enabled' && value) next.asap_delivery_enabled = true;
    if (key === 'pickup_enabled' && !value) next.pickup_scheduling_enabled = false;
    if (key === 'scheduled_delivery_enabled' && !value) { next.customer_delivery_slot_selection_enabled = false; next.split_order_scheduling_enabled = false; if (next.delivery_enabled) next.asap_delivery_enabled = true; }
    if (key === 'capacity_management_enabled' && !value) next.checkout_capacity_holds_enabled = false;
    if (key === 'multi_source_fulfillment_enabled' && !value) next.split_order_scheduling_enabled = false;
    setDraft(next); clearFeedback();
  }
  function check(key: BooleanCapability, label: string, help: string) {
    return <label className="fs-setting"><span><strong>{label}</strong><small>{help}</small></span><span className="fs-switch"><input type="checkbox" role="switch" aria-label={label} checked={Boolean(c?.[key])} disabled={!canManage || action.busy} onChange={e => toggle(key, e.target.checked)} /><span aria-hidden="true" /></span></label>;
  }
  async function saveSettings() {
    if (!selected || !c || !reason.trim() || validation || !dirty) return;
    await fulfillmentPlanApi.saveSettings(selected.id, c, reason.trim());
    await refresh(); setDraft(null); setCityInput(null); setReason(''); action.setMessage('Delivery & pickup settings saved. The updated policy is now active.');
  }

  return <main className="catalog-admin fulfillment-settings">
    <PageHeader title="Delivery & pickup settings" description="Control how orders move from your locations to your customers." actions={<span className="fs-badge">{canManage ? 'Store configuration' : 'Read-only access'}</span>} />
    <Notice error>{query.error?.message || action.error}</Notice><Notice>{action.message}</Notice>
    {query.isPending && <div className="fs-empty" role="status">Loading fulfillment configuration…</div>}
    {query.isError && <button type="button" className="secondary" onClick={() => void query.refetch()}>Retry loading settings</button>}
    {query.data && <>
      <div className="fs-store-bar"><label className="fs-field"><span>STORE WORKSPACE</span><select aria-label="Store" value={selected?.id ?? ''} disabled={action.busy || !selected} onChange={e => chooseStore(e.target.value)}>{!selected && <option value="">No stores available</option>}{query.data.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><div className="fs-store-context"><span className={`fs-dot ${dirty ? 'is-draft' : ''}`} /><span>{dirty ? 'Unsaved changes' : selected && Object.keys(selected.overrides).length ? 'Custom store policy' : 'Inherited defaults'}</span></div>{canManage && <button type="button" className="secondary" onClick={() => setAddingStore(!addingStore)} aria-expanded={addingStore}>+ Add store or branch</button>}</div>
      {addingStore && canManage && <Panel title="Add a store or branch" description="Create an online store, or a physical branch with its own linked inventory location."><form className="fs-form-grid" onSubmit={e => { e.preventDefault(); if (!name.trim() || !storeReason.trim() || (holdsInventory && (!canInventory || !branchAddress.trim() || (!branchDelivery && !branchPickup) || (branchPickup && !canPickup)))) return; void action.run(async () => { if (dirty && !window.confirm("Discard the current store’s unsaved changes and create this store?")) return; const id = newStoreId.current ??= crypto.randomUUID(); await fulfillmentPlanApi.saveStore(id, name.trim(), storeReason.trim(), holdsInventory ? {address: branchAddress.trim(), delivery_enabled: branchDelivery, pickup_enabled: branchPickup, ...(branchStock ? {stock_id: branchStock} : {})} : undefined); await refresh(); setName(''); setStoreReason(''); setAddingStore(false); setStore(id); setReason(''); setCityInput(null); newStoreId.current = undefined; setHoldsInventory(false); setBranchAddress(''); setBranchStock(''); setBranchPickup(false); setBranchDelivery(true); setDraft(null); action.setMessage(holdsInventory ? (branchStock ? 'Branch created and connected to the selected stock pool. Add product quantities in Inventory before fulfilling orders.' : 'Branch and inventory location created. Assign a stock pool and product quantities in Inventory before fulfilling orders.') : 'Store created. Connect existing inventory locations to configure fulfillment.'); }); }}><label className="fs-field">Store name<input required maxLength={100} value={name} disabled={action.busy} onChange={e => setName(e.target.value)} /></label><label className="fs-setting"><span><strong>Holds inventory</strong><small>Create a linked inventory location for this physical branch.</small></span><input type="checkbox" checked={holdsInventory} disabled={action.busy || !canInventory} onChange={e => setHoldsInventory(e.target.checked)} /></label>
      {!canInventory && <p className="fs-hint">Creating a branch inventory location requires inventory management permission.</p>}
      {holdsInventory && <><label className="fs-field">Branch address<textarea required maxLength={500} value={branchAddress} disabled={action.busy} onChange={e => setBranchAddress(e.target.value)} /></label>
      <label><input type="checkbox" checked={branchDelivery} disabled={action.busy} onChange={e => setBranchDelivery(e.target.checked)} /> Fulfills delivery</label>
      <label><input type="checkbox" checked={branchPickup} disabled={action.busy || !canPickup} onChange={e => setBranchPickup(e.target.checked)} /> Offers pickup</label>
      <label className="fs-field">Stock pool<select aria-label="Stock pool" value={branchStock} disabled={action.busy || stocks.isPending} onChange={e => setBranchStock(e.target.value)}><option value="">Assign later</option>{stocks.data?.map(stock => <option key={stock.id} value={stock.id}>{stock.name}{stock.is_default ? ' (default)' : ''}</option>)}</select><small>Choose the stock pool this branch contributes to. No product quantities are created.</small></label>
      {stocks.isError && <p role="alert">Stock pools could not be loaded. <button type="button" onClick={() => void stocks.refetch()}>Retry</button> or assign one later.</p>}
      <p className="fs-hint">The branch starts with no stock. Set product quantities after creation. If you choose “Assign later,” connect a stock pool in Inventory. Delivery coverage and pickup instructions remain configurable.</p></>}
      <ReasonField label="Change reason" options={reasonOptions.store} value={storeReason} onValueChange={value => setStoreReason(value)} disabled={action.busy} className="fs-field" /><button disabled={action.busy || !name.trim() || !storeReason.trim() || (holdsInventory && (!branchAddress.trim() || (!branchDelivery && !branchPickup)))}>{holdsInventory ? "Create branch and inventory location" : "Create store"}</button></form></Panel>}
      {store && !selected && <Notice error>The requested store is unavailable. Choose another store.</Notice>}
      {!store && !selected && <div className="fs-empty"><h2>Start with your first store</h2><p>{canManage ? 'Add a store to configure delivery, pickup, and fulfillment locations.' : 'Ask an administrator to add a store.'}</p></div>}
    </>}
    {selected && c && <>
      <div className="fs-metrics" aria-label={dirty ? 'Draft configuration summary' : 'Configuration summary'}>
        <article><span>FULFILLMENT METHODS</span><strong>{[c.delivery_enabled && 'Delivery', c.pickup_enabled && 'Pickup'].filter(Boolean).join(' + ') || 'None enabled'}</strong><small>Available at checkout{dirty ? ' · draft' : ''}</small></article>
        <article><span>CONNECTED LOCATIONS</span><strong>{sources.length.toString().padStart(2, '0')} <small>locations</small></strong><small>{pickupCount} configured for pickup</small></article>
        <article><span>CAPACITY POLICY</span><strong>{c.capacity_management_enabled ? 'Managed' : 'Unrestricted'}</strong><small>{c.checkout_capacity_holds_enabled ? 'Capacity held during checkout' : 'No checkout capacity holds'}</small></article>
      </div>
      <div className="fs-workspace"><aside className="fs-sidebar"><nav aria-label="Fulfillment sections">{sections.map((item, index) => <button key={item} type="button" aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}><span className="fs-nav-number">0{index + 1}</span>{item}<span aria-hidden="true">›</span></button>)}</nav><div className="fs-sidebar-note"><strong>One policy. Every checkout.</strong><p>Saved changes apply immediately and invalidate open checkout selections.</p><span>Changes require an audit reason.</span></div></aside>
      <div className="fs-content">
      <Notice error>{validation}</Notice>
      {section === sections[0] && <><Panel title="Fulfillment methods" description="Choose how customers receive their orders.">{check('delivery_enabled', 'Delivery', 'Deliver orders to eligible customer addresses.')}{check('pickup_enabled', 'Store pickup', 'Let customers collect orders from an activated location.')}{c.pickup_enabled && !pickupCount && <div className="fs-callout">Pickup needs an active location. <button type="button" onClick={() => setSection(sections[3])}>Configure store locations →</button></div>}</Panel><Panel title="Scheduling & delivery promises" description="Set the timing options customers see during checkout.">{c.delivery_enabled && <>{check('asap_delivery_enabled', 'ASAP delivery', 'Accept orders without a future delivery window.')}{check('scheduled_delivery_enabled', 'Scheduled delivery', 'Offer delivery windows from location calendars.')}{c.scheduled_delivery_enabled && check('customer_delivery_slot_selection_enabled', 'Customer-selected windows', 'When off, the earliest compatible window is assigned automatically.')}</>}{c.pickup_enabled && check('pickup_scheduling_enabled', 'Scheduled pickup', 'Use pickup calendars independently of delivery windows.')}{check('admin_manual_scheduling_enabled', 'Operator scheduling', 'Allow authorized operators to edit location calendars.')}</Panel></>}
      {section === sections[1] && <><Panel title="Capacity management" description="Match order intake to the limits configured for your operations.">{check('capacity_management_enabled', 'Enforce capacity limits', 'Apply location and shared capacity limits to fulfillment.')}{c.capacity_management_enabled && check('checkout_capacity_holds_enabled', 'Reserve capacity at checkout', 'Temporarily hold capacity while a customer completes checkout.')}<div className="fs-hint">Without checkout holds, enabled capacity limits are checked when the order is placed.</div></Panel><Panel title="Inventory routing" description="Define how inventory locations work together to fulfill a basket.">{check('automatic_source_routing_enabled', 'Automatic location selection', 'Select an inventory location automatically. When off, customers choose a location.')}{check('multi_source_fulfillment_enabled', 'Fulfill from multiple locations', 'Split stock across locations when one location cannot fulfill the basket.')}{c.multi_source_fulfillment_enabled && c.scheduled_delivery_enabled && check('split_order_scheduling_enabled', 'Coordinate split-order schedules', 'Reserve capacity for all participating sources together.')}{c.split_order_scheduling_enabled && <label className="fs-field fs-inset">Split delivery timing<select disabled={!canManage || action.busy} value={c.split_delivery_mode} onChange={e => setDraft({ ...c, split_delivery_mode: e.target.value as FulfillmentCapabilities['split_delivery_mode'] })}><option value="same_window_required">All packages in the same window</option><option value="independent_windows">Separate windows per package</option></select></label>}</Panel></>}
      {section === sections[2] && <Panel title="Delivery coverage" description="Define which customer addresses are eligible for delivery.">{c.delivery_enabled ? <>{check('global_delivery_enabled', 'Global delivery coverage', 'Accept delivery addresses worldwide using global and default stock. Stock, schedules and capacity still apply.')}{c.global_delivery_enabled ? <div className="fs-callout">Worldwide delivery is enabled. Turn it off to apply your saved area and city rules.</div> : <>{check('geo_fencing_enabled', 'Match delivery area boundaries', 'Check customer addresses against configured map boundaries.')}{!c.geo_fencing_enabled && <label className="fs-field fs-inset">Eligible city IDs<textarea rows={4} disabled={!canManage || action.busy} placeholder="Enter city IDs, separated by commas" value={cityInput ?? c.delivery_city_ids.join(', ')} onChange={e => { setCityInput(e.target.value); setDraft({ ...c, delivery_city_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }); }} /><small>{c.delivery_city_ids.length} / 500 cities · Use IDs from your address geography.</small></label>}{!c.geo_fencing_enabled && !c.delivery_city_ids.length && <div className="fs-callout">All saved addresses are eligible using the default stock. Add city IDs to restrict coverage.</div>}</>}</> : <div className="fs-empty"><h3>Delivery is turned off</h3><p>Enable delivery in Methods & scheduling to configure coverage.</p><button type="button" className="secondary" onClick={() => setSection(sections[0])}>Go to fulfillment methods</button></div>}</Panel>}
      {section === sections[3] && <Panel title="Connected locations" description="Pickup instructions and preparation time are managed in Inventory → Locations.">
        {sources.length ? <div className="fs-location-list">{sources.map(connection => <article key={connection.source_id}>
          <div className="fs-location-icon" aria-hidden="true">⌂</div><div><strong>{query.data?.locations.find(location => location.id === connection.source_id)?.name ?? connection.source_id}</strong><small>{connection.pickup_enabled && selected.resolved.pickup_enabled ? `Pickup configured · ${connection.preparation_minutes} min preparation` : connection.pickup_enabled ? 'Pickup configured · store pickup is off' : 'Pickup not activated'}</small></div>
          {canReadInventory && <Link className="secondary button-link" to={`/catalog/sources/${connection.source_id}?store=${encodeURIComponent(selected.id)}`}>Manage location</Link>}
        </article>)}</div> : <div className="fs-empty"><h3>No locations connected</h3><p>Open an inventory location, select this store, and save its pickup settings to connect it.</p></div>}
        {canReadInventory ? <><label className="fs-field">Choose a location to manage<select value={locationToOpen} onChange={event => setLocationToOpen(event.target.value)}><option value="">Choose an inventory location</option>{query.data?.locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>{locationToOpen && <Link className="primary-link" to={`/catalog/sources/${locationToOpen}?store=${encodeURIComponent(selected.id)}`}>Open selected location</Link>}<p><Link to="/catalog/sources">View all inventory locations</Link></p></> : <p>Inventory viewing permission is required to open location management.</p>}
      </Panel>}

      {canManage && <section className="fs-save-panel"><div className="fs-save-heading"><div><h2>{dirty ? `${changedKeys.length} unsaved setting${changedKeys.length === 1 ? '' : 's'}` : 'Policy is up to date'}</h2><p>{dirty ? 'Review your changes and record why this policy is changing.' : 'Updates are saved only when you apply them.'}</p></div><span className={`fs-badge ${dirty ? 'fs-badge-draft' : ''}`}>{dirty ? 'Draft' : 'Saved'}</span></div>{(dirty || restore) && <ReasonField label="Policy change reason" options={reasonOptions.policy} value={reason} onValueChange={value => setReason(value)} disabled={action.busy} className="fs-field" />}{dirty && <div className="fs-save-actions"><span>Applies immediately to {selected.name}.</span><button type="button" className="secondary" disabled={action.busy} onClick={() => { setDraft(null); setCityInput(null); setReason(''); clearFeedback(); }}>Discard changes</button><button type="button" disabled={action.busy || !reason.trim() || !!validation} onClick={() => void action.run(saveSettings)}>{action.busy ? 'Saving…' : 'Save fulfillment settings'}</button></div>}{!!Object.keys(selected.overrides).length && <div className="fs-defaults">{!restore ? <button type="button" className="fs-text-button" disabled={action.busy} onClick={() => setRestore(true)}>Restore inherited defaults</button> : <><p>This removes the store’s policy overrides and replaces any unsaved policy changes. Open checkout selections will be invalidated.</p><div className="fs-inline-actions"><button type="button" className="secondary" disabled={action.busy} onClick={() => setRestore(false)}>Cancel</button><button type="button" disabled={action.busy || !reason.trim()} onClick={() => void action.run(async () => { await fulfillmentPlanApi.saveSettings(selected.id, {}, reason.trim()); await refresh(); setDraft(null); setCityInput(null); setReason(''); setRestore(false); action.setMessage('Inherited fulfillment defaults restored.'); })}>Confirm restore</button></div></>}</div>}</section>}
      </div></div>
    </>}
  </main>;
}
