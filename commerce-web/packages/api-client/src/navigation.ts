import type { Category } from './catalog';
import type { ContentBlock } from './identity';

export function safeNavigationUrl(url: string): boolean {
  if (/[\\\s\u0000-\u001f\u007f]/.test(url)) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

/** The category bar and its initial editable draft share destinations and order. */
export function categoryNavigation(categories: Category[], shopAll = 'Shop all'): ContentBlock[] {
  const link = (label: string, url: string): ContentBlock => ({
    kind: 'link', heading: '', text: '', image_id: null, link_label: label, link_url: url,
    navigation: { icon: '', badge: '', enabled: true, new_tab: false, columns: 3, links: [] },
  });
  return [link(shopAll, '/search'), ...categories.filter(category => !category.parent_id)
    .map(category => link(category.name, `/categories/${encodeURIComponent(category.slug || category.id)}`))];
}

export function navigationErrors(blocks: ContentBlock[]): string[] {
  const errors: string[] = [];
  if (!blocks.length) errors.push('Add at least one menu item.');
  if (blocks.length > 30) errors.push('A menu can contain up to 30 items.');
  if (blocks.length && !blocks.some(block => block.navigation?.enabled)) errors.push('Make at least one menu item visible.');
  blocks.forEach((block, index) => {
    const name = `Menu item ${index + 1}`;
    if (!block.link_label.trim()) errors.push(`${name}: enter a label.`);
    if (!safeNavigationUrl(block.link_url)) errors.push(`${name}: use a store path beginning with / or a secure https:// URL.`);
    if (!block.navigation) { errors.push(`${name}: navigation settings are missing.`); return; }
    if (![1, 2, 3, 4].includes(block.navigation.columns)) errors.push(`${name}: choose one to four columns.`);
    if (block.navigation.links.length > 40) errors.push(`${name}: use no more than 40 dropdown links.`);
    block.navigation.links.forEach((link, child) => {
      if (!link.label.trim()) errors.push(`${name}, dropdown link ${child + 1}: enter a label.`);
      if (!safeNavigationUrl(link.url)) errors.push(`${name}, dropdown link ${child + 1}: enter a safe destination.`);
    });
  });
  return errors;
}
