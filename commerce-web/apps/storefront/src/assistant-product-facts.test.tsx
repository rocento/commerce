import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantProductFacts, attributeValue } from './assistant-product-facts';
it('displays catalog arrays and encoded arrays as readable values', () => {
  expect(attributeValue('["wifi","5g","usb_c"]')).toBe('wifi, 5g, usb c');
  expect(attributeValue(['silver', 'gold'])).toBe('silver, gold');
  expect(attributeValue(false)).toBe('No');
  expect(attributeValue(null)).toBe('Not provided');
  expect(attributeValue({ material_type: 'gold', recycled: true })).toBe('material type: gold; recycled: Yes');
});
it('renders semantic attribute/value rows and escapes catalog text', () => {
  const html = renderToStaticMarkup(<AssistantProductFacts facts={[{name:'connectivity_features',value:'["wifi","bluetooth"]'},{name:'brand',value:'<script>bad</script>'}]} />);
  expect(html).toContain('<dt>connectivity features</dt><dd>wifi, bluetooth</dd>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});
