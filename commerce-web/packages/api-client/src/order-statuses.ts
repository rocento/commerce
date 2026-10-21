import { ApiError } from './identity';
import type { components } from './schema';
export type OrderStatusDefinition = components['schemas']['OrderStatusDefinition'];
export type OrderStatusInput = components['schemas']['OrderStatusInput'];
export type OrderStatusDisplay = components['schemas']['OrderStatusDisplay'];
export type OrderStatusLabelHistory = components['schemas']['OrderStatusLabelHistory'];
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin/${path}`, {
    method, credentials: 'include', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status === 409 ? 'This status or order changed. Reload the latest version before saving again.' : data?.error || 'Unable to update order status.', response.status);
  return data as T;
}
export const orderStatusesApi = {
  list: () => request<OrderStatusDefinition[]>('order-statuses'),
  save: (input: OrderStatusInput, existing?: string) => request<OrderStatusDefinition>(existing ? `order-statuses/${encodeURIComponent(existing)}` : 'order-statuses', existing ? 'PUT' : 'POST', input),
  assign: (id: string, input: components['schemas']['OrderStatusAssignment']) => request(`orders/${id}/status-label`, 'POST', input),
  history: (id: string) => request<OrderStatusLabelHistory[]>(`orders/${id}/status-label`),
};
export function orderStatusLabel(display: OrderStatusDisplay | undefined, locale: string): string | undefined {
  return display && (display.translations[locale] || display.translations[locale.split('-')[0]] || display.label);
}
