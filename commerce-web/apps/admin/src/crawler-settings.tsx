import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EffectiveIndexingPolicy } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { crawlerStatus, type VisibilityStatus } from './discovery-status';
type Preferences = { revision: number; openai_search: boolean; openai_training: boolean };
async function request(body?: Preferences): Promise<Preferences> {
  const response = await fetch('/api/v1/admin/discovery/crawlers', { method: body ? 'PUT' : 'GET', credentials: 'include', cache: 'no-store', headers: body ? { 'content-type': 'application/json', 'X-Commerce-Request': '1' } : undefined, body: body ? JSON.stringify({ expected_revision: body.revision, openai_search: body.openai_search, openai_training: body.openai_training }) : undefined });
  if (!response.ok) throw new Error(response.status === 409 ? 'These preferences changed. Reload before saving.' : `Unable to load or save AI access preferences (${response.status}).`);
  return response.json() as Promise<Preferences>;
}
export function useCrawlerPreferences() { return useQuery({ queryKey: ['publication-crawlers'], queryFn: () => request(), retry: false }); }
export function StatusBadge({ status }: { status: VisibilityStatus }) { return <span className={`visibility-badge ${status.tone}`}>{status.label}</span>; }
export function CrawlerSettings({ canWrite, policy }: { canWrite: boolean; policy?: EffectiveIndexingPolicy }) {
  const query = useCrawlerPreferences();
  if (query.isPending) return <p role="status">Loading AI access preferences…</p>;
  if (!query.data) return <Notice error>{query.error?.message || 'AI access preferences are unavailable.'}</Notice>;
  return <><Notice error>{query.error?.message}</Notice><Editor initial={query.data} current={query.isError ? undefined : query.data} canWrite={canWrite} policy={policy} /></>;
}
function Editor({ initial, current, canWrite, policy }: { initial: Preferences; current?: Preferences; canWrite: boolean; policy?: EffectiveIndexingPolicy }) {
  const cache = useQueryClient();
  const [value, setValue] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function save() {
    if (!canWrite || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await request(value); setValue(saved); cache.setQueryData(['publication-crawlers'], saved);
      await Promise.all(['effective-indexing-policy', 'discovery-health'].map(key => cache.invalidateQueries({ queryKey: [key] })));
      setNotice('AI access preferences saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save AI access preferences.'); }
    finally { setBusy(false); }
  }
  return <>
    {policy && policy.state !== 'INDEXABLE' && <div className="visibility-banner warning"><strong>AI crawler access is restricted by indexing settings.</strong><p>Saved “Allow” preferences take effect only when public indexing is allowed. <Link to="/system/configuration/discoverability/seo">Review SEO settings</Link>.</p></div>}
    {!policy && <Notice error>Current crawler access is unavailable. Saved preferences do not confirm access.</Notice>}
    <section className="form-card visibility-card"><h2>AI crawler access</h2><p className="visibility-description">Manage search retrieval and model training separately for supported providers.</p>
      <fieldset disabled={!canWrite || busy}><legend className="visibility-sr-only">OpenAI crawler preferences</legend>
        <div className="visibility-crawler-heading"><span>Provider and purpose</span><span>Preference</span><span>Current status</span></div>
        {([
          { key: 'openai_search', name: 'OpenAI · Search', description: 'Allow OAI-SearchBot to retrieve public pages for search.' },
          { key: 'openai_training', name: 'OpenAI · Model training', description: 'Set whether GPTBot may crawl public pages for model training.' },
        ] as const).map(row => <div className="visibility-crawler-row" key={row.key}>
          <div><h3>{row.name}</h3><p className="help">{row.description}</p></div>
          <label><span className="visibility-sr-only">{row.name} preference</span><select value={String(value[row.key])} onChange={e => { setValue({ ...value, [row.key]: e.target.value === 'true' }); setNotice(''); }}><option value="true">Allow</option><option value="false">Block</option></select></label>
          <StatusBadge status={crawlerStatus(policy, current?.[row.key])} />
        </div>)}
        <div className="visibility-savebar"><span className="help">Current status uses saved preferences, not unsaved changes.</span><button type="button" onClick={() => void save()}>{busy ? 'Saving…' : 'Save AI access'}</button></div>
      </fieldset><Notice error>{error}</Notice><Notice>{notice}</Notice>
    </section>
    <section className="form-card visibility-card"><h2>Information available to AI</h2><p className="visibility-description">Your public pages, product information, and approved business profile help describe your store.</p><Link to="/system/configuration/discoverability/profile">Manage business profile →</Link>
      <details className="visibility-details"><summary>View crawler details</summary><p>Access preferences do not guarantee search inclusion or rankings. User-triggered ChatGPT visits may not follow robots rules.</p><p>Discovery uses public pages and XML sitemaps. An llms.txt file is not currently published.</p><a href="https://developers.openai.com/api/docs/bots" target="_blank" rel="noreferrer">OpenAI crawler documentation</a></details>
    </section>
  </>;
}
