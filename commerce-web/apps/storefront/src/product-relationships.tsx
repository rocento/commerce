import { useQuery } from '@tanstack/react-query';
import { relationshipsApi, type RelationshipKind, type Customer } from '@commerce/api-client';
import { ProductCard } from './catalog';
import { useInterface } from './interface-locale';
import { useDeliveryKey } from './locations';
export function ProductRelationships({ sources, kind, customer, customerId }: {
    sources: string[];
    kind: RelationshipKind;
    customer?: Customer | null;
    customerId?: string;
}) {
    const { locale } = useInterface();
    const delivery = useDeliveryKey();
    const key = [...new Set(sources)].sort().join(',');
    const q = useQuery({ queryKey: ['product-relationships', kind, key, delivery, locale, customer?.id ?? customerId ?? 'guest'], queryFn: () => relationshipsApi.products(key.split(','), kind, locale), enabled: !!key && sources.length <= 50, staleTime: 0, retry: 1 });
    if (!q.data?.length)
        return null;
    const title = locale === 'ar' ? { related: 'منتجات ذات صلة', upsell: 'خيارات أخرى قد تعجبك', cross_sell: 'أكمل طلبك' }[kind] : { related: 'Related products', upsell: 'More options to consider', cross_sell: 'Complete your order' }[kind];
    return <section className="product-relationships" aria-label={title}><h2>{title}</h2><div className="product-grid">{q.data.map(p => <ProductCard key={p.id} product={p} customer={customer}/>)}</div></section>;
}
