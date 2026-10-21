import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { type CatalogImage } from '@commerce/api-client';
import { PublicationImage, PublicImages, PublicPrimaryImage } from './public/image';
import { StorefrontImage, StorefrontImages } from './storefront-image';

const id = 'dd688e36-7062-45c6-968d-696f0829faa6';
const image: CatalogImage = { id, alt: 'Ring', width: 1024, height: 1024, variants: [{ width: 480, height: 480 }, { width: 960, height: 960 }] };

it('uses theme metadata for a private SPA hero without changing public page semantics', () => {
  const html = renderToStaticMarkup(<StorefrontImages.Provider value={{ [id]: image }}><PublicationImage id={id} alt="Gold ring" primary sizes="100vw" /></StorefrontImages.Provider>);
  expect(html).toContain('srcSet=');
  expect(html).toContain('?width=960 960w');
  expect(html).toContain('width="1024" height="1024"');
  expect(html).toContain('loading="eager" fetchPriority="high"');
  expect(html).toContain('sizes="100vw"');
});
it('uses the matching product/category projection and preserves its lazy loading', () => {
  const html = renderToStaticMarkup(<StorefrontImage id={id} metadata={image} alt="Ring" sizes="50vw" loading="lazy" />);
  expect(html).toContain('?width=480 480w');
  expect(html).toContain('loading="lazy"');
  expect(renderToStaticMarkup(<StorefrontImage id={id} alt="Unprocessed ring" />)).not.toContain('srcSet');
});
it('retains public snapshot priority and excludes media outside that snapshot', () => {
  const html = renderToStaticMarkup(<PublicImages.Provider value={{ [id]: image }}><PublicPrimaryImage.Provider value={id}><PublicationImage id={id} alt="Gold ring" primary /></PublicPrimaryImage.Provider></PublicImages.Provider>);
  expect(html).toContain('fetchPriority="high"');
  expect(renderToStaticMarkup(<PublicImages.Provider value={{}}><PublicationImage id={id} alt="Hidden" primary /></PublicImages.Provider>)).toBe('');
});
