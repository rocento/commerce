import type { Category } from '@commerce/api-client';
import { matchesEntityId } from './entity-id';
export type CategoryNode = { category: Category; children: CategoryNode[] };
export function categoryDescendants(categories: Category[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const category of categories) if (category.parent_id) children.set(category.parent_id, [...(children.get(category.parent_id) || []), category.id]);
  const result = new Set<string>();
  const pending = [id];
  while (pending.length) { const next = pending.pop()!; if (result.has(next)) continue; result.add(next); pending.push(...(children.get(next) || [])); }
  return result;
}
export function categoryTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map(categories.map(category => [category.id, {category, children: []} as CategoryNode]));
  const parents = new Map(categories.map(category => [category.id, category.parent_id]));
  const roots: CategoryNode[] = [];
  for (const category of categories) {
    let next = category.parent_id;
    const visited = new Set([category.id]);
    while (next && nodes.has(next)) {
      if (visited.has(next)) { parents.set(category.id, null); break; }
      visited.add(next); next = parents.get(next) || null;
    }
    const parent = parents.get(category.id);
    if (parent && nodes.has(parent)) nodes.get(parent)!.children.push(nodes.get(category.id)!);
    else roots.push(nodes.get(category.id)!);
  }
  const sort = (list: CategoryNode[]) => { list.sort((a,b) => a.category.name.localeCompare(b.category.name) || a.category.id.localeCompare(b.category.id)); list.forEach(node => sort(node.children)); };
  sort(roots); return roots;
}
export function filterCategoryTree(nodes: CategoryNode[], query: string, names?: Record<string,string>): CategoryNode[] {
  const term = query.trim().toLowerCase();
  if (!term) return nodes;
  return nodes.flatMap(node => {
    const children = filterCategoryTree(node.children, term, names);
    return matchesEntityId(node.category, term) || `${node.category.name} ${node.category.slug} ${names?.[node.category.id]||''}`.toLowerCase().includes(term) ? [node] : children.length ? [{...node, children}] : [];
  });
}
export function categoryTrail(categories: Category[], id: string): Category[] {
  const byId = new Map(categories.map(category => [category.id, category]));
  const trail: Category[] = []; const visited = new Set<string>();
  let current = byId.get(id);
  while (current && !visited.has(current.id)) { visited.add(current.id); trail.unshift(current); current = current.parent_id ? byId.get(current.parent_id) : undefined; }
  return trail;
}
