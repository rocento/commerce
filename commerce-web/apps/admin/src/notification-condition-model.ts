import type { NotificationCondition, NotificationConditionField, NotificationConditions, NotificationMetadata, NotificationProgramInput } from '@commerce/api-client';

export function normalizeNotificationConditions(value?: NotificationConditions): NotificationConditions {
  return { match: value?.match ?? 'all', rules: (value?.rules ?? []).map(rule => ({ ...rule })) };
}
export function conditionFieldAvailable(field: NotificationConditionField, trigger: string) {
  return field.triggers.length === 0 || field.triggers.includes(trigger);
}
export function newNotificationCondition(field: NotificationConditionField): NotificationCondition {
  return { field: field.key, operator: field.operators[0]?.id ?? 'eq', value: field.options[0]?.value ?? (field.type === 'boolean' ? 'true' : ''), ...(field.type === 'money' ? { currency: '' } : {}) };
}
export function notificationConditionProblems(conditions: NotificationConditions, fields: NotificationConditionField[], trigger: string): string[] {
  const problems: string[] = [];
  if (conditions.rules.length > 10) problems.push('Use no more than 10 conditions.');
  if (conditions.match === 'any' && !conditions.rules.length) problems.push('Add at least one condition when matching Any condition.');
  for (const [index, rule] of conditions.rules.entries()) {
    const prefix = `Condition ${index + 1}`;
    const field = fields.find(item => item.key === rule.field);
    if (!field) { problems.push(`${prefix}: choose an available field.`); continue; }
    if (!conditionFieldAvailable(field, trigger)) problems.push(`${prefix}: ${field.label} is not available for this event. Choose another field or remove this condition.`);
    if (!field.operators.some(operator => operator.id === rule.operator)) problems.push(`${prefix}: choose a supported comparison.`);
    if (Array.from(rule.value).length > 200) problems.push(`${prefix}: use no more than 200 characters.`);
    if (field.type !== 'money' && rule.currency !== undefined) problems.push(`${prefix}: currency is only supported for order amounts. Choose the field again to reset it.`);
    if (!rule.value.trim()) { problems.push(`${prefix}: enter a value.`); continue; }
    if (field.type === 'integer' && (!/^(?:0|[1-9]\d*)$/.test(rule.value) || Number(rule.value) > 1_000_000_000)) problems.push(`${prefix}: use a whole number between 0 and 1,000,000,000 without leading zeroes.`);
    if (field.type === 'money' && !validNotificationAmount(rule.value)) problems.push(`${prefix}: enter an amount from 0 to 999999999999.99 with up to two decimal places.`);
    if (field.type === 'money' && !/^[A-Z]{3}$/.test(rule.currency ?? '')) problems.push(`${prefix}: enter a three-letter currency, such as USD.`);
    if (field.type === 'boolean' && !['true', 'false'].includes(rule.value)) problems.push(`${prefix}: choose Yes or No.`);
    if (field.type === 'select' && !field.options.some(option => option.value === rule.value)) problems.push(`${prefix}: choose an available value.`);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(rule.value)) problems.push(`${prefix}: control characters are not supported.`);
    if (rule.field === 'order.currency' && !/^[A-Z]{3}$/.test(rule.value)) problems.push(`${prefix}: enter a three-letter currency, such as USD.`);
  }
  return problems;
}
export function validNotificationAmount(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return false;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 99999999999999n;
}
export function notificationConditionSummary(rule: NotificationCondition, fields: NotificationConditionField[]) {
  const field = fields.find(item => item.key === rule.field);
  const operator = field?.operators.find(item => item.id === rule.operator)?.label.toLowerCase() ?? rule.operator;
  const value = field?.options.find(item => item.value === rule.value)?.label ?? (field?.type === 'boolean' ? rule.value === 'true' ? 'Yes' : 'No' : rule.value);
  return `${field?.label ?? rule.field} ${operator} ${value || '…'}${field?.type === 'money' ? ` ${rule.currency || 'currency'}` : ''}`;
}
export function notificationProgramSummary(program: NotificationProgramInput, metadata: NotificationMetadata) {
  const trigger = metadata.triggers.find(item => item.id === program.trigger_kind)?.label ?? 'Choose an event';
  const conditions = normalizeNotificationConditions(program.conditions);
  const rules = conditions.rules.map(rule => notificationConditionSummary(rule, metadata.condition_fields ?? []));
  return `${trigger}${program.delay_minutes ? `, after ${program.delay_minutes} minutes` : ''}. ${rules.length ? `Only if ${conditions.match === 'all' ? 'all' : 'at least one'} of these conditions match: ${rules.join(conditions.match === 'all' ? '; and ' : '; or ')}.` : conditions.match === 'any' ? 'Add a condition or choose All conditions to continue.' : 'No extra conditions.'}`;
}
export function notificationTemplateOutline(template: string, tokens: NotificationMetadata['tokens']) {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_whole, key: string) => `‹${tokens.find(token => token.key === key)?.label ?? key}›`);
}
