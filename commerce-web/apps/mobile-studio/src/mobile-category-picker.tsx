import { useEffect, useId, useMemo, useState } from 'react';
import { mobileApi, type MobileCategoryChoice } from '@commerce/api-client';
import './mobile-category-picker.css';

type Node = { category: MobileCategoryChoice; children: Node[]; path: string };
function categoryTree(categories: MobileCategoryChoice[]): Node[] {
  const byId = new Map(categories.map(c => [c.id, c]));
  const nodes = new Map(categories.map(c => [c.id, { category: c, children: [], path: '' } as Node]));
  const roots: Node[] = [];
  for (const c of categories) {
    const seen = new Set([c.id]);
    const names = [c.name];
    let parent = byId.get(c.parentId || '');
    let cyclic = false;
    while (parent) {
      if (seen.has(parent.id)) { cyclic = true; break; }
      seen.add(parent.id); names.unshift(parent.name); parent = byId.get(parent.parentId || '');
    }
    const node = nodes.get(c.id)!;
    node.path = names.join(' / ');
    const owner = !cyclic && nodes.get(c.parentId || '');
    if (owner) owner.children.push(node); else roots.push(node);
  }
  const sort = (items: Node[]) => { items.sort((a, b) => a.category.name.localeCompare(b.category.name)); items.forEach(n => sort(n.children)); };
  sort(roots);
  return roots;
}
function filterTree(nodes: Node[], query: string): Node[] {
  return nodes.flatMap(n => {
    if (`${n.category.name} ${n.category.slug}`.toLocaleLowerCase().includes(query)) return [n];
    const children = filterTree(n.children, query);
    return children.length ? [{ ...n, children }] : [];
  });
}

export function MobileCategoryPicker({ merchant, values, multiple = false, label, change }: {
  merchant: string; values: string[]; multiple?: boolean; label: string; change: (ids: string[]) => void;
}) {
  const [categories, setCategories] = useState<MobileCategoryChoice[]>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    setCategories(undefined); setError('');
    mobileApi.categories(merchant, controller.signal).then(data => {
      if (!controller.signal.aborted) setCategories(data);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load categories. Check that this store’s catalog is connected, then retry.');
    });
    return () => controller.abort();
  }, [merchant, retry]);
  const tree = useMemo(() => categoryTree(categories || []), [categories]);
  const paths = new Map<string, string>();
  const collect = (nodes: Node[]) => nodes.forEach(n => { paths.set(n.category.id, n.path); collect(n.children); });
  collect(tree);
  const selected = values.map(value => categories?.find(c => c.id === value || c.slug === value)?.id || value);
  const term = search.trim().toLocaleLowerCase();
  const visible = filterTree(tree, term);
  function select(category: MobileCategoryChoice) {
    if (!multiple) { change([category.id]); return; }
    change(selected.includes(category.id) ? values.filter((_, index) => selected[index] !== category.id) : [...values, category.id]);
  }
  function rows(nodes: Node[]) {
    return <ul>{nodes.map(n => {
      const checked = selected.includes(n.category.id);
      const choice = <label className="ms-category-choice"><input type={multiple ? 'checkbox' : 'radio'} name={id} checked={checked} disabled={multiple && !checked && values.length >= 12} onChange={() => select(n.category)} /><span dir="auto">{n.category.name}</span></label>;
      return <li key={n.category.id}>{n.children.length ? <details key={`${n.category.id}-${term}`} open={!!term || undefined}><summary><span dir="auto">{n.category.name}</span><small>{n.children.length}</small></summary>{choice}{rows(n.children)}</details> : choice}</li>;
    })}</ul>;
  }
  return <div className="ms-category-picker" role="group" aria-labelledby={`${id}-label`}>
    <strong id={`${id}-label`}>{label}</strong>
    <div className="ms-category-selection" aria-live="polite">{values.length ? values.map((v, i) => <div key={`${v}-${i}`}><span>{paths.get(selected[i]) || (categories ? 'Unavailable category — choose a replacement' : 'Saved category')}</span>{multiple && <button type="button" aria-label={`Remove ${paths.get(selected[i]) || 'unavailable category'}`} onClick={() => change(values.filter((_, index) => index !== i))}>×</button>}</div>) : 'Choose from your store’s categories below.'}</div>
    <label className="ms-field">Search categories<input type="search" placeholder="Search by category name…" value={search} onChange={e => setSearch(e.target.value)} /></label>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(v => v + 1)}>Retry categories</button></div> : !categories ? <p role="status">Loading categories…</p> : <div className="ms-category-tree" aria-label="Category hierarchy">{rows(visible)}{!visible.length && <p>{term ? 'No matching categories.' : 'This store has no categories yet.'}</p>}</div>}
    <p className="ms-help">{multiple ? `${values.length} / 12 selected. Parent and child categories can be chosen separately.` : 'Select a category to choose the products shown in this section.'}</p>
  </div>;
}
