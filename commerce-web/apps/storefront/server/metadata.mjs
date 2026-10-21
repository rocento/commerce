const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function metadataHead(s) {
  const m = s.metadata;
  if (!m || typeof m.title !== 'string' || typeof m.description !== 'string') throw new Error('Missing resolved metadata');
  const title = s.status === 410 ? 'Page permanently removed' : s.status === 404 ? 'Page not found' : m.title;
  const meta = (key, value, property = false) => `<meta ${property ? 'property' : 'name'}="${key}" content="${escape(value)}"/>`;
  let head = `<title>${escape(title)}</title>${meta('description', s.status === 200 ? m.description : '')}${meta('robots', s.robots)}`;
  if (s.status !== 200) return head;
  if (s.canonical) head += `<link rel="canonical" href="${escape(s.canonical.html)}"/>${meta('og:url', s.canonical.html, true)}`;
  head += meta('og:title', title, true) + meta('og:description', m.description, true) + meta('og:type', 'website', true) + meta('og:site_name', s.site_name, true);
  // A language-only locale does not justify inventing a country code for Open Graph.
  if (/^[a-z]{2}-[A-Z]{2}$/.test(s.locale)) head += meta('og:locale', s.locale.replace('-', '_'), true);
  head += meta('twitter:card', 'summary') + meta('twitter:title', title) + meta('twitter:description', m.description);
  const image = m.image && s.images?.[m.image];
  if (image && /^[0-9a-f-]{36}$/.test(image.id) && image.width > 0 && image.height > 0) {
    const url = new URL(`/api/v1/catalog/media/${image.id}/content`, s.origin).href;
    head += meta('og:image', url, true) + meta('og:image:width', image.width, true) + meta('og:image:height', image.height, true) + meta('og:image:alt', image.alt || title, true) + meta('twitter:image', url) + meta('twitter:image:alt', image.alt || title);
  }
  return head;
}
