import { useEffect, useState, type ReactNode } from 'react';
import { catalogApi, mediaUrl, type BestsellerPeriod, type Product } from '@commerce/api-client';
import { bestsellerDescription } from '../bestsellers';
import { CatalogPrice } from '../product-price';
import { useDeliveryKey } from '../use-delivery-key';
import { useInterface } from '../interface-locale';

type Result = { key: string; products: Product[]; scope: 'delivery_area' | 'global' };

export function PublicBestsellers({ heading, period, limit, locale, children }: {
  heading: string; period: BestsellerPeriod; limit: number; locale: string; children: ReactNode;
}) {
  const { t: ui } = useInterface();
  const delivery = useDeliveryKey();
  const requestKey = JSON.stringify([delivery, period, limit, locale]);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (delivery === 'none') return;
    let cancelled = false;
    void catalogApi.bestsellers(period, limit, locale).then(response => {
      if (!cancelled) setResult({ ...response, key: requestKey });
    }).catch(() => { /* Retain the published global ranking on read failure. */ });
    return () => { cancelled = true; };
  }, [delivery, period, limit, locale, requestKey]);
  if (!result || result.key !== requestKey) return <>{children}</>;
  return <section className="theme-section"><h2>{heading}</h2><p>{bestsellerDescription(period, result.scope)}</p>
    {!result.products.length ? <p>{ui('storefront.no_best_sellers_for_this_period_yet', 'No best sellers for this period yet.')}</p> :
      <div className="theme-grid product-grid">{result.products.map(product => <article className="product-card" key={product.id}>
        <a href={`/products/${product.slug}`}>{product.media_ids[0] && <img src={mediaUrl(product.media_ids[0])} alt={product.name} loading="lazy" decoding="async" />}<h3>{product.name}</h3></a>
        <p>{product.product_type === 'simple' ? <CatalogPrice product={product} /> : 'Choose options for pricing'}</p>
      </article>)}</div>}
    <a href="/search">{ui('storefront.browse_all_products', 'Browse all products')}</a>
  </section>;
}
