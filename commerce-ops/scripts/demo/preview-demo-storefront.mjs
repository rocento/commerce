// Local, read-only preset preview using the real storefront build. No database or upstream.
// node scripts/preview-demo-storefront.mjs pharmacy [port] [storefront-dist]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const name = process.argv[2] || 'pharmacy';
if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid preset');
const dist = resolve(process.argv[4] || resolve(root, 'commerce-web/apps/storefront/dist'));
await readFile(resolve(dist, 'index.html'));
const preset = JSON.parse(await readFile(resolve(root, `commerce-demo/${name}/preset.json`), 'utf8'));
const uuid = (group, index) => `${group}0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const media = new Map();
function asset(path) {
  const absolute = resolve(root, 'commerce-assets/demo', path);
  if (!absolute.startsWith(resolve(root, 'commerce-assets/demo') + '/')) throw new Error('Invalid asset');
  if (!media.has(path)) media.set(path, { id: uuid('3', media.size), path: absolute });
  return media.get(path).id;
}
const categories = preset.categories.map((c, i) => ({ ...c, id: uuid('1', i), parent_id: null, thumbnail: c.thumbnail ? asset(c.thumbnail) : null, attributes: {} }));
const products = preset.products.map((p, i) => ({ ...p, id: uuid('2', i), active: true, in_stock: true, currency: 'USD', product_type: 'simple', parent_id: null, category_id: categories.find(c => c.slug === p.category).id, media_ids: p.images.map(asset), images: {} }));
const configuration = JSON.parse(await readFile(resolve(root, `commerce-demo/${name}/theme.json`), 'utf8'), (_key, value) => {
  if (typeof value !== 'string') return value;
  if (value.startsWith('asset:')) return asset(value.slice(6));
  if (value.startsWith('category:')) return categories.find(c => c.slug === value.slice(9)).id;
  if (value.startsWith('category-link:')) return '/categories/' + categories.find(c => c.slug === value.slice(14)).id;
  return value;
});
const catalog = JSON.parse(await readFile(resolve(root, 'commerce-web/apps/storefront/src/interface-messages.json'), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const send = (body, status = 200, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const locale = String(req.headers['x-storefront-locale'] || 'en');
    const translations = preset.translations?.[locale];
    const localizedProducts = products.map(p => ({ ...p, ...translations?.products?.[p.sku] }));
    const localizedCategories = categories.map(c => ({ ...c, ...translations?.categories?.[c.slug] }));
    if (path.startsWith('/api/')) {
      if (path.includes('/auth/')) return send({ error: 'Read-only demo preview; accounts require a seeded installation.' }, 401);
      if (req.method !== 'GET') return send({ error: 'Read-only demo preview; shopping requires a seeded installation.' }, 501);
      const image = /^\/api\/v1\/catalog\/media\/([a-f0-9-]+)\/content$/.exec(path);
      if (image) {
        const item = [...media.values()].find(m => m.id === image[1]);
        return item ? send(await readFile(item.path), 200, mime[extname(item.path)]) : send({ error: 'Not found' }, 404);
      }
      if (path.includes('/theme/')) return send({ configuration, cities: [], version_id: null });
      if (path.endsWith('/languages/interface')) return send({ revision: 1, catalog_version: 'preview', overrides: [], messages: catalog.messages.map(m => ({ plural: null, ...m })) });
      if (path.endsWith('/languages')) return send({ source_locale: 'en', languages: (preset.languages || []).map(l => ({ ...l, revision: 1 })) });
      if (path.endsWith('/catalog/categories')) return send(localizedCategories);
      if (path.endsWith('/catalog/attribute-definitions')) {
        const labels = preset.translations?.[url.searchParams.get('locale') || locale]?.attributes || {};
        return send(preset.attributes.map((d, i) => ({ ...d, id: uuid('5', i),
          label: labels[d.attribute_code]?.label || d.label,
          options: d.options.map(o => ({ ...o, label: labels[d.attribute_code]?.['option.' + o.value] || o.label })) })));
      }
      if (path.endsWith('/category-availability')) return send(Object.fromEntries(categories.map(c => [c.id, products.filter(p => p.category_id === c.id).length])));
      if (path.endsWith('/search')) {
        const category = url.searchParams.get('category_id');
        const query = (url.searchParams.get('q') || '').toLowerCase();
        let hits = localizedProducts.filter(p => (!category || p.category_id === category) && (!query || `${p.name} ${p.description}`.toLowerCase().includes(query)));
        const filters = JSON.parse(url.searchParams.get('attribute_filters') || '{}');
        hits = hits.filter(p => Object.entries(filters).every(([code, value]) => (Array.isArray(value) ? value : [value]).includes(p.attributes[code]))
          && (!url.searchParams.has('min_price') || Number(p.price) >= Number(url.searchParams.get('min_price')))
          && (!url.searchParams.has('max_price') || Number(p.price) <= Number(url.searchParams.get('max_price'))));
        const facets = Object.fromEntries(preset.attributes.filter(d => d.is_filterable).map(d => [d.attribute_code,
          Object.fromEntries(d.options.map(o => [o.value, hits.filter(p => p.attributes[d.attribute_code] === o.value).length]))]));
        const sort = url.searchParams.get('sort_by');
        if (sort === 'price' || sort === 'name') hits.sort((a, b) => (sort === 'price' ? Number(a.price) - Number(b.price) : a.name.localeCompare(b.name, locale)) * (url.searchParams.get('sort_order') === 'desc' ? -1 : 1));
        return send({ hits: hits.slice(Number(url.searchParams.get('offset') || 0), Number(url.searchParams.get('offset') || 0) + Number(url.searchParams.get('limit') || 100)), total: hits.length, facets });
      }
      if (path.endsWith('/family')) return send({ structure: { product_type: 'simple', configurable_attributes: [], children: [] }, children: [] });
      if (path.includes('/catalog/products/')) {
        const product = localizedProducts.find(p => p.id === path.split('/').pop() || p.slug === path.split('/').pop());
        return product ? send(product) : send({ error: 'Not found' }, 404);
      }
      if (path.endsWith('/cart')) return send({ id: uuid('4', 1), items: [], subtotal: '0', total: '0', currency: 'USD' });
      if (path.endsWith('/delivery-area')) return send({ configured: false, deliverable: true });
      if (path.endsWith('/capabilities')) return send({ geo_fencing_enabled: false });
      if (path.includes('/content/')) return send({ error: 'Not found' }, 404);
      return send([]);
    }
    let file = resolve(dist, '.' + decodeURIComponent(path));
    if (file !== dist && !file.startsWith(dist + '/')) return send({ error: 'Not found' }, 404);
    let bytes;
    try { bytes = await readFile(file); } catch {
      if (extname(file)) return send({ error: 'Not found' }, 404);
      file = resolve(dist, 'index.html'); bytes = await readFile(file);
    }
    if (extname(file) === '.html') bytes = Buffer.from(bytes.toString().replace('<body>', '<body><div style="padding:7px 16px;background:#111;color:#e4b8b5;text-align:center;font:11px system-ui;letter-spacing:.08em">DESIGN PREVIEW · معاينة التصميم · Checkout unavailable / الشراء غير متاح</div>'));
    send(bytes, 200, mime[extname(file)] || 'application/octet-stream');
  } catch { send({ error: 'Preview unavailable' }, 500); }
}).listen(Number(process.argv[3] || 5473), '127.0.0.1', () => console.log(`${name} read-only preview: http://127.0.0.1:${process.argv[3] || 5473}`));
