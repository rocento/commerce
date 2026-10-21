import { deliveryHeaders } from "./delivery";

// Keep the optional tracing SDK out of every storefront's initial bundle.
const endpoint = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_OTEL_ENDPOINT;
export function createTraceFetch(endpoint?: string): typeof fetch {
  let tracedFetch: Promise<(request: Request) => Promise<Response>> | undefined;
  return async (input, init) => {
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (typeof location !== "undefined" && target.origin === location.origin && /^\/api\/v1\/(catalog|search|inventory|cart)(\/|$)/.test(target.pathname)) {
    for (const [key, value] of Object.entries(deliveryHeaders())) request.headers.set(key, value);
  }
  if (!endpoint) return fetch(request);
  // A blocked telemetry chunk must never make a shopping request fail. Catch
  // initialization only: retrying a failed fetch here could duplicate a write.
  tracedFetch ??= import('./telemetry-tracer').then(module => module.createTracedFetch(endpoint)).catch(() => fetch);
  return (await tracedFetch)(request);
  };
}

export const traceFetch = createTraceFetch(endpoint);
