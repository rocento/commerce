import { useEffect, useMemo, useState } from 'react';
import { mobileApi, MobileApiError, type MobileCatalog, type MobileConfig } from '@commerce/api-client';
export type CatalogResult = { data?: MobileCatalog; error?: string };
export function catalogError(error: unknown) {
  if (error instanceof MobileApiError) {
    if (error.issues.some(i => i.code === 'CATALOG_NOT_CONNECTED')) return 'This merchant has no catalog connection.';
    if (error.issues.some(i => i.code === 'COLLECTION_NOT_FOUND')) return 'This collection was not found in the merchant catalog.';
    if (error.status === 403 || error.status === 401) return 'Catalog access is unavailable. Check your merchant access.';
  }
  return 'The merchant catalog could not be loaded. Please retry.';
}
export function useMobileCatalog(config: MobileConfig, locale: 'en' | 'ar', browsingCollection?: string, enabled = true, refreshVersion = 0) {
  const collections = JSON.stringify([...new Set([...config.screens.home.sections.flatMap(s => 'collectionId' in s.props ? [s.props.collectionId] : []), ...(browsingCollection ? [browsingCollection] : [])])].sort());
  const [retry, setRetry] = useState(0);
  const key = `${config.tenantId}:${locale}:${collections}:${retry}:${refreshVersion}`;
  const [state, setState] = useState<{ key: string; results: Record<string, CatalogResult> }>({ key: '', results: {} });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const results: Record<string, CatalogResult> = {};
    setState({ key, results });
    // Bound parallelism even for a 30-section home screen.
    const queue: (string | null)[] = [null, ...JSON.parse(collections) as string[]];
    async function worker() {
      while (queue.length && !controller.signal.aborted) {
        const collection = queue.shift()!;
        const resultKey = collection === null ? '__catalog__' : collection;
        let result: CatalogResult;
        try {
          if (collection !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(collection)) throw new MobileApiError('Invalid collection', 422, [{path:'/collection',code:'COLLECTION_NOT_FOUND'}]);
          const data = await mobileApi.catalog(config.tenantId, locale, collection === null ? undefined : collection, controller.signal);
          if (data.merchantId !== config.tenantId || data.locale !== locale) throw new Error('Catalog scope mismatch');
          result = { data };
        } catch (error) { result = { error: catalogError(error) }; }
        if (controller.signal.aborted) return;
        results[resultKey] = result;
        setState({ key, results: { ...results } });
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    return () => controller.abort();
  }, [config.tenantId, locale, collections, key, enabled]);
  const results = useMemo(() => state.key === key ? state.results : {}, [state, key]);
  return { results, revision: retry, refresh: () => setRetry(v => v + 1) };
}
