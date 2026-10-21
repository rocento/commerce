// Defense-in-depth parity check before serializing the trusted gateway snapshot.
export function structuredDataScript(s) {
  if (s.structured_data == null) return '';
  const data = s.structured_data;
  if (s.status !== 200 || !s.canonical || data['@context'] !== 'https://schema.org' || !Array.isArray(data['@graph'])) throw new Error('Invalid structured data context');
  const merchant = data['@graph'].find(node => node['@type'] === 'Organization');
  if (merchant?.name !== s.site_name || merchant?.['@id'] !== `${s.origin}#merchant` || merchant?.url !== s.origin) throw new Error('Merchant mismatch');
  function validate(p, node, url) {
    if (!node || node.name !== p.name || node.description !== p.description || node.url !== url || node['@id'] !== `${url}#product`) throw new Error('Product facts mismatch');
    if (p.offer_eligible) {
      if (node.offers?.price !== p.price || node.offers?.priceCurrency !== p.currency || node.offers?.url !== url || node.offers?.seller?.['@id'] !== merchant['@id']) throw new Error('Offer mismatch');
    } else if (node.offers) throw new Error('Unsupported offer');
    if (node.offers?.availability) throw new Error('Unresolved regional availability');
  }
  if (s.product) {
    const product = data['@graph'].find(node => node['@id'] === `${s.canonical.json_ld}#product`);
    validate(s.product, product, s.canonical.json_ld);
    for (const variant of product.hasVariant || []) {
      const p = s.family.find(p => s.related_canonicals[p.id]?.json_ld === variant.url);
      if (!p) throw new Error('Unknown variant');
      validate(p, variant, s.related_canonicals[p.id].json_ld);
    }
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script id="publication-jsonld" type="application/ld+json">${json}</script>`;
}
