import { ApiError } from './identity';

export interface EmailTemplateContent {
  subject: string;
  heading: string;
  body: string;
  cta_label: string | null;
}

export interface EmailTemplateVariable {
  name: string;
  description: string;
  sample: string;
  required: boolean;
}

export interface EmailTemplate {
  key: string;
  name: string;
  description: string;
  category: 'account' | 'orders';
  variables: EmailTemplateVariable[];
  revision: number;
  draft: EmailTemplateContent;
  published: EmailTemplateContent | null;
  published_version: number | null;
  has_unpublished_changes: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface EmailTemplateVersion {
  version: number;
  content: EmailTemplateContent;
  change_note: string;
  published_at: string;
  published_by: string;
}

export interface EmailTemplatePreview { subject: string; text: string; html: string }
export interface EmailTemplateHistory { items: EmailTemplateVersion[]; next_before_version: number | null }
export interface EmailTemplateChange { expected_revision: number; change_note: string }

async function request<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/admin/email-templates${path}`, {
    method, credentials: 'include', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'X-Commerce-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'Unable to load email templates. Please try again.';
    throw new ApiError(response.status === 409 ? 'This template changed in another session. Reload the latest version before continuing; your unsaved changes are still here.' : message, response.status);
  }
  return value as T;
}

const path = (key: string) => `/${encodeURIComponent(key)}`;
export const emailTemplatesApi = {
  list: () => request<{ items: EmailTemplate[] }>(),
  get: (key: string) => request<EmailTemplate>(path(key)),
  save: (key: string, input: EmailTemplateChange & { content: EmailTemplateContent }) => request<EmailTemplate>(path(key), 'PUT', input),
  preview: (key: string, content: EmailTemplateContent, signal?: AbortSignal) => request<EmailTemplatePreview>(`${path(key)}/preview`, 'POST', { content }, signal),
  publish: (key: string, input: EmailTemplateChange) => request<EmailTemplate>(`${path(key)}/publish`, 'POST', input),
  history: (key: string, beforeVersion?: number) => request<EmailTemplateHistory>(`${path(key)}/history${beforeVersion === undefined ? '' : `?before_version=${encodeURIComponent(beforeVersion)}`}`),
  restore: (key: string, input: EmailTemplateChange & { version: number }) => request<EmailTemplate>(`${path(key)}/restore`, 'POST', input),
};
