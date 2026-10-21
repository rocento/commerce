import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { effectiveIndexingPolicy, discoverabilityApi, type DiscoverySettings } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';
import { DiscoveryOverview, DiscoveryPerformance } from './discovery-health';
import { MerchantPublication } from './merchant-publication';
import { CrawlerSettings } from './crawler-settings';
import { EffectiveIndexingStatus } from './effective-indexing-status';
import { MetadataSettings } from './metadata-settings';
import { PageHeader } from './page-header';
import { indexingStatus } from './discovery-status';
import './discovery-health.css';
const sections = [
  { id: 'overview', label: 'Visibility overview' }, { id: 'seo', label: 'Search engine optimization' }, { id: 'ai', label: 'AI & crawler access' },
  { id: 'profile', label: 'Business profile' }, { id: 'performance', label: 'Discovery performance' },
] as const;
type Section = typeof sections[number]['id'];
export function DiscoverabilitySettings({ canWrite }: { canWrite: boolean }) {
  const location = useLocation(), cache = useQueryClient();
  const sectionMatch = location.pathname.match(/^\/system\/configuration\/discoverability\/([^/]+)\/?$/);
  const current = sectionMatch?.[1] || 'overview';
  const [visited, setVisited] = useState<string[]>([current]);
  const [checking, setChecking] = useState(false), [checkMessage, setCheckMessage] = useState('');
  const policy = useQuery({ queryKey: ['effective-indexing-policy'], queryFn: effectiveIndexingPolicy, refetchInterval: 30000 });
  // Preserve drafts while switching between sections in this workspace.
  useEffect(() => { setVisited(previous => previous.includes(current) ? previous : [...previous, current]); }, [current]);
  async function refresh() {
    setChecking(true); setCheckMessage('');
    try {
      await Promise.all(['effective-indexing-policy', 'discovery-health', 'publication-crawlers', 'merchant-publication', 'discovery-analytics'].map(key => cache.invalidateQueries({ queryKey: [key] }, { throwOnError: true })));
      setCheckMessage('Checks updated. Review current status and any recommended actions.');
    } catch { setCheckMessage('Some checks could not be updated. Review the errors below and try again.'); }
    finally { setChecking(false); }
  }
  if (!sectionMatch || !sections.some(section => section.id === current)) return <Navigate to="/system/configuration/discoverability/overview" replace />;
  const status = indexingStatus(policy.isError ? undefined : policy.data);
  const contents: Record<Section, () => ReactNode> = {
    overview: () => <DiscoveryOverview policy={policy.isError ? undefined : policy.data} policyLoading={policy.isPending} />,
    seo: () => <><section className={`visibility-banner ${status.tone}`} aria-label="Current search indexing status"><strong>Search indexing: {policy.isPending ? 'Checking…' : status.label}</strong><p>{status.description}</p></section><SeoSettings canWrite={canWrite} /><MetadataSettings canWrite={canWrite} />{policy.data && !policy.isError && <EffectiveIndexingStatus policy={policy.data} />}</>,
    ai: () => <CrawlerSettings canWrite={canWrite} policy={policy.isError ? undefined : policy.data} />,
    profile: () => <MerchantPublication canWrite={canWrite} />,
    performance: () => <DiscoveryPerformance />,
  };
  return <main className="visibility-page">
    <PageHeader title={sections.find(section => section.id === current)?.label} description="Help customers find your store through search and AI." actions={<button className="secondary" type="button" disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Run checks'}</button>} />
    {policy.error && <Notice error>Current indexing status is unavailable. Try running checks again.</Notice>}
    {checkMessage && <p role="status" className="visibility-refresh-status">{checkMessage}</p>}
    {!canWrite && <p className="visibility-readonly" role="status">View-only access. Contact an administrator to change these settings.</p>}
    {sections.filter(section => visited.includes(section.id) || current === section.id).map(section => <div key={section.id} hidden={current !== section.id} aria-label={section.label}>{contents[section.id]()}</div>)}
  </main>;
}
function SeoSettings({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({ queryKey: ['discoverability-settings'], queryFn: discoverabilityApi.get });
  if (query.isPending) return <p role="status">Loading SEO settings…</p>;
  if (!query.data) return <Notice error>{query.error?.message || 'SEO settings are unavailable.'}</Notice>;
  return <><Notice error>{query.error?.message}</Notice><SeoForm initial={query.data} canWrite={canWrite} /></>;
}
function SeoForm({ initial, canWrite }: { initial: DiscoverySettings; canWrite: boolean }) {
  const cache = useQueryClient();
  const [form, setForm] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const change = <K extends keyof DiscoverySettings>(key: K, value: DiscoverySettings[K]) => { setForm({ ...form, [key]: value }); setNotice(''); setError(''); };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canWrite || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { revision, updated_at, ...values } = form; void updated_at;
      const saved = await discoverabilityApi.save({ ...values, expected_revision: revision });
      setForm(saved); cache.setQueryData(['discoverability-settings'], saved);
      await Promise.all(['effective-indexing-policy', 'discovery-health', 'merchant-publication'].map(key => cache.invalidateQueries({ queryKey: [key] })));
      setNotice('SEO settings saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save SEO settings.'); }
    finally { setBusy(false); }
  }
  return <form className="form-card visibility-card" onSubmit={submit}>
    <h2>Store details</h2><p className="visibility-description">Set the name, main URL, and default description used by your public pages.</p>
    <fieldset disabled={!canWrite || busy}><legend className="visibility-sr-only">Store details and indexing preferences</legend>
      <div className="form-grid">
        <Field label="Store name" required maxLength={120} value={form.site_name} onChange={e => change('site_name', e.target.value)} />
        <Field label="Organization name" required maxLength={120} value={form.organization_name} onChange={e => change('organization_name', e.target.value)} />
        <Field label="Main store URL" type="url" placeholder="https://shop.example.com/" value={form.canonical_url ?? ''} onChange={e => change('canonical_url', e.target.value || null)} />
        <Field label="Default language / locale" required pattern="[a-z]{2}(-[A-Z]{2})?" placeholder="en or en-US" value={form.default_locale} onChange={e => change('default_locale', e.target.value)} />
      </div>
      <label className="field">Store description<textarea required maxLength={500} rows={3} value={form.description} onChange={e => change('description', e.target.value)} /><small>{form.description.length}/500 characters</small></label>
      <section className="visibility-form-section"><h3>Search indexing preferences</h3><p className="help">These saved preferences also depend on the approved domain and deployment settings.</p>
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={e => change('enabled', e.target.checked)} />Enable public discovery settings</label>
        <label className="check"><input type="checkbox" checked={form.indexing_enabled} onChange={e => change('indexing_enabled', e.target.checked)} />Allow search engines to index public pages</label>
      </section>
      <div className="visibility-savebar"><span className="help">Last saved {new Date(form.updated_at).toLocaleString()}</span><button disabled={!canWrite || busy}>{busy ? 'Saving…' : 'Save SEO settings'}</button></div>
    </fieldset><Notice error>{error}</Notice><Notice>{notice}</Notice>
    <p className="help">Manage public contact information and policies in <Link to="/system/configuration/discoverability/profile">Business profile</Link>.</p>
  </form>;
}
