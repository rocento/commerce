import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalogApi, type Category } from '@commerce/api-client';
import { categoryTrail, categoryTree, filterCategoryTree, type CategoryNode } from './category-tree';
import './category-picker.css';

type Props = {
  value: string;
  onChange: (id: string, category?: Category) => void;
  disabled?: boolean;
  canReadCatalog: boolean;
  label?: string;
  allowAll?: boolean;
  matchSlug?: boolean;
};

/** Stores catalog IDs, while exposing names and the full hierarchy to merchants. */
export function CategoryPicker({ value, onChange, disabled = false, canReadCatalog, label = 'Category', allowAll = true, matchSlug = false }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const helpId = useId();
  const query = useQuery({ queryKey: ['catalog', 'categories', 'tree'], queryFn: catalogApi.adminCategories, enabled: canReadCatalog, staleTime: 30000, retry: false });
  const selected = query.data?.find(category => category.id === value || matchSlug && category.slug === value);
  const trail = selected ? categoryTrail(query.data ?? [], selected.id).map(category => category.name).join(' / ') : '';
  const missing = canReadCatalog && query.isSuccess && !!value && !selected;
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div className="field category-picker" role="group" aria-labelledby={labelId}>
    <span id={labelId}>{label}</span>
    <button ref={trigger} type="button" className="category-picker-trigger secondary" disabled={disabled || !canReadCatalog} aria-haspopup="dialog" aria-expanded={open} aria-describedby={helpId} onClick={() => setOpen(true)}>
      <span><strong>{selected?.name || (value ? missing ? 'Unavailable category' : 'Saved category' : allowAll ? 'All categories' : 'Choose a category')}</strong><small>{trail || (value ? 'Choose a category to review this selection' : allowAll ? 'Products from across your catalog' : 'Browse your catalog hierarchy')}</small></span><span aria-hidden="true">▾</span>
    </button>
    <small id={helpId}>{!canReadCatalog ? 'Catalog read permission is required to browse categories.' : missing ? 'This saved category no longer exists. Choose another category or clear the selection.' : allowAll ? 'Choose a category to filter the products in this section.' : 'Choose a category as the destination.'}</small>
    {allowAll && value && <button type="button" className="text-button category-picker-clear" disabled={disabled} onClick={() => onChange('')}>Clear category filter</button>}
    {query.error && canReadCatalog && <div className="category-picker-error" role="alert">Could not load categories. <button type="button" className="text-button" onClick={() => void query.refetch()}>Retry categories</button></div>}
    {open && <CategoryDialog value={selected?.id || value} allowAll={allowAll} categories={query.data ?? []} loading={query.isPending} error={query.error?.message} retry={() => void query.refetch()} close={close} apply={id => { onChange(id, query.data?.find(category => category.id === id)); close(); }} />}
  </div>;
}

