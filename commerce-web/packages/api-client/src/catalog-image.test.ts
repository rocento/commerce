import { expect, it } from 'vitest';
import { mediaImageProps, mediaUrl, type CatalogImage } from './catalog';

const id = 'dd688e36-7062-45c6-968d-696f0829faa6';
const image: CatalogImage = { id, alt: 'Ring', width: 1024, height: 1024, variants: [{ width: 480, height: 480 }, { width: 960, height: 960 }] };

it('advertises the stored WebP candidates and intrinsic dimensions', () => {
  expect(mediaImageProps(id, image)).toEqual({
    src: mediaUrl(id), width: 1024, height: 1024,
    srcSet: `${mediaUrl(id)}?width=480 480w, ${mediaUrl(id)}?width=960 960w, ${mediaUrl(id)} 1024w`,
  });
});
it('keeps original media usable when metadata is missing or belongs to another image', () => {
  expect(mediaImageProps(id)).toEqual({ src: mediaUrl(id) });
  expect(mediaImageProps(id, { ...image, id: 'another-image' })).toEqual({ src: mediaUrl(id) });
  expect(mediaImageProps(id, { ...image, width: 0 })).toEqual({ src: mediaUrl(id) });
});
it('never invents unavailable variants or requests unsupported widths', () => {
  expect(mediaImageProps(id, { ...image, variants: [] })).toEqual({ src: mediaUrl(id), width: 1024, height: 1024 });
  const props = mediaImageProps(id, { ...image, width: 480, variants: [{ width: 960, height: 960 }, { width: 320, height: 320 }] });
  expect(props.srcSet).toBeUndefined();
});
it('keeps high-density screens on compressed original-resolution WebP and deduplicates candidates', () => {
  const props = mediaImageProps(id, { ...image, variants: [...image.variants, { width: 1024, height: 1024 }, { width: 480, height: 480 }] });
  expect(props.src).toBe(`${mediaUrl(id)}?width=1024`);
  expect(props.srcSet).toBe(`${mediaUrl(id)}?width=480 480w, ${mediaUrl(id)}?width=960 960w, ${mediaUrl(id)}?width=1024 1024w`);
});
