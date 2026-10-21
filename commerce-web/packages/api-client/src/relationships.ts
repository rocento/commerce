import { ApiError, customerSessionHeaders, withCustomerSession } from './identity';
import { traceFetch } from './telemetry';
import type { Product } from './catalog';
import type { components } from './schema';
export type RelationshipInput = components['schemas']['RelationshipInput'];
export type RelationshipRule = components['schemas']['RelationshipRule'];
export type RelationshipConditions = components['schemas']['RelationshipConditions'];
export type RelationshipCondition = components['schemas']['RelationshipCondition'];
export type RelationshipKind = RelationshipInput['kind'];
async function request<T>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
    const r = await traceFetch(new URL(`/api/v1/${path}`, window.location.origin), { method, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new ApiError(e.error || 'Unable to load product relationships', r.status);
    }
    return r.status === 204 ? undefined as T : r.json();
}
export const relationshipsApi = {
    attributes: () => request<components['schemas']['RelationshipAttribute'][]>('admin/catalog/relationship-rules/attributes'),
    list: () => request<RelationshipRule[]>('admin/catalog/relationship-rules'),
    save: (input: RelationshipInput, id?: string) => request<RelationshipRule>(`admin/catalog/relationship-rules${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', input),
    delete: (id: string, revision: number) => request<void>(`admin/catalog/relationship-rules/${id}?revision=${revision}`, 'DELETE'),
    products: (sources: string[], kind: RelationshipKind, locale: string) => withCustomerSession(() => request<Product[]>(`catalog/relationships?${new URLSearchParams({ sources: sources.join(','), kind })}`, 'GET', undefined, { ...customerSessionHeaders(), 'X-Storefront-Locale': locale })),
};
