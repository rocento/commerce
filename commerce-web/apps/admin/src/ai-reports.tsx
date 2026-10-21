import { PageHeader } from './page-header';
import { getAssistantReport, merchantMetrics, assistantUsage } from '@commerce/api-client';
import { useQuery } from '@tanstack/react-query';
import { OverviewIcon } from './overview-icon';
import { modelCostLabel, modelLabel, providerLabel, reportedModels, responseTimeLabel } from './ai-reports-model';
import './ai-reports.css';

const number = (value: number) => value.toLocaleString('en-US');
const updated = (value: number | string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value));

function ReportError({ label, hasData, retry, busy }: { label: string; hasData: boolean; retry: () => void; busy: boolean }) {
  return <div className="ai-report-error" role="alert"><div><strong>{label} could not {hasData ? 'refresh' : 'be loaded'}.</strong><p>{hasData ? 'The last available data is shown.' : 'Please try again. Other report sections load independently.'}</p></div><button type="button" className="secondary" disabled={busy} onClick={retry}>Retry {label.toLowerCase()}</button></div>;
}

function Feedback({ helpful, notHelpful }: { helpful: number; notHelpful: number }) {
  return <div className="ai-feedback"><span>Feedback on these turns</span><div><span><i aria-hidden="true"/> {number(helpful)} helpful</span><span>{number(notHelpful)} not helpful</span></div>{helpful + notHelpful === 0 && <small>No ratings received for these turns.</small>}</div>;
}

function Loading({ children }: { children: string }) { return <div className="ai-report-loading" role="status"><span aria-hidden="true"/>{children}</div>; }

