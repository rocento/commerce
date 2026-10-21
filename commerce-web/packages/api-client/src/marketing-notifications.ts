import { ApiError } from './identity';

export type NotificationChannel = 'in_app' | 'email' | 'sms' | 'whatsapp' | 'push';
export type NotificationProgramStatus = 'draft' | 'active' | 'paused' | 'archived';
export type NotificationConditionOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'contains';
export interface NotificationCondition {
  field: string;
  operator: NotificationConditionOperator;
  value: string;
  currency?: string;
}
export interface NotificationConditions {
  match: 'all' | 'any';
  rules: NotificationCondition[];
}
export interface NotificationConditionField {
  key: string;
  label: string;
  type: 'boolean' | 'integer' | 'text' | 'select' | 'money';
  operators: { id: NotificationConditionOperator; label: string }[];
  options: { value: string; label: string }[];
  triggers: string[];
  description: string;
}
export interface NotificationConditionResult {
  index: number;
  field: string;
  operator: NotificationConditionOperator;
  expected: string;
  actual: string | null;
  matched: boolean;
  reason: string;
}
export interface NotificationProgramInput {
  name: string;
  description: string;
  channel: NotificationChannel;
  trigger_kind: string;
  title_template: string;
  body_template: string;
  status: NotificationProgramStatus;
  delay_minutes: number;
  lookback_days: number;
  cooldown_hours: number;
  suppress_after_purchase: boolean;
  /** Omitted legacy definitions have no additional eligibility conditions. */
  conditions?: NotificationConditions;
}
export interface NotificationProgram extends NotificationProgramInput {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface NotificationMetadata {
  delivery_mode: 'generation_only';
  channels: { id: NotificationChannel; label: string; delivery_enabled: false }[];
  triggers: { id: string; label: string; requires_orders: boolean }[];
  tokens: { key: string; label: string }[];
  condition_fields?: NotificationConditionField[];
}
export interface NotificationPreview {
  title: string;
  body: string;
  event_id: string | null;
  event_kind: string | null;
  eligible: boolean;
  reasons: string[];
  missing_tokens: string[];
  context: Record<string, string>;
  condition_match?: 'all' | 'any';
  conditions_matched?: boolean;
  condition_results?: NotificationConditionResult[];
}
export interface GeneratedNotification {
  id: string;
  program_id: string;
  program_name: string;
  program_version: number;
  customer_id: string;
  event_id: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: 'generated';
  created_at: string;
}
export interface NotificationAuditEvent {
  id: string;
  action: string;
  actor_id: string | null;
  created_at: string;
  version: number;
}
export interface NotificationGenerationResult {
  outcome: 'generated' | 'suppressed' | 'duplicate';
  reason: string | null;
  record: GeneratedNotification | null;
}
export interface NotificationCustomer {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile_number: string | null;
}

async function request<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal, base = '/api/v1/admin/marketing/notifications'): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method, credentials: 'include', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'X-Commerce-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error : `Notification request failed (${response.status}). Please try again.`;
    throw new ApiError(response.status === 409
      ? 'This notification changed or this generation request was already used. Reload the saved program before retrying; your unsaved edits are still available.'
      : message, response.status);
  }
  return value as T;
}
function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.size ? `?${params.toString()}` : '';
}
const programPath = (id: string) => `/${encodeURIComponent(id)}`;
export const marketingNotificationApi = {
  customers: (query: { search?: string; cursor?: string } = {}, signal?: AbortSignal) =>
    request<{ items: NotificationCustomer[]; next_cursor: string | null }>(queryString({ q: query.search, cursor: query.cursor, limit: 20, sort: 'id', descending: 'false' }), 'GET', undefined, signal, '/api/v1/admin/grids/customers'),
  metadata: (signal?: AbortSignal) => request<NotificationMetadata>('/metadata', 'GET', undefined, signal),
  list: (query: { search?: string; status?: NotificationProgramStatus; offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<{ programs: NotificationProgram[]; total: number }>(queryString(query), 'GET', undefined, signal),
  create: (input: NotificationProgramInput) => request<NotificationProgram>('', 'POST', input),
  get: (id: string, signal?: AbortSignal) => request<NotificationProgram>(programPath(id), 'GET', undefined, signal),
  update: (id: string, input: NotificationProgramInput & { version: number }) => request<NotificationProgram>(programPath(id), 'PUT', input),
  preview: (input: { program: NotificationProgramInput; customer_id: string; program_id?: string }, signal?: AbortSignal) =>
    request<NotificationPreview>('/preview', 'POST', input, signal),
  generate: (id: string, input: { customer_id: string; version: number; idempotency_key: string }) =>
    request<NotificationGenerationResult>(`${programPath(id)}/generate`, 'POST', input),
  records: (query: { program_id?: string; offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<{ records: GeneratedNotification[]; total: number }>(`/records${queryString(query)}`, 'GET', undefined, signal),
  audit: (id: string, signal?: AbortSignal) =>
    request<{ events: NotificationAuditEvent[] }>(`${programPath(id)}/audit`, 'GET', undefined, signal),
};
