import { deliveryHeaders } from './delivery';
import { ApiError, customerSessionHeaders, withCustomerSession } from './identity';
import type { NotificationConditions } from './marketing-notifications';

export type NotificationJourneyTrigger = 'visit' | 'product_view' | 'category_view' | 'page_view' | 'search'
  | 'cart.item_added' | 'cart.item_removed' | 'shopping.proposal_created' | 'shopping.cart_applied'
  | 'checkout' | 'purchase' | 'order_status';
export interface NotificationAudienceRules {
  segment_ids: string[];
  segment_match: 'any' | 'all';
  trigger_kind: NotificationJourneyTrigger | null;
  conditions: NotificationConditions;
  delay_minutes: number;
  lookback_days: number;
  cooldown_hours: number;
  max_deliveries: number;
  suppress_after_purchase: boolean;
}

export interface StorefrontNotification {
  id: string;
  title: string;
  body: string;
  kind: 'announcement' | 'journey';
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
  expires_at: string;
  read_at: string | null;
}
export interface StorefrontNotificationPage {
  items: StorefrontNotification[];
  unread_count: number;
  snapshot_at: string;
  next_cursor: { before: string; before_id: string } | null;
  audience: 'guest' | 'customer';
}
export interface NotificationPublication {
  id: string;
  source_record_id: string | null;
  customer_id: string | null;
  audience: 'all' | 'guests' | 'customers' | 'customer';
  area_ids?: string[];
  trigger_product_id?: string | null;
  audience_rules?: NotificationAudienceRules | null;
  title: string;
  body: string;
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
  expires_at: string;
  withdrawn_at: string | null;
  version: number;
  created_at: string;
}
export interface NotificationPublicationOptions {
  cta_label: string | null;
  cta_path: string | null;
  starts_at: string | null;
  expires_at: string;
  idempotency_key: string;
}
export interface NotificationAnnouncementInput extends NotificationPublicationOptions {
  title: string;
  body: string;
  audience: 'all' | 'guests' | 'customers';
  area_ids?: string[];
  trigger_product_id?: string | null;
  audience_rules?: NotificationAudienceRules | null;
}
export type NotificationCampaignAnnouncement = Omit<NotificationAnnouncementInput, 'idempotency_key'>;
export interface NotificationCampaignInput {
  name: string;
  description: string;
  announcement: NotificationCampaignAnnouncement;
  /** Use zero when creating; updates require the current saved version. */
  version: number;
}
export interface NotificationCampaign extends NotificationCampaignInput {
  id: string;
  status: 'draft' | 'published';
  publication_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface NotificationCampaignList {
  items: NotificationCampaign[];
  total: number;
  offset: number;
  limit: number;
}

/** Only supported storefront destinations; never accept external or encoded redirects. */
export function safeNotificationPath(path: string): boolean {
  if (path.length > 300 || /[\\%?#\s]/u.test(path)) return false;
  if (['/', '/search', '/cart', '/support', '/account', '/account/orders'].includes(path)) return true;
  if (/^\/(products|categories|pages)\/[\p{L}\p{N}_-]+$/u.test(path)) return true;
  return /^\/account\/orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path);
}
function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return query.size ? `?${query}` : '';
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, customer = false): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method, credentials: 'include', cache: 'no-store', signal,
    headers: { ...(customer ? { ...customerSessionHeaders(), ...deliveryHeaders() } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error : 'Notifications are temporarily unavailable. Please try again.';
    throw new ApiError(message, response.status);
  }
  return value as T;
}
export const storefrontNotificationApi = {
  productView: (product: string, signal?: AbortSignal) =>
    withCustomerSession(() => request<{ delivered: number; notification_ids: string[]; queued?: boolean; event_id?: string }>('notifications/product-view', 'POST', { product }, signal, true)),
  list: (query: { filter?: 'all' | 'unread'; limit?: number; before?: string; before_id?: string } = {}, signal?: AbortSignal) =>
    withCustomerSession(() => request<StorefrontNotificationPage>(`notifications${queryString(query)}`, 'GET', undefined, signal, true)),
  read: (id: string, input: { read: boolean }, signal?: AbortSignal) =>
    withCustomerSession(() => request<{ id: string; read_at: string | null; unread_count: number }>(`notifications/${encodeURIComponent(id)}/read`, 'PUT', input, signal, true)),
  readAll: (input: { through: string }, signal?: AbortSignal) =>
    withCustomerSession(() => request<{ updated: number; unread_count: number }>('notifications/read-all', 'POST', input, signal, true)),
};
const adminBase = 'admin/marketing/notifications';
export const notificationCampaignApi = {
  list: (query: { offset?: number; limit?: number; search?: string; status?: 'all' | 'draft' | 'published' } = {}, signal?: AbortSignal) =>
    request<NotificationCampaignList>(`${adminBase}/campaigns${queryString(query)}`, 'GET', undefined, signal),
  create: (input: NotificationCampaignInput) =>
    request<NotificationCampaign>(`${adminBase}/campaigns`, 'POST', input),
  get: (id: string, signal?: AbortSignal) =>
    request<NotificationCampaign>(`${adminBase}/campaigns/${encodeURIComponent(id)}`, 'GET', undefined, signal),
  update: (id: string, input: NotificationCampaignInput) =>
    request<NotificationCampaign>(`${adminBase}/campaigns/${encodeURIComponent(id)}`, 'PUT', input),
  activate: (id: string, input: { version: number; idempotency_key: string }) =>
    request<NotificationPublication>(`${adminBase}/campaigns/${encodeURIComponent(id)}/activate`, 'POST', input),
};
export const notificationPublicationApi = {
  list: (query: { offset?: number; limit?: number; search?: string; status?: string } = {}, signal?: AbortSignal) =>
    request<{ publications: NotificationPublication[]; total: number }>(`${adminBase}/publications${queryString(query)}`, 'GET', undefined, signal),
  publishAnnouncement: (input: NotificationAnnouncementInput) =>
    request<NotificationPublication>(`${adminBase}/publications`, 'POST', input),
  publishRecord: (id: string, input: NotificationPublicationOptions) =>
    request<NotificationPublication>(`${adminBase}/records/${encodeURIComponent(id)}/publish`, 'POST', input),
  delete: (id: string, input: { version: number }) =>
    request<{ id: string; deleted: boolean }>(`${adminBase}/publications/${encodeURIComponent(id)}`, 'DELETE', input),
  withdraw: (id: string, input: { version: number }) =>
    request<NotificationPublication>(`${adminBase}/publications/${encodeURIComponent(id)}/withdraw`, 'POST', input),
};