/** Product assignments use the same hierarchy, with an explicit primary category. */
export function ProductCategoryPicker({ categories, values, primary, loading, error, retry, onChange, disabled = false }: {
  categories: Category[]; values: string[]; primary: string; loading: boolean; error?: string;
  retry: () => void; onChange: (values: string[], primary: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = [...new Set([...values, primary].filter(Boolean))];
  const name = (id: string) => categoryTrail(categories, id).map(category => category.name).join(' / ') || 'Unavailable category';
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div className="product-category-picker">
    <p className="help">Select every category where this product should appear, then choose its primary category. Parent and child categories can be selected independently.</p>
    <button ref={trigger} type="button" className="secondary category-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span><strong>{selected.length ? `${selected.length} categories selected` : 'Choose categories'}</strong><small>Browse and select from the category tree</small></span><span aria-hidden="true">▾</span>
    </button>
    {loading && <p role="status">Loading categories…</p>}
    {error && <div role="alert" className="category-picker-error">Could not load categories. <button type="button" className="text-button" onClick={retry}>Retry categories</button></div>}
    <label className="field">Primary category
      <select required value={primary} disabled={disabled} onChange={event => onChange(selected, event.target.value)}>
        <option value="">Choose a primary category</option>
        {selected.map(id => <option key={id} value={id}>{name(id)}</option>)}
      </select>
    </label>
    {selected.length > 0 && <ul className="product-category-selection" aria-label="Selected categories">{selected.map(id => <li key={id}><span>{name(id)}{id === primary && <small>Primary</small>}</span><button type="button" className="text-button" disabled={disabled} aria-label={`Remove ${name(id)}`} onClick={() => { const next = selected.filter(value => value !== id); onChange(next, id === primary ? next[0] || '' : primary); }}>Remove</button></li>)}</ul>}
    {open && <CategoryDialog value={primary} allowAll={false} categories={categories} loading={loading} error={error} retry={retry} close={close} apply={() => {}} multiple={{ values: selected, apply: next => { onChange(next, next.includes(primary) ? primary : next[0] || ''); close(); } }} />}
  </div>;
}

function CategoryDialog({ value, allowAll, categories, loading, error, retry, close, apply, multiple }: {
  value: string; allowAll: boolean; categories: Category[]; loading: boolean; error?: string;
  retry: () => void; close: () => void; apply: (id: string) => void;
  multiple?: { values: string[]; apply: (values: string[]) => void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const helpId = useId();
  const [selected, setSelected] = useState(value);
  const [selections, setSelections] = useState(() => new Set(multiple?.values ?? []));
  const initialValues = useRef(multiple?.values ?? [value]);
  function select(id: string) {
    if (!multiple) { setSelected(id); return; }
    setSelections(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => categoryTree(categories), [categories]);
  const visible = useMemo(() => filterCategoryTree(tree, search), [tree, search]);
  const searching = !!search.trim();
  const visibleIds: string[] = [];
  function collect(nodes: CategoryNode[]) { nodes.forEach(node => { visibleIds.push(node.category.id); if (searching || expanded.has(node.category.id)) collect(node.children); }); }
  collect(visible);
  const tabStop = [focused, selected, visibleIds[0]].find(id => id && visibleIds.includes(id));
  const current = categories.find(category => category.id === selected);
  useEffect(() => { const element = dialog.current!; element.showModal(); searchInput.current?.focus(); return () => element.close(); }, []);
  useEffect(() => { setExpanded(previous => new Set([...previous, ...initialValues.current.flatMap(id => categoryTrail(categories, id).map(category => category.id))])); }, [categories, value]);
  function toggle(id: string) { setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function dismiss() { dialog.current?.close(); close(); }
  function focus(id: string) { treeRef.current?.querySelector<HTMLElement>(`[data-category-id="${CSS.escape(id)}"]`)?.focus(); }
  function keyDown(event: KeyboardEvent, node: CategoryNode, isOpen: boolean, parent?: string) {
    if (event.target !== event.currentTarget) return;
    const index = visibleIds.indexOf(node.category.id);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleIds.length - 1 : Math.max(0, Math.min(visibleIds.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      focus(visibleIds[next]);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (node.children.length) { if (!isOpen) toggle(node.category.id); else focus(node.children[0].category.id); }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (isOpen && node.children.length && !searching) toggle(node.category.id); else if (parent) focus(parent);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); select(node.category.id);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = [...visibleIds.slice(index + 1), ...visibleIds.slice(0, index + 1)].find(id => categories.find(category => category.id === id)?.name.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (next) { event.preventDefault(); focus(next); }
    }
  }
  function nodes(items: CategoryNode[], level = 1, parent?: string) {
    return items.map((node, index) => {
      const id = node.category.id;
      const isOpen = searching || expanded.has(id);
      return <div key={id} role="treeitem" aria-label={node.category.name} aria-selected={multiple ? undefined : selected === id} aria-checked={multiple ? selections.has(id) : undefined} aria-expanded={node.children.length ? isOpen : undefined} aria-level={level} aria-setsize={items.length} aria-posinset={index + 1} data-category-id={id} tabIndex={tabStop === id ? 0 : -1} onFocus={event => { if (event.target === event.currentTarget) setFocused(id); }} onKeyDown={event => keyDown(event, node, isOpen, parent)}>
        <div className="category-picker-row" style={{ paddingInlineStart: 12 + (level - 1) * 20 }} onClick={() => { focus(id); select(id); }}>
          <span className="category-picker-chevron" aria-hidden="true" onClick={event => { if (node.children.length) { event.stopPropagation(); focus(id); toggle(id); } }}>{node.children.length ? isOpen ? '⌄' : '›' : '·'}</span>
          <span className="category-picker-name"><strong>{node.category.name}</strong><small>{node.category.slug}</small></span>
          {node.children.length > 0 && <span className="category-picker-child-count">{node.children.length}</span>}
          <span className={multiple ? "category-picker-checkbox" : "category-picker-radio"} aria-hidden="true">{multiple ? selections.has(id) ? "✓" : "" : selected === id ? "●" : "○"}</span>
        </div>
        {isOpen && node.children.length > 0 && <div role="group">{nodes(node.children, level + 1, id)}</div>}
      </div>;
    });
  }
  return <dialog ref={dialog} className="category-picker-dialog" aria-labelledby={titleId} aria-describedby={helpId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header><div><h2 id={titleId}>{multiple ? "Select categories" : "Select category"}</h2><p id={helpId}>{multiple ? "Browse the hierarchy or search by name. Select multiple categories, then apply your choices." : "Browse the hierarchy or search by name. Select a category, then apply your choice."}</p></div><button type="button" className="secondary" aria-label="Close category picker" onClick={dismiss}>×</button></header>
    <div className="category-picker-body">
      <label className="field">Search categories<input ref={searchInput} type="search" placeholder="Search by name or URL key…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="category-picker-toolbar"><span role="status">{loading ? 'Loading categories…' : `${categories.length} categories`}</span><div><button type="button" className="text-button" disabled={loading || searching} onClick={() => setExpanded(new Set(categories.map(category => category.id)))}>Expand all</button><button type="button" className="text-button" disabled={loading || searching} onClick={() => setExpanded(new Set())}>Collapse all</button></div></div>
      {error ? <div className="category-picker-error" role="alert"><p>Categories could not be loaded. Your current selection is unchanged.</p><button type="button" className="secondary" onClick={retry}>Retry categories</button></div> : <>
        {allowAll && <button type="button" className="category-picker-all secondary" aria-pressed={!selected} onClick={() => setSelected('')}><span>All categories<small>Use the whole catalog</small></span><span aria-hidden="true">{!selected ? '●' : '○'}</span></button>}
        <div ref={treeRef} className="category-picker-tree" role="tree" aria-label="Category tree" aria-multiselectable={multiple ? true : undefined} aria-busy={loading}>{nodes(visible)}</div>
        {!loading && !visible.length && <p className="category-picker-empty">{searching ? 'No matching categories. Try another name or URL key.' : 'No categories yet. Add categories in Catalog → Categories.'}</p>}
      </>}
    </div>
    <footer><div className="category-picker-chosen" role="status"><small>{multiple ? "Selected categories" : "Selected category"}</small><strong>{multiple ? `${selections.size} selected` : current ? categoryTrail(categories, current.id).map(category => category.name).join(' / ') : !selected && allowAll ? 'All categories' : 'Select an available category'}</strong></div><div className="category-picker-dialog-actions"><button type="button" className="secondary" onClick={dismiss}>Cancel</button><button type="button" disabled={loading || !!error || (!multiple && !(current || !selected && allowAll))} onClick={() => { dialog.current?.close(); if (multiple) multiple.apply([...selections]); else apply(selected); }}>{multiple ? "Apply categories" : "Apply category"}</button></div></footer>
  </dialog>;
}
