import type { NotificationAudienceRules, NotificationCampaign, NotificationCampaignInput, NotificationMetadata } from '@commerce/api-client';
import { defaultForm, localTime, validation, type PublicationForm } from './notification-publication-model';
import { normalizeNotificationConditions, notificationConditionProblems } from './notification-condition-model';

export type CampaignForm = PublicationForm & { name: string; description: string; rules: NotificationAudienceRules };
export function defaultAudienceRules(): NotificationAudienceRules {
  return { segment_ids: [], segment_match: 'any', trigger_kind: null, conditions: normalizeNotificationConditions(), delay_minutes: 0, lookback_days: 30, cooldown_hours: 24, max_deliveries: 1, suppress_after_purchase: false };
}
export function campaignForm(campaign?: NotificationCampaign): CampaignForm {
  const form = { ...defaultForm(), audience: 'all' as const, name: '', description: '', rules: defaultAudienceRules() };
  if (!campaign) return form;
  const source = campaign.announcement;
  return { ...form, name: campaign.name, description: campaign.description, title: source.title, body: source.body, audience: source.audience, areaIds: source.area_ids ?? [], areaTargeted: !!source.area_ids?.length, productTargeted: !!source.trigger_product_id, productId: source.trigger_product_id ?? '', productName: source.trigger_product_id ? 'Saved product' : '', ctaLabel: source.cta_label ?? '', ctaPath: source.cta_path ?? '', startsAt: source.starts_at ? localTime(new Date(source.starts_at)) : '', expiresAt: localTime(new Date(source.expires_at)), rules: { ...defaultAudienceRules(), ...source.audience_rules, conditions: normalizeNotificationConditions(source.audience_rules?.conditions) } };
}
export function campaignInput(form: CampaignForm, version = 0): NotificationCampaignInput {
  return { name: form.name.trim(), description: form.description.trim(), version, announcement: { title: form.title.trim(), body: form.body.trim(), audience: form.audience, area_ids: form.areaTargeted ? form.areaIds : [], trigger_product_id: form.productTargeted ? form.productId : null, cta_label: form.ctaLabel.trim() || null, cta_path: form.ctaPath.trim() || null, starts_at: form.startsAt ? new Date(form.startsAt).toISOString() : null, expires_at: new Date(form.expiresAt).toISOString(), audience_rules: form.rules } };
}
export function campaignProblems(form: CampaignForm, metadata?: NotificationMetadata): string[] {
  const errors = validation(form, false);
  if (!form.name.trim() || [...form.name].length > 200) errors.push('Enter a campaign name of up to 200 characters.');
  if ([...form.description].length > 2000) errors.push('Keep the description within 2,000 characters.');
  const rules = form.rules;
  if (rules.segment_ids.length > 20) errors.push('Select at most 20 segments.');
  if (form.audience !== 'customers' && (rules.segment_ids.length || rules.conditions.rules.some(rule => rule.field !== 'product.name'))) errors.push('Choose signed-in customers for segments and customer or order conditions.');
  if (form.audience !== 'customers' && rules.trigger_kind && !['visit', 'product_view'].includes(rules.trigger_kind)) errors.push('Choose signed-in customers for this journey event.');
  if (form.productTargeted && rules.trigger_kind !== 'product_view') errors.push('Choose the Product viewed event to target a specific product.');
  if (!rules.trigger_kind && (rules.delay_minutes || rules.max_deliveries !== 1 || rules.suppress_after_purchase)) errors.push('Choose a journey event to use a delay, repeat delivery, or purchase suppression.');
  const ranges = [['Delay', rules.delay_minutes, 0, 43200], ['Event lookback', rules.lookback_days, 1, 90], ['Cooldown', rules.cooldown_hours, 0, 2160], ['Maximum deliveries', rules.max_deliveries, 1, 100]] as const;
  for (const [name, value, min, max] of ranges) if (!Number.isInteger(value) || value < min || value > max) errors.push(`${name} must be a whole number from ${min} to ${max.toLocaleString()}.`);
  if (rules.trigger_kind && rules.delay_minutes >= rules.lookback_days * 1440) errors.push('The event delay must be shorter than its lookback window.');
  if (rules.max_deliveries > 1 && rules.cooldown_hours < 1) errors.push('Repeating campaigns need a cooldown of at least one hour.');
  if (form.audience !== 'customers' && rules.trigger_kind === 'visit' && rules.max_deliveries > 1) errors.push('Store visits deliver once to guests. Choose Product viewed or signed-in customers for repeat delivery.');
  if (rules.suppress_after_purchase && form.audience !== 'customers') errors.push('Purchase suppression requires signed-in customers.');
  if (metadata) {
    if (rules.trigger_kind && !metadata.triggers.some(trigger => trigger.id === rules.trigger_kind)) errors.push('Choose an available journey event.');
    errors.push(...notificationConditionProblems(rules.conditions, metadata.condition_fields ?? [], rules.trigger_kind ?? ''));
  } else if (rules.conditions.rules.length || rules.trigger_kind) errors.push('Load journey configuration before saving these rules.');
  return [...new Set(errors)];
}
export function campaignAudienceSummary(form: CampaignForm) {
  const audience = form.audience === 'all' ? 'Everyone' : form.audience === 'guests' ? 'Guests' : 'Signed-in customers';
  return `${audience}${form.rules.segment_ids.length ? ` in ${form.rules.segment_match === 'all' ? 'all' : 'any'} of ${form.rules.segment_ids.length} selected segments` : ''}${form.rules.conditions.rules.length ? ` · ${form.rules.conditions.match === 'all' ? 'all' : 'any'} of ${form.rules.conditions.rules.length} conditions` : ''}${form.areaTargeted ? ` · ${form.areaIds.length} delivery areas` : ''}`;
}
