import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { capacityApi, type CapacityConfiguration } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { PageHeader } from './page-header';
import { ReasonField, reasonOptions } from './reason-field';
import { useUnsavedChanges } from './unsaved-changes';
import './capacity.css';

export function CapacitySettings({ canManage, canReadFulfillment }: {
  canManage: boolean;
  canReadFulfillment: boolean;
}) {
  const config = useQuery({ queryKey: ['capacity-config'], queryFn: capacityApi.configuration });
  const cache = useQueryClient();
  const action = useAction();
  const [reason, setReason] = useState('');
  const canWrite = canManage && config.data?.legacy_controls !== false;
  useUnsavedChanges(canWrite && Boolean(reason));

  async function save() {
    if (!canWrite || !config.data || config.isError || !reason.trim() || action.busy) return;
    const enabled = !config.data.enabled;
    await capacityApi.setEnabled(enabled, reason.trim());
    setReason('');
    cache.setQueryData<CapacityConfiguration>(['capacity-config'], current => current ? { ...current, enabled } : current);
    action.setMessage(`Capacity controls ${enabled ? 'enabled' : 'turned off'}. Existing bookings remain protected.`);
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['capacity-config'] }),
      cache.invalidateQueries({ queryKey: ['capacity-overview'] }),
    ]);
  }

  return <main className="catalog-admin capacity-page">
    <PageHeader title="Capacity controls" description="Configure how checkout applies fulfillment schedules and capacity limits." actions={<Link className="text-button" to="/fulfillment/capacity">Scheduling & capacity →</Link>} />
    <Notice error>{config.error?.message || action.error}</Notice>
    <Notice>{action.message}</Notice>
    {config.isPending ? <p role="status">Loading capacity configuration…</p> : config.data && <>
      {config.data.legacy_controls === false ? <section className="form-card">
        <h2>Capacity is managed per store</h2>
        <p>This installation uses store fulfillment policies. Manage capacity enforcement, checkout holds, and scheduling for each store in Delivery & pickup settings.</p>
        {config.data.controls && <p role="status">Capacity enforcement: {config.data.controls.capacity ? 'Enabled' : 'Disabled'} · Scheduling: {config.data.controls.scheduling ? 'Enabled' : 'Disabled'}</p>}
        {canReadFulfillment ? <Link className="text-button" to="/system/configuration/fulfillment">Open delivery & pickup settings →</Link> : <p>Ask an administrator with fulfillment settings access to update these policies.</p>}
      </section> : <section className="form-card capacity-control-banner">
        <div>
          <span className="capacity-kicker">CHECKOUT ADMISSION</span>
          <h2>Capacity controls <span className={`capacity-status ${config.data.enabled ? '' : 'capacity-status-off'}`}>{config.data.enabled ? 'Active' : 'Off'}</span></h2>
          <p>{config.data.enabled ? 'New bookings are checked against configured schedules and capacity limits.' : 'Standard checkout is available. Enable controls to apply configured schedules and limits.'}</p>
          <small>Confirmed bookings remain protected when controls, rules, or schedules change.</small>
        </div>
        {canWrite ? <form className="capacity-control-action" onSubmit={event => { event.preventDefault(); void action.run(save); }}>
          <ReasonField label="Reason for this change" options={config.data.enabled ? reasonOptions.disableControls : reasonOptions.enableControls} value={reason} onValueChange={setReason} disabled={action.busy || config.isError} />
          <button className={config.data.enabled ? 'secondary' : 'primary'} disabled={action.busy || config.isError || !reason.trim()}>{action.busy ? 'Saving…' : config.data.enabled ? 'Turn off controls' : 'Enable controls'}</button>
        </form> : <p role="status">Read-only access. Changing capacity controls requires both scheduling and capacity management permissions.</p>}
      </section>}
    </>}
  </main>;
}
