import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import './row-actions.css';

export type RowAction = {
  label: string;
  to?: string;
  onSelect?: () => unknown | Promise<unknown>;
  disabled?: boolean;
  reason?: string;
  destructive?: boolean;
  confirm?: string;
};

/** One shared action menu for admin grids; permissions remain at the call site. */
export function RowActions({ label, items }: { label: string; items: RowAction[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const primaryControl = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocus = useRef('first');
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [confirmation, setConfirmation] = useState<RowAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const safeOpen = (item: RowAction) => !item.disabled && !item.destructive && !item.confirm && !!(item.to || item.onSelect);
  const primary = items.find(item => safeOpen(item) && /^(?:view|open)(?:\s|$)/i.test(item.label))
    ?? items.find(item => safeOpen(item) && /^(?:edit|configure)(?:\s|$)/i.test(item.label));
  const primaryLabel = primary && /^(?:edit|configure)(?:\s|$)/i.test(primary.label) ? 'Open' : 'View';
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const enabledItems = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  // Enhance only rows with an existing safe detail/editor action; preserve native table semantics.
  useEffect(() => {
    const row = trigger.current?.closest('tr');
    if (!row || !primary || busy || row.hasAttribute('data-row-view')) return;
    const oldTabIndex = row.getAttribute('tabindex');
    const oldDescription = row.getAttribute('aria-description');
    row.dataset.rowView = 'true';
    row.tabIndex = 0;
    row.setAttribute('aria-description', `Press Enter to ${primary.label.toLowerCase()} for ${label}`);
    const interactive = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"],[data-row-click-ignore]';
    const click = (event: MouseEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.button !== 0 || !(target instanceof Element) || target.closest(interactive) || window.getSelection()?.toString()) return;
      // Native anchors retain Ctrl/Cmd/Shift click behavior, including new tabs.
      if (primary.to) primaryControl.current?.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, ctrlKey:event.ctrlKey, metaKey:event.metaKey, shiftKey:event.shiftKey, altKey:event.altKey }));
      else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) primaryControl.current?.click();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.target !== row || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      primaryControl.current?.click();
    };
    row.addEventListener('click', click);
    row.addEventListener('keydown', key);
    return () => {
      row.removeEventListener('click', click); row.removeEventListener('keydown', key);
      delete row.dataset.rowView;
      if (oldTabIndex === null) row.removeAttribute('tabindex'); else row.setAttribute('tabindex', oldTabIndex);
      if (oldDescription === null) row.removeAttribute('aria-description'); else row.setAttribute('aria-description', oldDescription);
    };
  }, [primary, busy, label]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8)), top: Math.max(8, anchor.bottom + bounds.height + 8 > innerHeight ? anchor.top - bounds.height - 6 : anchor.bottom + 6) });
    };
    place();
    const entries = enabledItems();
    ((initialFocus.current === 'last' ? entries.at(-1) : entries[0]) ?? menu.current)?.focus();
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!confirmation || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [confirmation]);
  async function execute(item: RowAction) {
    setError(''); setBusy(true);
    try { await item.onSelect?.(); setConfirmation(undefined); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The action could not be completed. Please try again.'); }
    finally { setBusy(false); }
  }
  function select(item: RowAction) {
    close(); setError('');
    if (item.confirm) setConfirmation(item);
    else void execute(item);
  }
  function onMenuKey(event: KeyboardEvent) {
    const entries = enabledItems();
    const current = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
    else if (event.key === ' ') { event.preventDefault(); (document.activeElement as HTMLElement)?.click(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[index]?.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      search.current = { text: (Date.now() - search.current.time < 600 ? search.current.text : '') + event.key.toLowerCase(), time: Date.now() };
      entries.find(entry => entry.textContent?.trim().toLowerCase().startsWith(search.current.text))?.focus();
    }
  }
  if (!items.length) return <span className="row-actions-empty">—</span>;
  return <span className="row-actions">
    {primary && (primary.to
      ? <Link ref={element => { primaryControl.current = element; }} className="row-view-link" to={primary.to} tabIndex={-1} aria-label={`${primary.label}: ${label}`}>{primaryLabel}</Link>
      : <button ref={element => { primaryControl.current = element; }} type="button" className="row-view-link" tabIndex={-1} disabled={busy} onClick={() => select(primary)} aria-label={`${primary.label}: ${label}`}>{primaryLabel}</button>)}
    <button ref={trigger} type="button" className="row-actions-trigger" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={busy} onClick={() => { initialFocus.current = 'first'; setOpen(!open); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true); } }}>
      Actions <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="menu" tabIndex={-1} aria-label={`Actions for ${label}`} className="row-actions-menu" style={position} onKeyDown={onMenuKey}>
      <div className="row-actions-label" role="presentation">{label}</div>
      {items.map(item => item.to && !item.disabled ? <Link key={item.label} role="menuitem" tabIndex={-1} className="row-actions-item" to={item.to} onClick={() => close()}>{item.label}</Link> : <button key={item.label} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} aria-disabled={item.disabled || undefined} title={item.reason} className={`row-actions-item${item.destructive ? ' is-destructive' : ''}`} onClick={() => select(item)}>{item.label}{item.reason && <small>{item.reason}</small>}</button>)}
    </div>, document.body)}
    {error && !confirmation && <span className="row-actions-error" role="alert">{error}</span>}
    {confirmation && createPortal(<dialog ref={dialog} className="row-action-confirm" aria-labelledby={`${id}-confirm`} onCancel={event => { if (busy) event.preventDefault(); else setConfirmation(undefined); }} onClose={() => trigger.current?.focus()}>
      <h2 id={`${id}-confirm`}>{confirmation.label} {label}?</h2><p>{confirmation.confirm}</p>{error && <p role="alert">{error}</p>}
      <div><button type="button" className="secondary" autoFocus disabled={busy} onClick={() => setConfirmation(undefined)}>Cancel</button><button type="button" className={confirmation.destructive ? 'danger' : undefined} disabled={busy} onClick={() => void execute(confirmation)}>{busy ? 'Working…' : `Confirm ${confirmation.label.toLowerCase()}`}</button></div>
    </dialog>, document.body)}
  </span>;
}
