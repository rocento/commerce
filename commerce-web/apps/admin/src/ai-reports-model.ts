import type { components } from '@commerce/api-client';

type ModelUsage = components['schemas']['AssistantModelUsage'];
const internalRoutes = new Set(['commerce-language-engine', 'approved-knowledge', 'deterministic', 'unconfigured']);

/** Keep actual and unattributed model usage; internal routes are not selectable models. */
export function reportedModels(rows: ModelUsage[]): ModelUsage[] {
  return rows.filter(row => !internalRoutes.has(row.model?.trim().toLowerCase().replace(/[\s_]+/g, '-') ?? ''));
}

export function modelLabel(model: string | null | undefined): string {
  if (!model?.trim() || model === 'unknown') return 'Unattributed model';
  return model === 'multiple' ? 'Multiple models' : model;
}

export function providerLabel(provider: string | null | undefined): string {
  if (!provider?.trim() || provider === 'unknown') return 'Unknown provider';
  return provider.toLowerCase() === 'openai' ? 'OpenAI' : provider === 'multiple' ? 'Multiple providers' : provider;
}

export function modelCostLabel(costMicros: number, pricedTurns: number): string {
  return pricedTurns > 0 ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(costMicros / 1_000_000) : 'Not available';
}

export function responseTimeLabel(milliseconds: number | null, hasSamples: boolean): string {
  if (!hasSamples || milliseconds === null) return '—';
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} s` : `${Math.round(milliseconds).toLocaleString('en-US')} ms`;
}
