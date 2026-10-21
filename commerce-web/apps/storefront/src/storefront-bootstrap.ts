import { ApiError, catalogApi, customerApi, deliveryKey, mediaImageProps, type Customer } from "@commerce/api-client";
import type { QueryClient } from "@tanstack/react-query";
import { productDetailImageSizes } from './storefront-image';

export type InitialSession = { customer: Customer | null; error?: unknown };

// The viewer and delivery pin are part of the cache identity: never reuse a
// guest/other-customer price just because the same product was recently loaded.
export function productQuery(id: string, delivery: string, customerId?: string, locale = "en") {
  return {
    queryKey: ["product", id, delivery, customerId ?? "guest", locale],
    queryFn: () => catalogApi.product(id, locale),
    staleTime: 10_000,
  };
}

export function startStorefront(
  client: QueryClient,
  pathname: string,
  preloadImage: (url: string, responsive?: { srcSet: string; sizes: string }) => void,
): Promise<InitialSession> {
  // Start session restoration alongside the theme, not after ThemeProvider
  // releases its loading screen. Always settle to avoid an unhandled rejection
  // if the theme fails and App never mounts.
  const session = customerApi.restore().then<InitialSession, InitialSession>(
    customer => ({ customer }),
    error => ({ customer: null, error }),
  );
  const match = /^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(pathname);
  if (match) {
    void client.prefetchQuery({ queryKey: ["categories", "en"], queryFn: () => catalogApi.categories() });
    void session.then(({ customer, error }) => {
      // A failed account service must not warm personalized data as a guest.
      if (error && !(error instanceof ApiError && error.status === 401)) return;
      return client.fetchQuery(productQuery(match[1], deliveryKey(), customer?.id))
        .then(product => {
          const id = product.media_ids[0];
          if (id) {
            const image = mediaImageProps(id, product.images?.[id]);
            if (image.srcSet) preloadImage(image.src, { srcSet: image.srcSet, sizes: productDetailImageSizes });
            else preloadImage(image.src);
          }
        });
    }).catch(() => {
      // The route owns the error UI and can retry a failed speculative request.
    });
  }
  return session;
}
