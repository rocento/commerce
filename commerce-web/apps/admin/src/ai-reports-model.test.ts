import { expect, it } from 'vitest';
import { modelCostLabel, modelLabel, providerLabel, reportedModels, responseTimeLabel } from './ai-reports-model';

const row = (model: string, provider = 'openai') => ({ model, provider, input_tokens: 0, output_tokens: 0, turns: 1 });

it('excludes internal routes without removing real zero-token or unattributed model usage', () => {
  const rows = [row('commerce-language-engine'), row(' APPROVED_KNOWLEDGE '), row('deterministic'), row('unconfigured'), row('gpt-4.1-mini'), row('unknown', 'unknown'), row('multiple', 'multiple')];
  expect(reportedModels(rows).map(item => item.model)).toEqual(['gpt-4.1-mini', 'unknown', 'multiple']);
  expect(rows).toHaveLength(7);
});

it('retains legacy missing provider/model values and describes combined or unknown usage honestly', () => {
  const legacy = { ...row(''), model: null, provider: null } as unknown as ReturnType<typeof row>;
  expect(reportedModels([legacy])).toEqual([legacy]);
  expect(modelLabel(null)).toBe('Unattributed model');
  expect(modelLabel('unknown')).toBe('Unattributed model');
  expect(modelLabel('multiple')).toBe('Multiple models');
  expect(providerLabel(null)).toBe('Unknown provider');
  expect(providerLabel('multiple')).toBe('Multiple providers');
  expect(providerLabel('openai')).toBe('OpenAI');
});

it('distinguishes missing pricing from recorded zero and preserves a tiny positive estimate', () => {
  expect(modelCostLabel(0, 0)).toBe('Not available');
  expect(modelCostLabel(0, 1)).toBe('$0.0000');
  expect(modelCostLabel(1, 1)).toBe('$0.000001');
  expect(modelCostLabel(2900, 4)).toBe('$0.0029');
});

it('does not turn an empty latency aggregate into a zero-duration response', () => {
  expect(responseTimeLabel(0, false)).toBe('—');
  expect(responseTimeLabel(null, true)).toBe('—');
  expect(responseTimeLabel(0, true)).toBe('0 ms');
  expect(responseTimeLabel(345.4, true)).toBe('345 ms');
  expect(responseTimeLabel(1234, true)).toBe('1.23 s');
});
