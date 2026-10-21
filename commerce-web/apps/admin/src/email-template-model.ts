import type { EmailTemplate, EmailTemplateContent } from '@commerce/api-client';

export function templateStatus(template: EmailTemplate): 'Draft changes' | 'Published' | 'System default' {
  return template.has_unpublished_changes ? 'Draft changes' : template.published_version !== null ? 'Published' : 'System default';
}

export function matchesEmailTemplate(template: EmailTemplate, search: string, category: string, status: string): boolean {
  return (!category || template.category === category) && (!status || templateStatus(template) === status)
    && `${template.name} ${template.description} ${template.key}`.toLowerCase().includes(search.trim().toLowerCase());
}

export function sameEmailContent(left: EmailTemplateContent, right: EmailTemplateContent): boolean {
  return left.subject === right.subject && left.heading === right.heading && left.body === right.body && left.cta_label === right.cta_label;
}

export function insertTemplateVariable(value: string, name: string, start = value.length, end = start): { value: string; cursor: number } {
  const token = `{{${name}}}`;
  return { value: value.slice(0, start) + token + value.slice(end), cursor: start + token.length };
}

/** This is an early authoring hint; the server remains authoritative. */
export function emailContentProblems(template: EmailTemplate, content: EmailTemplateContent): string[] {
  const problems: string[] = [];
  if (!content.subject.trim()) problems.push('Add an email subject.');
  if (!content.heading.trim()) problems.push('Add an email heading.');
  if (!content.body.trim()) problems.push('Add a message body.');
  if (content.cta_label !== null && !content.cta_label.trim()) problems.push('Add a button label for the secure account link.');
  for (const variable of template.variables.filter(item => item.required)) {
    if (!content.body.includes(`{{${variable.name}}}`)) problems.push(`Keep {{${variable.name}}} in the message body.`);
  }
  const known = new Set(template.variables.map(variable => variable.name));
  const all = [content.subject, content.heading, content.body, content.cta_label ?? ''].join('\n');
  const unknown = [...all.matchAll(/\{\{([^{}]+?)\}\}/g)].map(match => match[1]).filter(name => !known.has(name));
  for (const name of new Set(unknown)) problems.push(`Unknown variable: {{${name}}}. Choose an available variable below.`);
  if (/[{}]/.test(all.replace(/\{\{[^{}]+\}\}/g, ''))) problems.push('Complete each variable with matching double braces, such as {{brand_name}}.');
  for (const variable of template.variables) {
    const maximum = ['message', 'action_url'].includes(variable.name) ? 1 : 4;
    if (all.split(`{{${variable.name}}}`).length - 1 > maximum) problems.push(`Use {{${variable.name}}} at most ${maximum} ${maximum === 1 ? 'time' : 'times'}.`);
  }
  if ([content.subject, content.heading].some(value => value.includes('{{message}}') || value.includes('{{action_url}}'))) problems.push('Use message details and secure links only in the message body.');
  if (content.cta_label?.includes('{{action_url}}')) problems.push('Use a readable button label; its secure link is added automatically.');
  const limits = { subject: 200, heading: 160, body: 12000, cta_label: 80 };
  const labels = { subject: 'subject line', heading: 'heading', body: 'message body', cta_label: 'button label' };
  for (const field of Object.keys(limits) as (keyof EmailTemplateContent)[]) {
    const value = content[field] ?? '';
    if (new TextEncoder().encode(value).length > limits[field]) problems.push(`Shorten the ${labels[field]}; it exceeds the supported length.`);
    const controls = field === 'body' ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
    if (controls.test(value)) problems.push(`Remove unsupported control characters from the ${labels[field]}.`);
  }
  return problems;
}
