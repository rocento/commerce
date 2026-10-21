import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildPermissionTree, changePermissions, filterPermissions, permissionKeys, type PermissionNode } from './permission-model';
import './permission-tree.css';

function ResourceCheckbox({ checked, mixed, disabled, label, onChange }: { checked: boolean; mixed: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" checked={checked} aria-checked={mixed ? 'mixed' : checked} aria-label={label} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}
export function PermissionTree({ value, actorPermissions, disabled = false, onChange }: { value: string[]; actorPermissions: string[]; disabled?: boolean; onChange: (permissions: string[]) => void }) {
  const [search, setSearch] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [expanded, setExpanded] = useState(new Set(['catalog', 'products']));
  const treeId = useId();
  const [initialPermissions] = useState(value);
  const nodes = useMemo(() => buildPermissionTree([...initialPermissions, ...value], actorPermissions), [initialPermissions, value, actorPermissions]);
  const selected = new Set(value);
  const visible = filterPermissions(nodes, search, selectedOnly, selected);
  const allKeys = permissionKeys(nodes);
  const visibleKeys = permissionKeys(visible);
  const canGrant = (key: string) => actorPermissions.includes('*') || actorPermissions.includes(key);
  const availableKeys = visibleKeys.filter(canGrant);
  const selectedCount = allKeys.filter(key => selected.has(key)).length;
  const filtered = !!search.trim() || selectedOnly;
  function toggle(id: string) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function groupIds(items: PermissionNode[]): string[] {
    return items.flatMap(node => node.children ? [node.id, ...groupIds(node.children)] : []);
  }
  function render(items: PermissionNode[], level = 0) {
    return <ul className="permission-branches">{items.map(node => {
      const keys = permissionKeys([node]);
      const count = keys.filter(key => selected.has(key)).length;
      const checked = count === keys.length;
      const mixed = count > 0 && !checked;
      const branch = !!node.children;
      const open = filtered || expanded.has(node.id);
      const locked = !keys.some(key => canGrant(key) || selected.has(key));
      const branchId = `${treeId}-${node.id}`;
      return <li key={node.id} className={level === 0 ? 'permission-root' : ''}>
        <div className={`permission-resource ${branch ? 'permission-group' : 'permission-leaf'}${mixed || checked ? ' has-selection' : ''}`}>
          {branch ? <button type="button" className="permission-disclosure" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.label}`} aria-expanded={open} aria-controls={branchId} disabled={filtered} onClick={() => toggle(node.id)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={open ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} fill="none" stroke="currentColor" strokeWidth="1.5"/></svg></button> : <span className="permission-connector" aria-hidden="true"/>}
          <label className="permission-choice"><ResourceCheckbox label={node.label} checked={checked} mixed={mixed} disabled={disabled || locked} onChange={checked => onChange(changePermissions(value, keys, checked && keys.some(key => canGrant(key) && !selected.has(key)), actorPermissions))}/>
          <span className="permission-resource-name">{node.label}{!branch && <code>{node.permission}</code>}</span></label>
          {branch ? <span className="permission-count" aria-label={`${count} of ${keys.length} selected`}>{count} / {keys.length}</span> : !canGrant(node.permission!) && <span className="permission-locked">Not grantable</span>}
        </div>
        {branch && <div id={branchId} hidden={!open}>{render(node.children!, level + 1)}</div>}
      </li>;
    })}</ul>;
  }
  return <section className="permission-editor" aria-labelledby={`${treeId}-heading`}>
    <div className="permission-editor-heading"><div><h3 id={`${treeId}-heading`}>Role resources</h3><p>Choose the admin capabilities this role can access.</p></div><span className="permission-total" role="status">{selectedCount} of {allKeys.length} selected</span></div>
    <div className="permission-toolbar"><label className="permission-search">Search resources<input type="search" value={search} placeholder="Search a feature or permission…" onChange={event => setSearch(event.target.value)}/></label><label className="permission-selected-filter"><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)}/>Selected only</label></div>
    <div className="permission-tree-controls"><div><button type="button" className="text-button" disabled={filtered} onClick={() => setExpanded(new Set(groupIds(nodes)))}>Expand all</button><button type="button" className="text-button" disabled={filtered} onClick={() => setExpanded(new Set())}>Collapse all</button></div><div><button type="button" className="text-button" disabled={disabled || !availableKeys.some(key => !selected.has(key))} onClick={() => onChange(changePermissions(value, availableKeys, true, actorPermissions))}>{filtered ? 'Select matching' : 'Select all available'}</button><button type="button" className="text-button" disabled={disabled || !visibleKeys.some(key => selected.has(key))} onClick={() => onChange(changePermissions(value, visibleKeys, false, actorPermissions))}>{filtered ? 'Clear matching' : 'Clear selection'}</button></div></div>
    <p className="permission-tree-help">{filtered ? `${visibleKeys.length} matching ${visibleKeys.length === 1 ? 'resource' : 'resources'}. Group selections affect matching resources only.` : 'Select a section to include its resources. A dash means only some resources are selected.'}</p>
    {!actorPermissions.includes('*') && <p className="permission-grant-help">You can only grant permissions you hold. A role containing permissions you do not hold cannot be saved.</p>}
    <div className="permission-tree" aria-label="Permission resources">{visible.length ? render(visible) : <p className="permission-empty">{selectedOnly ? 'No selected resources match this view.' : 'No resources match your search.'}</p>}</div>
  </section>;
}
