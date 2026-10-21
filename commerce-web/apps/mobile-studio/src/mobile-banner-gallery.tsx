import { useEffect, useRef, useState } from 'react';
import type { MobileSection } from '@commerce/api-client';

export function MobileBannerGallery({ section, label, url, open }: { section: Extract<MobileSection, { type: 'heroBanner' }>; label: string; url: (id: string) => string | undefined; open: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(350);
  const images = [section.props.imageAssetId, ...(section.props.additionalImageAssetIds || [])];
  const portrait = section.props.layout === 'portrait';
  const cardWidth = width * (images.length > 1 ? portrait ? 0.78 : 0.88 : 1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = portrait && images.length >= 3 ? (getComputedStyle(el).direction === 'rtl' ? -1 : 1) * (cardWidth + 12) : 0;
  }, [cardWidth, section.id, portrait, images.length]);
  return <div ref={ref} className={`ms-banner-gallery ms-banner-${section.props.layout}`} role="region" aria-label={label} tabIndex={0} style={{ paddingInline: (width - cardWidth) / 2 }}>
    {images.map((id, index) => <button key={`${id}-${index}`} type="button" className="ms-banner-slide" style={{ flexBasis: cardWidth, flexShrink: 0 }} aria-label={`${label} · ${index + 1}`} onClick={open}>
      {url(id) ? <img src={url(id)} alt="" decoding="async" style={{ objectFit: section.props.imageFit || 'cover' }} /> : <span>{label}</span>}
    </button>)}
  </div>;
}
