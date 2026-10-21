import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import type { components } from '@commerce/api-client';
import { AiReports } from './ai-reports';

const report: components['schemas']['AssistantReport'] = { configured: true, window_hours: 24, evaluated_at: '2026-10-04T16:00:00Z', total: 0, completed: 0, unavailable: 0, disconnected: 0, average_latency_ms: null };
const merchant: components['schemas']['MerchantMetrics'] = { conversations: 1, turns: 4, helpful: 0, not_helpful: 0, latency_ms: 10 };
const usage: components['schemas']['AssistantUsage'] = {
  conversations: 11, turns: 29, errors: 2, helpful: 1, not_helpful: 0, input_tokens: 6897, output_tokens: 86,
  tool_calls: 37, retrieval_count: 5, usage_recorded: 4, model_calls: 4, estimated_cost_micros: 2900, cost_recorded: 2, latency_ms: 345,
  models: [{ provider: 'openai', model: 'gpt-4.1-mini', input_tokens: 6897, output_tokens: 86, turns: 4 }, { provider: 'openai', model: 'commerce-language-engine', input_tokens: 0, output_tokens: 0, turns: 25 }], routes: [],
};

function render(options: { usage?: typeof usage; report?: typeof report; failed?: string[]; loading?: string[]; stale?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  for (const [key, data] of [['assistant-report', options.report ?? report], ['merchant-metrics', merchant], ['assistant-usage', options.usage ?? usage]] as const) {
    if (options.loading?.includes(key)) continue;
    if (!options.failed?.includes(key) || options.stale) client.setQueryData([key], data);
    if (options.failed?.includes(key)) client.getQueryCache().build(client, { queryKey: [key] }).setState({ status: 'error', error: new Error('Internal database migration diagnostic'), fetchStatus: 'idle' });
  }
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><AiReports/></QueryClientProvider>);
  client.clear();
  return html;
}

it('separates shopper and merchant activity from the empty shopper outcome stream', () => {
  const html = render();
  expect(html).toContain('No request outcomes received for this period.');
  expect(html).toContain('This does not mean there were no assistant conversations.');
  expect(html).toContain('Shopper request outcomes are reported separately from conversation activity.');
  expect(html).toContain('Customer shopping conversations');
  expect(html).toContain('Administrator conversations');
  expect(html).toContain('Saved answers');
  expect(html).not.toContain('No assistant turns have been recorded');
  expect(html).not.toContain('commerce-language-engine');
  expect(html).toContain('gpt-4.1-mini');
  expect(html).toContain('6,897');
  expect(html).toContain('Subtotal of priced usage');
  expect(html).toContain('$0.0029');
  expect(html).toContain('Completed means a request finished. It does not measure answer quality.');
});

it('does not invent zero cost or zero tokens when reporting coverage is absent', () => {
  const html = render({ usage: { ...usage, input_tokens: 0, output_tokens: 0, cost_recorded: 0, usage_recorded: 0, model_calls: 0, estimated_cost_micros: 0, models: [] } });
  expect(html).toContain('No model usage reported');
  expect(html.match(/Not recorded/g)).toHaveLength(3);
  expect(html).toContain('No priced usage recorded');
  expect(html).not.toContain('$0.0000');
  expect(html).toContain('Recorded turns');
  expect(html).toContain('>29</dd>');
});

it('keeps available sections usable and replaces internal errors with scoped recovery actions', () => {
  const html = render({ failed: ['assistant-usage'] });
  expect(html).toContain('Model usage could not be loaded.');
  expect(html).toContain('Shopper activity could not be loaded.');
  expect(html).toContain('Retry model usage');
  expect(html).toContain('Retry shopper activity');
  expect(html).toContain('Saved answers');
  expect(html).not.toContain('Internal database');
  expect(html).not.toContain('configure and migrate');
});

it('labels stale data after a failed refresh instead of silently showing it as fresh', () => {
  const html = render({ failed: ['merchant-metrics'], stale: true });
  expect(html).toContain('Merchant activity could not refresh.');
  expect(html).toContain('The last available data is shown.');
  expect(html).toContain('>4</dd>');
});

it('has section-specific loading states and withholds unmeasured figures', () => {
  const html = render({ loading: ['assistant-usage', 'merchant-metrics', 'assistant-report'] });
  expect(html).toContain('Loading model usage…');
  expect(html).toContain('Loading shopper activity…');
  expect(html).toContain('Loading merchant activity…');
  expect(html).toContain('Loading request outcomes…');
  expect(html).not.toContain('$0.0000');
  expect(html).not.toContain('>0</dd>');
});
