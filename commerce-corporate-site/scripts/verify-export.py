"""Validate static route, anchor, asset and metadata integrity after build."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1] / 'out'
class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.ids, self.links, self.assets, self.meta = set(), [], [], {}
        self.h1 = 0
        self.canonical = None
        self.json_ld, self._json_buffer = [], None
        self.feed(source)
    def handle_starttag(self, tag, attributes):
        a = dict(attributes)
        if 'id' in a:
            assert a['id'] not in self.ids, f"Duplicate id: {a['id']}"
            self.ids.add(a['id'])
        if tag == 'h1': self.h1 += 1
        if tag == 'a' and 'href' in a: self.links.append(a['href'])
        if tag in ('img', 'script') and 'src' in a: self.assets.append(a['src'])
        if tag == 'img': assert 'alt' in a, 'Image missing alt text'
        if tag == 'meta': self.meta[a.get('name', a.get('property'))] = a.get('content')
        if tag == 'link' and a.get('rel') == 'canonical': self.canonical = a['href']
        if tag == 'script' and a.get('type') == 'application/ld+json': self._json_buffer = []
    def handle_data(self, data):
        if self._json_buffer is not None: self._json_buffer.append(data)
    def handle_endtag(self, tag):
        if tag == 'script' and self._json_buffer is not None:
            self.json_ld.append(json.loads(''.join(self._json_buffer)))
            self._json_buffer = None

# The isolated Swagger viewer has its own security/browser checks and is not an SEO page.
viewer = root / 'docs/api/reference/index.html'
assert viewer.exists(), 'API reference viewer missing'
assert (root / 'docs/api/openapi.json').exists(), 'Public OpenAPI contract missing'
for asset in ('swagger-ui-bundle.js', 'swagger-ui.css'):
    assert (viewer.parent / 'vendor' / asset).exists(), f'API viewer asset missing: {asset}'
pages = {p: Page(p.read_text()) for p in root.rglob('*.html') if p != viewer}
for path, page in pages.items():
    assert page.h1 == 1, (path, 'Expected one h1')
    assert page.meta.get('description'), (path, 'Description missing')
    if '404' not in str(path) and '_not-found' not in str(path):
        assert page.canonical, (path, 'Canonical missing')
        assert page.meta.get('og:title'), (path, 'Open Graph title missing')
        assert page.meta.get('og:description'), (path, 'Open Graph description missing')
    for href in page.links + page.assets:
        url = urlsplit(href)
        if url.scheme or url.netloc: continue
        target = (root / unquote(url.path.lstrip('/'))) if url.path else path
        if target.is_dir(): target /= 'index.html'
        assert target.exists(), (path, 'Missing target', href)
        if url.fragment and target in pages:
            assert unquote(url.fragment) in pages[target].ids, (path, 'Missing anchor', href)
assert (root / 'sitemap.xml').exists()
assert (root / 'robots.txt').exists()
assert (root / 'llms.txt').exists() and '# Rocento' in (root / 'llms.txt').read_text()
llms_links = re.findall(r'\[[^\]]+\]\((https?://[^\s)]+)\)', (root / 'llms.txt').read_text())
assert llms_links, 'llms.txt must contain Markdown links for agent discovery'
for href in llms_links:
    target = root / urlsplit(href).path.lstrip('/')
    if target.is_dir(): target /= 'index.html'
    assert target.exists(), ('llms.txt references missing route', href)

site_urls = {node.text for node in ET.parse(root / 'sitemap.xml').iter() if node.tag.endswith('loc')}
expected_paths = {str(path.parent.relative_to(root)).replace('.', '').strip('/') for path in pages if '404' not in str(path) and '_not-found' not in str(path)}
for route in expected_paths:
    suffix = '/' if not route else f'/{route}/'
    assert any(url.endswith(suffix) for url in site_urls), ('Sitemap missing route', route)
for path in root.glob('knowledge/*/index.html'):
    assert any(data.get('@type') == 'Article' and data.get('headline') for data in pages[path].json_ld)
for path in list(root.glob('features/*/index.html')) + list(root.glob('industries/*/index.html')) + list(root.glob('docs/*/index.html')):
    assert any(data.get('@type') == 'BreadcrumbList' for data in pages[path].json_ld)
home_graphs = [item for data in pages[root / 'index.html'].json_ld for item in data.get('@graph', [])]
assert {'Organization', 'SoftwareApplication'} <= {item.get('@type') for item in home_graphs}
print(f'PASS: {len(pages)} exported HTML pages; links, anchors, assets, metadata, sitemap, llms.txt and structured data.')
