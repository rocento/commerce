export const translationStatus = { missing: 'Not translated', draft: 'Draft', needs_review: 'Source changed', reviewed: 'Reviewed' };
export function translationField(key: string) {
  if (key === 'name') return { label: 'Name', maxLength: 250, multiline: false };
  if (key === 'description') return { label: 'Description', maxLength: 10000, multiline: true };
  if (key === 'label') return { label: 'Label', maxLength: 250, multiline: false };
  if (key.startsWith('option.')) return { label: `Option · ${key.slice(7)}`, maxLength: 250, multiline: false };
  if (key.startsWith('attribute.')) return { label: key.slice(10), maxLength: 10000, multiline: true };
  if (key === 'title') return { label: 'Menu title', maxLength: 200, multiline: false };
  const match = /^item\.(\d+)(?:\.link\.(\d+))?\.(label|badge|group|description)$/.exec(key);
  if (!match) return null;
  const [, item, link, field] = match;
  const names: Record<string, string> = { label: 'Label', badge: 'Badge', group: 'Column heading', description: 'Description' };
  return { label: `Menu item ${Number(item) + 1}${link === undefined ? '' : ` · Link ${Number(link) + 1}`} · ${names[field]}`, maxLength: field === 'badge' ? 40 : field === 'description' ? 200 : 100, multiline: field === 'description' };
}
export function translatableEntries(source: Record<string, string>) {
  return Object.entries(source).filter(([key]) => translationField(key)).sort(([a], [b]) => {
    if (a === 'title' || a === 'name') return -1;
    if (b === 'title' || b === 'name') return 1;
    const parentA = a.split('.').slice(0, -1).join('.');
    const parentB = b.split('.').slice(0, -1).join('.');
    const order: Record<string, number> = { label: 0, badge: 1, group: 1, description: 2 };
    return parentA.localeCompare(parentB, 'en', { numeric: true }) || (order[a.split('.').at(-1)!] ?? 0) - (order[b.split('.').at(-1)!] ?? 0) || a.localeCompare(b, 'en', { numeric: true });
  });
}
export function translationComplete(source: Record<string, string>, fields: Record<string, string>) {
  return translatableEntries(source).every(([key, value]) => !value.trim() || !!fields[key]?.trim());
}
