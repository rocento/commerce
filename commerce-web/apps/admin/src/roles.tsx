import { EntityIdLabel } from "./entity-id";
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminApi, type AdminIdentity, type Role, type RoleInput } from '@commerce/api-client';
import { Field, Notice, useAction } from '@commerce/ui';
import { PageHeader } from './page-header';
import { PermissionTree } from './permission-tree';
import { permissions } from './permission-model';
import { permissionChanges, sensitivePermissions } from './access-review';
import { RowActions } from './row-actions';
import { useGrid } from './grids';
import { useUnsavedChanges } from './unsaved-changes';
import './access-management.css';

const blank: RoleInput = { name: '', permissions: [] };
const label = (key: string) => key === '*' ? 'Full administration' : permissions.find(([value]) => value === key)?.[1] || key;
export function Roles({ who }: { who: AdminIdentity }) {
  const [kind, setKind] = useState('');
  const q = useGrid('roles', ['roles'], kind ? { system: kind === 'system' } : {}, true, { initialSort: 'name' });
  const cache = useQueryClient();
  const a = useAction();
  const [form, setForm] = useState<RoleInput>(blank);
  const [original, setOriginal] = useState<RoleInput>(blank);
  const [id, setId] = useState<string>();
  const [show, setShow] = useState(false);
  const [review, setReview] = useState(false);
  const [remove, setRemove] = useState<Role | null>(null);
  const [success, setSuccess] = useState('');
  const write = who.permissions.includes('*') || who.permissions.includes('iam.roles.write');
  const changes = permissionChanges(original.permissions, form.permissions);
  const dirty = show && (form.name !== original.name || !!changes.added.length || !!changes.removed.length);
  useUnsavedChanges(dirty);
  const ungrantable = form.permissions.filter(key => !who.permissions.includes('*') && !who.permissions.includes(key));
  const sensitive = sensitivePermissions(form.permissions);
  function open(role?: Role, duplicate = false) {
    const input = role ? { name: duplicate ? `${role.name.slice(0, 70)} copy` : role.name, permissions: [...role.permissions] } : blank;
    a.setError(''); setId(duplicate ? undefined : role?.id); setOriginal(duplicate ? blank : input); setForm(input); setShow(true); setReview(false); setRemove(null); setSuccess('');
  }
  function cancel() { if (!dirty || window.confirm('Discard unsaved role changes?')) { setShow(false); setReview(false); } }
  return <main className="access-management">
    <PageHeader title="Roles & permissions" description="Define responsibilities, review access, and grant only the capabilities each role needs." actions={write && !show && <button onClick={() => open()}>Add role</button>} />
    {success && <p role="status" className="panel">{success}</p>}
    {!show && <>
      <div className="access-summary"><span><strong>{q.page?.total_count?.toLocaleString() ?? '—'}</strong> matching roles</span><span>Built-in roles are protected</span><span>Changes affect every assigned user</span></div>
      {q.renderControls({ filters: <label className="grid-field">Role type<select value={kind} onChange={e => setKind(e.target.value)}><option value="">All roles</option><option value="system">Built-in</option><option value="custom">Custom</option></select></label>, chips: kind ? [{ label: `Type: ${kind === 'system' ? 'Built-in' : 'Custom'}`, remove: () => setKind('') }] : [], clearFilters: () => setKind('') })}
      <Notice error>{a.error || q.error?.message}</Notice>
      {q.isPending ? <p role="status">Loading roles…</p> : q.data?.length === 0 ? <section className="panel access-empty"><h2>No matching roles</h2><p>Clear your filters or create a role with the permissions your team needs.</p></section> : <div className="role-list">{q.data?.map(role => {
        const risk = sensitivePermissions(role.permissions);
        return <section className="panel access-role" key={role.id}>
          <div className="row"><h2>{role.name}</h2><EntityIdLabel row={role}/><span className="badge">{role.system ? 'Built-in' : 'Custom'}</span>{risk.length > 0 && <span className="badge access-sensitive">{role.permissions.includes('*') ? 'Full access' : `${risk.length} sensitive capabilities`}</span>}</div>
          <p className="muted">{role.permissions.includes('*') ? 'Unrestricted administration across all resources.' : `${role.permissions.length} permissions assigned`}</p>
          <details><summary>Inspect permissions</summary><div className="permission-tags">{role.permissions.map(key => <span className="badge" title={key} key={key}>{label(key)}</span>)}{role.permissions.length === 0 && <p>No system permissions. Users assigned to this role cannot access admin features.</p>}</div></details>
          {write && <RowActions label={role.name} items={[
            ...(!role.system ? [{ label: 'Edit role', onSelect: () => open(role) }] : []),
            ...(!role.permissions.includes('*') && role.permissions.every(key => who.permissions.includes('*') || who.permissions.includes(key)) ? [{ label: 'Duplicate role', onSelect: () => open(role, true) }] : []),
            ...(!role.system ? [{ label: 'Delete role', destructive: true, onSelect: () => { a.setError(''); setRemove(role); } }] : []),
          ]} />}
        </section>;
      })}</div>}
    </>}
    {remove && <section className="panel" role="region" aria-label="Confirm role deletion"><h2>Delete {remove.name}?</h2><p>This permanently removes the role. Assigned users must be reassigned before deletion.</p><div className="access-buttons"><button disabled={a.busy} onClick={() => a.run(async () => { await adminApi.deleteRole(remove.id); setRemove(null); setSuccess('Role deleted.'); await cache.invalidateQueries({ queryKey: ['roles'] }); })}>{a.busy ? 'Deleting…' : 'Delete role'}</button><button disabled={a.busy} className="secondary" onClick={() => setRemove(null)}>Cancel</button></div></section>}
    {show && <section className="panel edit-panel role-editor"><h2>{review ? 'Review access changes' : id ? 'Edit role' : 'New role'}</h2>
      <form onSubmit={event => { event.preventDefault(); if (!form.name.trim() || ungrantable.length) return; if (!review) { setReview(true); return; } void a.run(async () => { await adminApi.saveRole({ ...form, name: form.name.trim() }, id); setShow(false); setReview(false); setSuccess('Role saved. Access changes apply to all assigned users.'); await cache.invalidateQueries(); }); }}>
        {!review ? <><Field label="Role name" autoFocus disabled={a.busy} required maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/><PermissionTree key={id || 'new'} value={form.permissions} actorPermissions={who.permissions} disabled={a.busy} onChange={permissions => setForm(current => ({ ...current, permissions }))}/></> : <>
          <p><strong>{form.name.trim()}</strong> · {form.permissions.length} permissions after saving</p>
          {original.name && original.name !== form.name.trim() && <p>Rename: {original.name} → {form.name.trim()}</p>}
          <div className="access-review-grid"><section><h3>Grant · {changes.added.length}</h3>{changes.added.length ? <ul>{changes.added.map(key => <li key={key}>{label(key)} <code>{key}</code></li>)}</ul> : <p>No new permissions.</p>}</section><section><h3>Revoke · {changes.removed.length}</h3>{changes.removed.length ? <ul>{changes.removed.map(key => <li key={key}>{label(key)} <code>{key}</code></li>)}</ul> : <p>No permissions removed.</p>}</section></div>
          <p>These changes affect every user assigned to this role.</p>
          {form.permissions.length === 0 && <p className="access-warning">This role grants no admin access.</p>}
          {sensitive.length > 0 && <div className="access-warning"><strong>Sensitive access included</strong><p>{sensitive.map(label).join(' · ')}</p></div>}
        </>}
        {ungrantable.length > 0 && <p role="alert" className="access-warning">You cannot save a role containing permissions you do not hold. Ask an administrator with the required access to edit this role, or remove those permissions: {ungrantable.join(', ')}.</p>}
        <Notice error>{a.error}</Notice><div className="access-buttons"><button disabled={a.busy || !dirty || !form.name.trim() || ungrantable.length > 0}>{a.busy ? 'Saving…' : review ? 'Confirm and save role' : 'Review changes'}</button>{review && <button type="button" className="secondary" disabled={a.busy} onClick={() => setReview(false)}>Back to editing</button>}<button type="button" className="secondary" disabled={a.busy} onClick={cancel}>Cancel</button></div>
      </form>
    </section>}
  </main>;
}
