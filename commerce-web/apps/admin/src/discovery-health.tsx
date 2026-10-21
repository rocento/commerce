import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { EffectiveIndexingPolicy } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { StatusBadge, useCrawlerPreferences } from './crawler-settings';
import { useMerchantPublication } from './merchant-publication';
import { EffectiveIndexingStatus } from './effective-indexing-status';
import { checkName, crawlerStatus, indexingStatus, type VisibilityStatus } from './discovery-status';
type Finding = { code: string; severity: 'Healthy' | 'Warning' | 'Error'; resource: string; evidence: unknown; remediation: string; observed_at: string };
type Health = { observed_at: string; scope: string; findings: Finding[]; observations: null | { scope: string; window_start: string; crawler_requests: number; crawler_errors: number; rows: { route: string; crawler: string; status: string; code: string; count: number }[] } };
type Analytics = { timezone: string; from: string; days: number; sampling: string; session_model: string; revenue_authorized: boolean; channels: { channel: string; sessions: number; referrer_sessions: number; campaign_claim_sessions: number; ai_assisted_sessions: number }[]; top_landings: { path: string; sessions: number }[]; top_products: { path: string; sessions: number }[]; trend: { day: string; sessions: number; recognized_ai_sessions: number }[]; conversions: null | { channel: string; currency: string; orders: number; ai_assisted_orders: number; collected_net_revenue: string }[] };
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/admin/discovery/${path}`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`Unable to load discovery information (${response.status}). Try running checks again.`);
  return response.json() as Promise<T>;
}
function useHealth() { return useQuery({ queryKey: ['discovery-health'], queryFn: () => read<Health>('health'), retry: false }); }
const loading: VisibilityStatus = { label: 'Checking…', description: 'Checking the latest saved configuration.', tone: 'neutral' };
export function DiscoveryOverview({ policy, policyLoading }: { policy?: EffectiveIndexingPolicy; policyLoading: boolean }) {
  const health = useHealth(), crawlers = useCrawlerPreferences(), profile = useMerchantPublication();
  const merchant = profile.isError ? undefined : profile.data;
  const needsReview = merchant && (merchant.warnings.length > 0 || merchant.pages.some(page => page.status !== 'PUBLISHED'));
  const profileStatus: VisibilityStatus = profile.isPending ? loading : !merchant ? { label: 'Unavailable', description: 'Business profile status could not be checked.', tone: 'neutral' }
    : !merchant.configuration.published ? { label: 'Not published', description: 'Review and approve the business information you want to share publicly.', tone: 'neutral' }
    : needsReview ? { label: 'Needs review', description: 'Review your public details and approved policies.', tone: 'warning' }
    : { label: 'Published', description: 'Your approved business information is published.', tone: 'success' };
  const cards = [
    { title: 'Search indexing', status: policyLoading ? loading : indexingStatus(policy) },
    { title: 'AI search access', status: policyLoading || crawlers.isPending ? loading : crawlerStatus(policy, crawlers.isError ? undefined : crawlers.data?.openai_search) },
    { title: 'Business profile', status: profileStatus },
  ];
  const actions: { title: string; description: string; to: string; label: string }[] = [];
  if (policy && !['INDEXABLE', 'BLOCKED_BY_ENVIRONMENT'].includes(policy.state)) actions.push({ title: policy.state === 'DOMAIN_UNVERIFIED' ? 'Review your store domain' : 'Review search indexing', description: indexingStatus(policy).description, to: '/system/configuration/discoverability/seo', label: 'Review SEO' });
  if (merchant && (!merchant.configuration.published || needsReview)) actions.push({ title: 'Review your business profile', description: 'Check your public business details and approve the current versions of policies and guides.', to: '/system/configuration/discoverability/profile', label: 'Review profile' });
  const findings = health.isError ? undefined : health.data?.findings;
  const attention = findings?.filter(f => f.severity !== 'Healthy' && f.code !== 'effective_indexing') ?? [];
  if (attention.length) actions.push({ title: 'Review technical checks', description: `${attention.length} ${attention.length === 1 ? 'check needs' : 'checks need'} attention or external verification. Open the details for the next steps.`, to: '#visibility-technical', label: 'View checks' });
  return <>
    <div className="visibility-status-grid">{cards.map(card => <section className="visibility-status-card" key={card.title}><h2>{card.title}</h2><StatusBadge status={card.status} /><p>{card.status.description}</p></section>)}</div>
    <Notice error>{crawlers.error?.message || profile.error?.message}</Notice>
    <section className="form-card visibility-card"><div className="visibility-section-heading"><h2>Recommended actions</h2><span className="help">{actions.length > 0 ? `${actions.length} areas to review` : 'Based on available checks'}</span></div>
      {actions.length ? <ul className="visibility-action-list">{actions.map(action => <li key={action.title}><div><h3>{action.title}</h3><p>{action.description}</p></div>{action.to.startsWith('#') ? <a className="button-link secondary" href={action.to}>{action.label}</a> : <Link className="button-link secondary" to={action.to}>{action.label}</Link>}</li>)}</ul>
        : <p className="visibility-description">{health.isPending || profile.isPending || policyLoading ? 'Checking for recommended actions…' : !policy || health.isError || !merchant ? 'Some checks are unavailable. Run checks again to review your next steps.' : 'No actions from the available checks. Search inclusion is not confirmed by these checks.'}</p>}
    </section>
    <section id="visibility-technical" className="form-card visibility-card"><div className="visibility-section-heading"><h2>Technical checks</h2>{health.data && !health.isError && <span className="help">Checked {new Date(health.data.observed_at).toLocaleString()}</span>}</div>
      <Notice error>{health.error?.message}</Notice>{health.isPending && <p role="status">Checking storefront health…</p>}
      {findings && <><p className="visibility-description">Review indexing, page responses, and publication health.</p><details className="visibility-details"><summary>View {findings.length} check details</summary>
        <ul className="visibility-check-list">{findings.map((finding, index) => <li key={`${finding.code}-${index}`}><div className="visibility-section-heading"><h3>{checkName(finding.code)}</h3><StatusBadge status={{ label: finding.severity === 'Healthy' ? 'Passed' : finding.severity === 'Error' ? 'Action required' : 'Needs review', description: '', tone: finding.severity === 'Healthy' ? 'success' : finding.severity === 'Error' ? 'danger' : 'warning' }} /></div>
          {finding.severity !== 'Healthy' && <p>{finding.remediation}</p>}
          <details><summary>Evidence</summary><p><code>{finding.resource}</code></p><pre>{typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence, null, 2)}</pre><small>{finding.observed_at}</small></details>
        </li>)}</ul><p className="help">{health.data?.scope}</p></details></>}
    </section>
    {policy && <EffectiveIndexingStatus policy={policy} />}
    <p className="visibility-footer-link"><Link to="/system/configuration/discoverability/performance">View traffic and performance →</Link></p>
  </>;
}
export function DiscoveryPerformance() {
  const analytics = useQuery({ queryKey: ['discovery-analytics'], queryFn: () => read<Analytics>('analytics?days=30'), retry: false });
  const health = useHealth();
  const [view, setView] = useState<'Traffic' | 'Conversions' | 'Top pages'>('Traffic');
  const data = analytics.data;
  return <>
    <section className="form-card visibility-card"><div className="visibility-section-heading"><div><h2>Traffic &amp; conversions</h2><p className="visibility-description">Observed visits from search engines and AI sources.</p></div><span className="help">Last {data?.days ?? 30} days · {data?.timezone ?? 'UTC'}</span></div>
      <div className="visibility-report-switch" aria-label="Performance report">{(['Traffic', 'Conversions', 'Top pages'] as const).map(label => <button key={label} type="button" className="secondary" aria-pressed={view === label} onClick={() => setView(label)}>{label}</button>)}</div>
      <Notice error>{analytics.error?.message}</Notice>{analytics.isPending && <p role="status">Loading performance…</p>}
      {data && !analytics.isError && <>
        {view === 'Traffic' && <>{data.channels.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Source</th><th scope="col">Sessions</th><th scope="col">Referrer matches</th><th scope="col">Campaign claims</th><th scope="col">AI-assisted sessions</th></tr></thead><tbody>{data.channels.map(row => <tr key={row.channel}><td>{row.channel}</td><td>{row.sessions.toLocaleString()}</td><td>{row.referrer_sessions.toLocaleString()}</td><td>{row.campaign_claim_sessions.toLocaleString()}</td><td>{row.ai_assisted_sessions.toLocaleString()}</td></tr>)}</tbody></table></div> : <EmptyState title="No traffic recorded yet" description="Search and AI referrals will appear here when qualifying visits are recorded." />}
          {data.trend.length > 0 && <details className="visibility-details"><summary>Daily session trend · UTC</summary><div className="table-wrap"><table><thead><tr><th scope="col">Day</th><th scope="col">Sessions</th><th scope="col">AI first-touch sessions</th></tr></thead><tbody>{data.trend.map(row => <tr key={row.day}><td>{row.day}</td><td>{row.sessions}</td><td>{row.recognized_ai_sessions}</td></tr>)}</tbody></table></div></details>}
        </>}
        {view === 'Conversions' && (!data.revenue_authorized ? <EmptyState title="Reporting access required" description="Contact an administrator for permission to view conversions and revenue." /> : data.conversions?.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Source</th><th scope="col">Orders</th><th scope="col">AI-assisted orders</th><th scope="col">Net collected revenue</th></tr></thead><tbody>{data.conversions.map(row => <tr key={`${row.channel}-${row.currency}`}><td>{row.channel}</td><td>{row.orders.toLocaleString()}</td><td>{row.ai_assisted_orders.toLocaleString()}</td><td>{row.collected_net_revenue} {row.currency}</td></tr>)}</tbody></table></div> : <EmptyState title="No attributed orders yet" description="Orders appear after verified purchases are attributed to an observed source." />)}
        {view === 'Top pages' && <div className="visibility-page-tables"><PageTable title="Top landing pages" rows={data.top_landings} /><PageTable title="Top product pages" rows={data.top_products} /></div>}
        <details className="visibility-details"><summary>How this report is measured</summary><p>{data.sampling}</p><p>Sessions use the first observed source. Conversions use the last non-direct source observed before the verified purchase callback. AI-assisted orders overlap with total orders and are not added to them.</p><p>Revenue is collected payments minus recorded refunds, grouped by currency. Unpaid orders do not count. Orders without a verified callback remain unattributed.</p></details>
      </>}
    </section>
    <section className="form-card visibility-card"><h2>Crawler activity</h2><p className="visibility-description">Observed requests to your storefront. Crawler names are reported identities, not verified identities.</p>
      <Notice error>{health.error?.message}</Notice>{health.isPending && <p role="status">Loading crawler activity…</p>}
      {health.data && !health.isError && (health.data.observations ? <><p className="help">Since {new Date(health.data.observations.window_start).toLocaleString()}: {health.data.observations.crawler_requests} requests · {health.data.observations.crawler_errors} error responses</p><div className="table-wrap"><table><thead><tr><th scope="col">Page</th><th scope="col">Reported crawler</th><th scope="col">Status</th><th scope="col">Requests</th></tr></thead><tbody>{health.data.observations.rows.filter(row => row.crawler !== 'none').map((row, index) => <tr key={index}><td>{row.route}</td><td>{row.crawler}</td><td>{row.status}</td><td>{row.count}</td></tr>)}</tbody></table></div><details className="visibility-details"><summary>Observation scope</summary><p>{health.data.observations.scope}</p></details></> : <EmptyState title="No crawler observations available" description="Crawler responses have not been observed. This does not confirm that there are no errors." />)}
    </section>
  </>;
}
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="visibility-empty"><h3>{title}</h3><p>{description}</p></div>; }
function PageTable({ title, rows }: { title: string; rows: { path: string; sessions: number }[] }) {
  return <section><h3>{title}</h3>{rows.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Page</th><th scope="col">Sessions</th></tr></thead><tbody>{rows.map(row => <tr key={row.path}><td>{row.path}</td><td>{row.sessions.toLocaleString()}</td></tr>)}</tbody></table></div> : <p className="help">No pages recorded in this period.</p>}</section>;
}
