import type { EffectiveIndexingPolicy } from '@commerce/api-client';
export type VisibilityStatus = { label: string; description: string; tone: 'success' | 'warning' | 'danger' | 'neutral' };
const states: Record<EffectiveIndexingPolicy['state'], VisibilityStatus> = {
  INDEXABLE: { label: 'Allowed', description: 'Public pages are eligible for indexing. Search inclusion is not confirmed.', tone: 'success' },
  MERCHANT_DISABLED: { label: 'Disabled', description: 'Public indexing is turned off in your SEO settings.', tone: 'neutral' },
  BLOCKED_BY_ENVIRONMENT: { label: 'Protected environment', description: 'This environment is protected from indexing. Only approved production stores can be indexed.', tone: 'neutral' },
  BLOCKED_BY_HEADER: { label: 'Blocked', description: 'A deployment override blocks indexing. Ask your administrator to review it.', tone: 'warning' },
  DOMAIN_UNVERIFIED: { label: 'Domain unverified', description: 'Your main store URL must match the approved production domain.', tone: 'warning' },
  CONFIGURATION_ERROR: { label: 'Setup required', description: 'The storefront publication setup needs attention from your administrator.', tone: 'danger' },
};
export function indexingStatus(policy?: EffectiveIndexingPolicy): VisibilityStatus {
  return policy ? states[policy.state] ?? { label: 'Unknown', description: 'The indexing status could not be recognized.', tone: 'neutral' }
    : { label: 'Unavailable', description: 'Current indexing status is unavailable. Saved preferences do not confirm access.', tone: 'neutral' };
}
export function crawlerStatus(policy?: EffectiveIndexingPolicy, allowed?: boolean): VisibilityStatus {
  if (!policy || allowed === undefined) return { label: 'Unavailable', description: 'Current crawler access could not be checked.', tone: 'neutral' };
  if (!allowed) return { label: 'Blocked', description: 'Blocked by your saved crawler preference.', tone: 'neutral' };
  if (policy.state !== 'INDEXABLE') return { label: 'Blocked by indexing', description: indexingStatus(policy).description, tone: 'warning' };
  return { label: 'Allowed', description: 'Allowed by the storefront policy. External access and search inclusion are not confirmed.', tone: 'success' };
}
const checkNames: Record<string, string> = {
  installation_binding: 'Storefront connection', effective_indexing: 'Search indexing', feed_freshness: 'Product feed freshness',
  redirect_target: 'Page redirects', renderer_probe: 'Storefront response checks', external_edge: 'Public domain checks',
};
export function checkName(code: string) { return checkNames[code] || code.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()); }
