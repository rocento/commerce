import { describe, expect, it } from 'vitest';
import type { EmailTemplate } from '@commerce/api-client';
import { emailContentProblems, insertTemplateVariable, matchesEmailTemplate, sameEmailContent, templateStatus } from './email-template-model';

const template: EmailTemplate = {
  key: 'verify', name: 'Registration confirmation', description: 'Verify a customer email.', category: 'account', revision: 0,
  draft: { subject: 'Welcome to {{brand_name}}', heading: 'Confirm your email', body: 'Expires in {{expires_minutes}} minutes.', cta_label: 'Confirm email' },
  published: null, published_version: null, has_unpublished_changes: false, updated_at: null, updated_by: null,
  variables: [ { name: 'brand_name', required: false, description: 'Store name', sample: 'Rocento' }, { name: 'expires_minutes', required: true, description: 'Link expiry', sample: '15' }, { name: 'action_url', required: false, description: 'Secure URL', sample: 'https://store.example.test' } ],
};

describe('email template authoring', () => {
  it('distinguishes live defaults, published content and unpublished changes', () => {
    expect(templateStatus(template)).toBe('System default');
    expect(templateStatus({ ...template, published_version: 1 })).toBe('Published');
    expect(templateStatus({ ...template, published_version: 1, has_unpublished_changes: true })).toBe('Draft changes');
  });
  it('combines search, category and publication status', () => {
    expect(matchesEmailTemplate(template, ' REGISTRATION ', 'account', 'System default')).toBe(true);
    expect(matchesEmailTemplate(template, 'verify', '', '')).toBe(true);
    expect(matchesEmailTemplate(template, '', 'orders', '')).toBe(false);
    expect(matchesEmailTemplate(template, '', '', 'Published')).toBe(false);
  });
  it('inserts a variable at a selection without losing surrounding copy', () => {
    expect(insertTemplateVariable('Welcome STORE!', 'brand_name', 8, 13)).toEqual({ value: 'Welcome {{brand_name}}!', cursor: 22 });
    expect(insertTemplateVariable('Hello ', 'brand_name')).toEqual({ value: 'Hello {{brand_name}}', cursor: 20 });
  });
  it('protects required values and strict variable spelling', () => {
    expect(emailContentProblems(template, template.draft)).toEqual([]);
    expect(emailContentProblems(template, { ...template.draft, body: 'Expires in {{ expires_minutes }} minutes.' })).toEqual(expect.arrayContaining([
      'Keep {{expires_minutes}} in the message body.', expect.stringContaining('Unknown variable'),
    ]));
    expect(emailContentProblems(template, { ...template.draft, body: '{{expires_minutes}} {{unknown}}' })).toContain('Unknown variable: {{unknown}}. Choose an available variable below.');
    expect(emailContentProblems(template, { ...template.draft, body: '{{expires_minutes}} {{brand_name' })).toContain('Complete each variable with matching double braces, such as {{brand_name}}.');
  });
  it('keeps secure links out of subjects, headings and button text', () => {
    expect(emailContentProblems(template, { ...template.draft, subject: '{{action_url}}' })).toContain('Use message details and secure links only in the message body.');
    expect(emailContentProblems(template, { ...template.draft, cta_label: '{{action_url}}' })).toContain('Use a readable button label; its secure link is added automatically.');
    expect(emailContentProblems(template, { ...template.draft, body: '{{expires_minutes}} {{action_url}} {{action_url}}' })).toContain('Use {{action_url}} at most 1 time.');
  });
  it('checks UTF-8 length and rejects invisible controls while accepting multiline content', () => {
    expect(emailContentProblems(template, { ...template.draft, heading: 'ع'.repeat(81) })).toContain('Shorten the heading; it exceeds the supported length.');
    expect(emailContentProblems(template, { ...template.draft, subject: 'Hello\r\nBcc: someone' })).toContain('Remove unsupported control characters from the subject line.');
    expect(emailContentProblems(template, { ...template.draft, body: 'Line one\n\nExpires in {{expires_minutes}} minutes.' })).toEqual([]);
  });
  it('detects edits to every published content field without depending on property order', () => {
    expect(sameEmailContent(template.draft, { cta_label: template.draft.cta_label, body: template.draft.body, heading: template.draft.heading, subject: template.draft.subject })).toBe(true);
    expect(sameEmailContent(template.draft, { ...template.draft, cta_label: 'Continue' })).toBe(false);
  });
});
