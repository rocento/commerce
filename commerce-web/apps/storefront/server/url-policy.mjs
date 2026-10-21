export const publicPath = path => path === '/' || /^\/(products|categories|pages)\/[A-Za-z0-9_-]{1,200}$/.test(path);
// Decode once, forbid encoded separators and dot segments, then resolve the resource before redirecting.
export function decodedRequestPath(raw) {
  const wire = raw.split('?')[0];
  if (!wire.startsWith('/') || wire.startsWith('//') || /%(?:2f|5c)/i.test(wire)) return null;
  let decoded;
  try { decoded = decodeURIComponent(wire); } catch { return null; }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) return null;
  if (/[\u0000-\u001f\u007f]/u.test(decoded)) return null;
  return decoded;
}
export function publicTarget(raw) {
  const decoded = decodedRequestPath(raw);
  if (decoded === null) return null;
  const path = (decoded.replace(/\/+$/, '') || '/').toLowerCase();
  if (!publicPath(path)) return null;
  const params = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');
  const seen = new Set(); let page = 1, locale = null;
  for (const [key, value] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === 'page') {
      if (!/^0*[1-9][0-9]*$/.test(value) || value.length > 8 || Number(value) > 10000) return null;
      page = Number(value);
    } else if (['lang', 'locale'].includes(key)) {
      if (locale !== null || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(value)) return null;
      locale = value;
    } else if (!/^utm_[a-z_]+$/.test(key) && !['gclid','fbclid','msclkid','campaign'].includes(key)) return null;
  }
  if (page > 1 && path !== '/' && !path.startsWith('/categories/')) return null;
  return { path, page, locale };
}
export function canonicalTarget(path, page) { return path + (page > 1 ? `?page=${page}` : ''); }
export function validDestination(path) {
  if (typeof path !== 'string') return false;
  const target = publicTarget(path);
  return target !== null && path === canonicalTarget(target.path,target.page);
}
