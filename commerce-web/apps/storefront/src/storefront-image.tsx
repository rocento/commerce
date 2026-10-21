import { createContext, useContext, type ImgHTMLAttributes } from 'react';
import { mediaImageProps, type CatalogImage } from '@commerce/api-client';

export const StorefrontImages = createContext<Record<string, CatalogImage>>({});
export const productCardImageSizes = '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw';
export const productDetailImageSizes = '(max-width: 650px) 100vw, 50vw';

/** The caller provides metadata from the same theme/category/product response. */
export function StorefrontImage({ id, metadata, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'id' | 'src' | 'srcSet'> & { id: string; metadata?: CatalogImage }) {
  const images = useContext(StorefrontImages);
  return <img decoding="async" {...props} {...mediaImageProps(id, metadata || images[id])} />;
}
