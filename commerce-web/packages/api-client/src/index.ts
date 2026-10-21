// Foundation liveness client. Domain clients will be generated from OpenAPI at M1.
export async function getHealth(signal?: AbortSignal): Promise<{ status: 'ok' }> {
  const response = await fetch('/api/health', { signal });
  if (!response.ok) throw new Error(`Gateway returned ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('status' in body) || body.status !== 'ok') {
    throw new Error('Unexpected gateway health response');
  }
  return { status: 'ok' };
}
export * from './identity';
export * from './themes';
export * from "./catalog";
export * from "./assistant";
export * from './reporting';

export * from "./msi";
export * from './delivery';
export * from './replenishment';

export * from './segments';
export * from "./merchant";
export * from './assistant-settings';
export * from './discoverability';
export type { components } from './schema';
export * from './capacity';

export * from "./languages";

export * from "./interface-translations";
export * from './markets';

export * from './navigation';
export * from './entity-id';
export * from './email-templates';
export * from './marketing-notifications';
export * from './storefront-notifications';

export * from "./order-statuses";
export * from './relationships';
export * from './mobile';
export * from './mobile-validation';

export * from './delivery-fees';
