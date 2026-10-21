import { createContext, useContext, type ImgHTMLAttributes } from 'react';
import { mediaImageProps } from '@commerce/api-client';
import type { PublicImage } from './types';
import { StorefrontImage } from '../storefront-image';
export const PublicPrimaryImage = createContext<string | null>(null);
export const PublicImages = createContext<Record<string, PublicImage> | null>(null);
export function PublicationImage({ id, alt, primary = false, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'id' | 'src' | 'srcSet' | 'width' | 'height'> & { id: string; primary?: boolean }) {
  const images = useContext(PublicImages);
  const primaryId = useContext(PublicPrimaryImage);
  const prioritized = primary && id === primaryId;
  // Existing private theme/editor rendering retains its original source.
  if (images === null) return <StorefrontImage {...props} id={id} alt={alt || ''} loading={primary ? 'eager' : 'lazy'} fetchPriority={primary ? 'high' : 'auto'} />;
  const image = images[id];
  if (!image) return null;
  return <img decoding="async" {...props} {...mediaImageProps(id, image)} alt={alt?.trim() || image.alt} sizes={props.sizes || '(max-width: 640px) 100vw, 50vw'} loading={prioritized ? 'eager' : 'lazy'} fetchPriority={prioritized ? 'high' : 'auto'} />;
}
