import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { CommerceClient, LiveProduct, Locale } from '../core/commerce';
import { Button, Copy } from './Storefront';

export function ProductRelationships({ client, sources, kind, locale, open, disabled }: {
  client: CommerceClient; sources: string[]; kind: 'related' | 'upsell' | 'cross_sell'; locale: Locale;
  open: (id: string) => void; disabled: boolean;
}) {
  const source = [...new Set(sources)].sort().join(',');
  const context = JSON.stringify([source, sources.length, kind, locale, client.customer?.id, client.pin]);
  const [result, setResult] = useState<{ context: string; products: LiveProduct[]; failed: boolean }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    if (source && sources.length <= 50) void client.relationships(source.split(','), kind).then(products => {
      if (current) setResult({ context, products, failed: false });
    }, () => { if (current) setResult({ context, products: [], failed: true }); });
    return () => { current = false; };
  }, [client, context, retry]);
  if (result?.context !== context || (!result.failed && !result.products.length)) return null;
  const title = locale === 'ar' ? { related: 'منتجات ذات صلة', upsell: 'خيارات أخرى قد تعجبك', cross_sell: 'أكمل طلبك' }[kind] : { related: 'Related products', upsell: 'More options to consider', cross_sell: 'Complete your order' }[kind];
  return <View style={{ gap: 12 }}>
    <Copy accessibilityRole="header" style={{ fontSize: 18, fontWeight: '600' }}>{title}</Copy>
    {result.failed ? <Button title={locale === 'ar' ? 'إعادة المحاولة' : 'Retry'} secondary disabled={disabled} onPress={() => setRetry(v => v + 1)} /> : result.products.map(product => <Button key={product.id} title={`${product.name} · ${product.price} ${product.currency}${product.in_stock ? '' : locale === 'ar' ? ' · غير متوفر' : ' · Out of stock'}`} secondary disabled={disabled} onPress={() => open(product.id)} />)}
  </View>;
}
