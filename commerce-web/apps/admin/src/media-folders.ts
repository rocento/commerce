import type { MediaFolder } from '@commerce/api-client';
export function folderTrail(folders: MediaFolder[], id: string | null): MediaFolder[] {
  const result: MediaFolder[] = [], seen = new Set<string>();
  let current = folders.find(folder => folder.id === id);
  while (current && !seen.has(current.id)) { seen.add(current.id); result.unshift(current); current = folders.find(folder => folder.id === current!.parent_id); }
  return result;
}
export function folderDescendants(folders: MediaFolder[], id: string): Set<string> {
  const result = new Set<string>(), pending = [id];
  while (pending.length) { const next = pending.pop()!; if (result.has(next)) continue; result.add(next); pending.push(...folders.filter(folder => folder.parent_id === next).map(folder => folder.id)); }
  return result;
}