export function AiReports() {
  const report = useQuery({ queryKey: ['assistant-report'], queryFn: getAssistantReport });
  const merchant = useQuery({ queryKey: ['merchant-metrics'], queryFn: merchantMetrics });
  const usage = useQuery({ queryKey: ['assistant-usage'], queryFn: assistantUsage });
  const refreshing = report.isFetching || merchant.isFetching || usage.isFetching;
  const shopper = usage.data;
  const operator = merchant.data;
  const outcomes = report.data;
  const models = reportedModels(shopper?.models ?? []);
  const completeCoverage = !!shopper && shopper.usage_recorded > 0 && shopper.cost_recorded === shopper.usage_recorded;
  const partialError = report.isError || merchant.isError || usage.isError;
  const coveragePercent = shopper && shopper.usage_recorded > 0 && shopper.cost_recorded <= shopper.usage_recorded ? shopper.cost_recorded / shopper.usage_recorded * 100 : null;
  function refresh() { void Promise.allSettled([report.refetch(), merchant.refetch(), usage.refetch()]); }
  return <main className="ai-reports-page">
    <PageHeader title="AI models" description="Understand model usage, assistant activity, and request outcomes." actions={<button type="button" className="secondary ai-report-refresh" aria-label="Refresh report" disabled={refreshing} onClick={refresh}><OverviewIcon name="refresh"/>{refreshing ? 'Refreshing…' : 'Refresh report'}</button>}/>
    <div className="ai-report-period"><span><i aria-hidden="true"/>Last 24 hours <b>·</b> Rolling window</span><span>{partialError ? 'Some sections need a refresh' : 'Times shown in UTC'}</span></div>

    <section className="ai-report-panel ai-model-usage" aria-labelledby="ai-model-usage-title" aria-busy={usage.isFetching}>
      <div className="ai-report-section-heading"><div><span className="ai-report-eyebrow">Usage &amp; spend</span><h2 id="ai-model-usage-title">Model usage</h2><p>Reported tokens and cost for the shopper assistant.</p></div><span className="ai-report-badge">Shopper assistant</span></div>
      {usage.isError && <ReportError label="Model usage" hasData={!!shopper} busy={usage.isFetching} retry={() => void usage.refetch()}/>}
      {usage.isPending ? <Loading>Loading model usage…</Loading> : <>
        <div className="ai-usage-summary">
          <div><span>Input tokens</span><strong className={shopper && shopper.usage_recorded === 0 ? 'ai-value-unavailable' : undefined}>{shopper ? shopper.usage_recorded > 0 ? number(shopper.input_tokens) : 'Not recorded' : '—'}</strong><small>Reported model input</small></div>
          <div><span>Output tokens</span><strong className={shopper && shopper.usage_recorded === 0 ? 'ai-value-unavailable' : undefined}>{shopper ? shopper.usage_recorded > 0 ? number(shopper.output_tokens) : 'Not recorded' : '—'}</strong><small>Reported model output</small></div>
          <div><span>Estimated cost · USD</span><strong className={shopper && shopper.cost_recorded === 0 ? 'ai-value-unavailable' : undefined}>{shopper ? modelCostLabel(shopper.estimated_cost_micros, shopper.cost_recorded) : '—'}</strong><small>{shopper && shopper.cost_recorded === 0 ? 'No priced usage recorded' : 'Subtotal of priced usage'}</small></div>
          <div><span>Pricing coverage</span><strong className={shopper && shopper.usage_recorded === 0 ? 'ai-value-unavailable' : undefined}>{shopper ? shopper.usage_recorded > 0 ? <>{number(shopper.cost_recorded)} <em>/ {number(shopper.usage_recorded)}</em></> : 'Not recorded' : '—'}</strong><small>{completeCoverage ? 'All reported usage is priced' : 'Priced turns / turns with usage'}</small>{coveragePercent !== null && <progress aria-label="Pricing coverage of reported model usage" max={100} value={coveragePercent}/>}</div>
        </div>
        {shopper && <>
          <div className="ai-model-table-heading"><h3>Models with reported usage</h3><span>{number(shopper.model_calls)} completed model calls <b>·</b> {number(shopper.usage_recorded)} turns with usage</span></div>
          {models.length ? <div className="ai-model-table-wrap"><table className="ai-model-table"><caption className="ai-sr-only">Shopper model usage in the last 24 hours</caption><thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Turns with usage</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th></tr></thead><tbody>{models.map((row, index) => <tr key={`${row.provider}/${row.model}/${index}`}><td data-label="Provider"><span className="ai-model-provider">{providerLabel(row.provider)}</span></td><th scope="row" data-label="Model"><code>{modelLabel(row.model)}</code></th><td data-label="Turns with usage">{number(row.turns)}</td><td data-label="Input tokens">{number(row.input_tokens)}</td><td data-label="Output tokens">{number(row.output_tokens)}</td></tr>)}</tbody></table></div> : <div className="ai-report-empty"><span className="ai-report-empty-icon"><OverviewIcon name="spark"/></span><h3>No model usage reported</h3><p>Model activity will appear when usage is reported. Conversation activity is shown separately below.</p></div>}
          <div className="ai-usage-footnote"><span>Up to 10 models with reported usage.</span>{usage.dataUpdatedAt > 0 && <span>Updated {updated(usage.dataUpdatedAt)}</span>}</div>
        </>}
      </>}
      <p className="ai-report-method-note">Cost estimates use recorded rates and exclude embeddings and unreported usage. Missing pricing means the full cost is unknown.</p>
    </section>

    <div className="ai-report-group-heading"><h2>Assistant activity</h2><p>Conversation activity includes requests that did not use a model.</p></div>
    <div className="ai-activity-grid">
      <section className="ai-report-panel ai-activity-card" aria-labelledby="ai-shopper-title" aria-busy={usage.isFetching}>
        <div className="ai-activity-heading"><span className="ai-activity-icon"><OverviewIcon name="people"/></span><div><h3 id="ai-shopper-title">Shopper assistant</h3><p>Customer shopping conversations</p></div></div>
        {usage.isError && <ReportError label="Shopper activity" hasData={!!shopper} busy={usage.isFetching} retry={() => void usage.refetch()}/>}
        {usage.isPending ? <Loading>Loading shopper activity…</Loading> : shopper ? <>
          <dl className="ai-activity-totals"><div><dt>Conversations</dt><dd>{number(shopper.conversations)}</dd></div><div><dt>Recorded turns</dt><dd>{number(shopper.turns)}</dd></div></dl>
          <dl className="ai-activity-details"><div><dt>Errors or disconnections</dt><dd>{number(shopper.errors)}</dd></div><div><dt>Average response time</dt><dd>{responseTimeLabel(shopper.latency_ms, shopper.turns > 0)}</dd></div><div><dt>Tool calls</dt><dd>{number(shopper.tool_calls)}</dd></div><div><dt>Retrieved sources</dt><dd>{number(shopper.retrieval_count)}</dd></div></dl>
          <Feedback helpful={shopper.helpful} notHelpful={shopper.not_helpful}/>
        </> : <p className="ai-report-unavailable">Shopper activity is temporarily unavailable.</p>}
      </section>
      <section className="ai-report-panel ai-activity-card" aria-labelledby="ai-merchant-title" aria-busy={merchant.isFetching}>
        <div className="ai-activity-heading"><span className="ai-activity-icon ai-activity-merchant"><OverviewIcon name="store"/></span><div><h3 id="ai-merchant-title">Merchant assistant</h3><p>Administrator conversations</p></div></div>
        {merchant.isError && <ReportError label="Merchant activity" hasData={!!operator} busy={merchant.isFetching} retry={() => void merchant.refetch()}/>}
        {merchant.isPending ? <Loading>Loading merchant activity…</Loading> : operator ? <>
          <dl className="ai-activity-totals"><div><dt>Conversations</dt><dd>{number(operator.conversations)}</dd></div><div><dt>Saved answers</dt><dd>{number(operator.turns)}</dd></div></dl>
          <dl className="ai-activity-details"><div><dt>Average response time</dt><dd>{responseTimeLabel(operator.latency_ms, operator.turns > 0)}</dd></div></dl>
          <div className="ai-merchant-scope">Model tokens and costs are available for shopper usage only.</div>
          <Feedback helpful={operator.helpful} notHelpful={operator.not_helpful}/>
        </> : <p className="ai-report-unavailable">Merchant activity is temporarily unavailable.</p>}
      </section>
    </div>
    <p className="ai-feedback-note">Feedback reflects user ratings on turns in this period. It is not an automated measure of answer accuracy.</p>

    <section className="ai-report-panel ai-request-outcomes" aria-labelledby="ai-request-outcomes-title" aria-busy={report.isFetching}>
      <div className="ai-report-section-heading"><div><span className="ai-report-eyebrow">Request delivery</span><h2 id="ai-request-outcomes-title">Request outcomes</h2><p>Shopper request outcomes are reported separately from conversation activity.</p></div><span className="ai-report-badge" data-tone={outcomes?.configured && outcomes.total > 0 ? 'good' : 'neutral'}>{report.isPending ? 'Loading' : report.isError ? 'Needs refresh' : !outcomes?.configured ? 'Unavailable' : outcomes.total === 0 ? 'Awaiting records' : 'Reporting'}</span></div>
      {report.isError && <ReportError label="Request outcomes" hasData={!!outcomes} busy={report.isFetching} retry={() => void report.refetch()}/>}
      {report.isPending ? <Loading>Loading request outcomes…</Loading> : outcomes?.configured ? <>
        {outcomes.total === 0 && <div className="ai-outcome-notice"><strong>No request outcomes received for this period.</strong><p>Outcome reporting can lag behind conversation activity. This does not mean there were no assistant conversations.</p></div>}
        <dl className="ai-outcomes-totals"><div><dt>Recorded outcomes</dt><dd>{number(outcomes.total)}</dd></div><div><dt>Completed requests</dt><dd>{number(outcomes.completed)}</dd></div><div><dt>Unavailable</dt><dd>{number(outcomes.unavailable)}</dd></div><div><dt>Disconnected</dt><dd>{number(outcomes.disconnected)}</dd></div><div><dt>Average recorded latency</dt><dd>{responseTimeLabel(outcomes.average_latency_ms, outcomes.total > 0)}</dd></div></dl>
        <div className="ai-usage-footnote"><span>Last {outcomes.window_hours} hours</span><span>Evaluated {updated(outcomes.evaluated_at)}</span></div>
      </> : !report.isError && <div className="ai-outcome-notice"><strong>Request outcome reporting is unavailable.</strong><p>Model usage and conversation activity are reported independently above.</p></div>}
      <p className="ai-report-method-note">Completed means a request finished. It does not measure answer quality. Outcome records can arrive later than the activity shown above.</p>
    </section>
  </main>;
}
