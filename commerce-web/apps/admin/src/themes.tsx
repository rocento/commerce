import { EntityIdHeading, EntityIdCell } from "./entity-id";
import '@commerce/ui/fonts.css';
import { ThemeLanguage } from "./theme-language";
import { ThemeTranslations } from "./theme-translations";
import { ThemeDraftPreview } from "./theme-draft-preview";
import { ThemeAssetEditor, ThemePropertyEditor as PropertyEditor, ThemeSectionSettings, ThemeTranslatedProperty, type ThemeMediaResources } from "./theme-section-settings";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useLocalGrid } from "./local-grid";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { catalogApi, languagesApi, themeApi, themeAllowed, themeContract, validateTheme, themeTranslationIssues, themeTextTranslatable, type AdminIdentity, type Theme, type ThemeTargetRule, type ThemeAssignment, type ThemeConfiguration, type ThemeSection, type ThemeValue } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import './themes.css';

function PublicationDialog({ title, onCancel, children, error }: { title: string; onCancel: () => void; children: ReactNode; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="theme-confirm" aria-label={title} onCancel={onCancel}><Notice error>{error}</Notice>{children}</dialog>;
}
export function ThemesAdmin({ who, view = 'themes' }: { who: AdminIdentity; view?: 'themes' | 'assignments' }) {
  const themes = useQuery({ queryKey: ['themes'], queryFn: themeApi.list });
  const grid = useLocalGrid({ name: "themes", rows: themes.data, searchText: t => `${t.name} ${t.owner_channel}`, sorts: { name: t => t.name, updated_at: t => t.updated_at, revision: t => t.revision }, initialSort: "name", busy: themes.isFetching, error: themes.error?.message, refresh: () => void themes.refetch() });
  const channels = useQuery({ queryKey: ['theme-assignments'], queryFn: themeApi.assignments });
  const [selected, setSelected] = useState<Theme | null>(null);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('');
  const action = useAction();
  const cache = useQueryClient();
  const allowedChannels = channels.data?.filter(c => themeAllowed(who.permissions, 'create', c.channel)) || [];
  return <main className="themes-admin"><PageHeader title={<>{view === 'assignments' ? 'Channel assignments' : 'Themes'}</>} /><p className="theme-intro">{view === 'assignments' ? 'Set each channel’s default theme and manage targeted storefront experiences.' : 'Design your storefront, manage shared layouts, and tailor the experience for each channel.'}</p>
    <Notice error>{action.error || themes.error?.message || channels.error?.message}</Notice>
    {view === 'assignments' ? <>
      {channels.isPending && <p role="status">Loading channel assignments…</p>}
      {!channels.isPending && !channels.error && !channels.data?.length && <p>No channels are available to assign.</p>}
      {channels.error && <button className="secondary" onClick={() => void channels.refetch()}>Retry channel assignments</button>}
      {channels.data?.map(c => <AssignmentEditor key={`${c.channel}-${c.revision}`} assignment={c} themes={themes.data || []} who={who} />)}
    </> : selected ? <ThemeEditor key={selected.id} theme={selected} who={who} channels={channels.data || []} onClose={() => setSelected(null)} /> : <>
      {allowedChannels.length > 0 && <form className="theme-create" onSubmit={e => { e.preventDefault(); void action.run(async () => { const t = await themeApi.create(name, channel || allowedChannels[0].channel); await cache.invalidateQueries({ queryKey: ['themes'] }); setSelected(t); setName(''); }); }}>
        <label className="field"><span>Theme name</span><input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Owner channel</span><select value={channel || allowedChannels[0].channel} onChange={e => setChannel(e.target.value)}>{allowedChannels.map(c => <option key={c.channel}>{c.channel}</option>)}</select></label>
        <button disabled={action.busy}>Create theme</button>
      </form>}
      {grid.controls}
      {themes.isPending ? <p role="status">Loading themes...</p> : <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Name</th><th>Owner</th><th>Status</th><th>Revision</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{grid.data.map(t => <tr key={t.id}><EntityIdCell row={t}/><td>{t.name}</td><td>{t.owner_channel}</td><td><span className="badge">{!t.published_version ? 'Draft' : channels.data?.some(c => c.theme_id === t.id || c.rules?.some(r => r.enabled && r.theme_id === t.id)) ? 'Active' : 'Published · unassigned'}</span></td><td>{t.revision}</td><td>{new Date(t.updated_at).toLocaleString()}</td><td><RowActions label={t.name} items={[{ label: "Open theme", onSelect: () => setSelected(t) }]} /></td></tr>)}</tbody></table>{grid.data.length === 0 && <p>No themes match these filters.</p>}</div>}

    </>}
  </main>;
}
function AssignmentEditor({ assignment: a, themes, who }: { assignment: ThemeAssignment; themes: Theme[]; who: AdminIdentity }) {
  const [id, setId] = useState(a.theme_id || '');
  const [rules, setRules] = useState<ThemeTargetRule[]>(a.rules || []);
  const action = useAction();
  const cache = useQueryClient();
  const options = useQuery({ queryKey: ['theme-target-options', a.channel], queryFn: () => themeApi.targetOptions(a.channel) });
  const canAssign = themeAllowed(who.permissions, 'assign', a.channel);
  const published = themes.filter(t => t.published_version && themeAllowed(who.permissions, 'assign', t.owner_channel));
  const update = (index: number, patch: Partial<ThemeTargetRule>) => setRules(items => items.map((r, i) => i === index ? { ...r, ...patch } : r));
  const dirty = id !== (a.theme_id || '') || JSON.stringify(rules) !== JSON.stringify(a.rules || []);
  const invalid = rules.some(r => !r.theme_id || !(r.segment_id || r.area_id) || !!r.stock_id || !!r.city?.trim());
  const themeOptions = (current: string) => <><option value="">Select published theme</option>{current && !published.some(t => t.id === current) && <option value={current}>Assigned theme</option>}{published.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</>;
  return <form className="theme-target-assignment" onSubmit={e => { e.preventDefault(); if (invalid || !canAssign || action.busy) return; void action.run(async () => { await themeApi.assign(a.channel, a.revision, id || null, rules.map(r => ({ ...r, stock_id: null, city: null }))); await cache.invalidateQueries({ queryKey: ['theme-assignments'] }); await cache.invalidateQueries({ queryKey: ['themes'] }); }); }}>
    <div className="theme-channel-heading"><h2>{a.channel === 'storefront' ? 'Storefront' : a.channel}</h2><span className="badge">Channel</span></div>
    <section className="theme-default-section" aria-label={`${a.channel} default theme`}><div className="theme-assignment-section-title"><span>01</span><div><h3>{a.channel === 'storefront' ? 'Storefront default theme' : 'Default theme'}</h3><p>The base experience for shoppers who do not match a targeting rule.</p></div></div>
    <label className="field"><span>Default theme</span><select disabled={!canAssign || action.busy} value={id} onChange={e => setId(e.target.value)}><option value="">Built-in default</option>{a.theme_id && !published.some(t => t.id === a.theme_id) && <option value={a.theme_id}>Assigned theme</option>}{published.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label>
    <div className="theme-default-summary"><span className="theme-default-icon" aria-hidden="true">◈</span><div><strong>{id ? themes.find(theme => theme.id === id)?.name || 'Assigned theme' : 'Built-in default'}</strong><small>{id ? 'Published theme · default experience' : 'Uses the built-in storefront appearance'}</small></div><span className="badge">Default</span></div>
    </section>
    <section className="theme-targeted-section" aria-label={`${a.channel} targeted experiences`}><div className="theme-assignment-section-title"><span>02</span><div><h3>Targeted storefront experiences</h3><p>Override the default for specific audiences and delivery areas.</p></div></div><p>Multiple published themes can serve shoppers at the same time. Target each experience by customer segment, delivery area, or both. The first matching enabled rule wins; all selected conditions must match. Shoppers who match no rule receive the default theme. Segment rules require a signed-in customer; delivery-area rules use the shopper’s pinned delivery location.</p>
    {!rules.length && <div className="theme-targeted-empty">No targeting rules. All shoppers receive the default theme.</div>}
    {rules.map((rule, index) => <fieldset key={rule.id} disabled={!canAssign || action.busy} className="theme-target-rule"><legend>Rule {index + 1}</legend>
      <label className="check"><input type="checkbox" checked={rule.enabled} onChange={e => update(index, { enabled: e.target.checked })}/>Enabled</label>
      <div className="theme-target-fields">
        <label className="field">Theme<select required value={rule.theme_id} onChange={e => update(index, { theme_id: e.target.value })}>{themeOptions(rule.theme_id)}</select></label>
        <label className="field">Customer segment<select value={rule.segment_id || ''} onChange={e => update(index, { segment_id: e.target.value || null })}><option value="">All customers, including guests</option>{rule.segment_id && !options.data?.segments.some(s => s.id === rule.segment_id) && <option value={rule.segment_id}>Inactive or unavailable segment</option>}{options.data?.segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field">Delivery area<select value={rule.area_id || ''} onChange={e => update(index, { area_id: e.target.value || null })}><option value="">Any delivery area</option>{rule.area_id && !options.data?.areas.some(s => s.id === rule.area_id) && <option value={rule.area_id}>Unavailable delivery area</option>}{options.data?.areas.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_active ? '' : ' (inactive)'}</option>)}</select></label>
      </div>
      {(rule.stock_id || rule.city) && <div className="theme-errors" role="status"><p>This saved rule contains legacy stock or city targeting. Choose a customer segment or delivery area, then remove the legacy conditions before saving. This changes which shoppers match this rule.</p><button type="button" className="secondary" onClick={() => update(index, { stock_id: null, city: null })}>Remove legacy targeting conditions</button></div>}
      {!(rule.segment_id || rule.area_id) && <p className="help">Select at least one customer segment or delivery area.</p>}
      <div className="theme-actions"><button type="button" className="secondary" disabled={index === 0} onClick={() => setRules(items => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>Move up</button><button type="button" className="secondary" onClick={() => setRules(items => items.filter((_, i) => i !== index))}>Remove rule</button></div>
    </fieldset>)}
    <div className="theme-actions">{canAssign && <button type="button" className="secondary" disabled={rules.length >= 30 || action.busy} onClick={() => setRules(items => [...items, { id: crypto.randomUUID(), theme_id: published[0]?.id || '', enabled: true, segment_id: null, area_id: null, stock_id: null, city: null }])}>Add targeting rule</button>}</div>
    </section>
    <div className="theme-assignment-save"><span>{dirty ? 'Unsaved channel assignment changes' : 'Channel assignments are up to date'}</span><button disabled={!canAssign || action.busy || !dirty || invalid}>{action.busy ? 'Saving…' : 'Save assignment'}</button></div>
    <Notice error>{action.error || options.error?.message}</Notice>
  </form>;
}
export function ThemeEditor({ theme: initial, who, channels, onClose }: { theme: Theme; who: AdminIdentity; channels: ThemeAssignment[]; onClose: () => void }) {
  const [theme, setTheme] = useState(initial);
  const [config, setConfig] = useState<ThemeConfiguration>(structuredClone(initial.configuration));
  const [tab, setTab] = useState<'sections' | 'translations' | 'fonts' | 'tokens' | 'history' | 'preview'>('sections');
  const [location, setLocation] = useState('home');
  const [preview, setPreview] = useState(0);
  const [device, setDevice] = useState('desktop');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [newComponent, setNewComponent] = useState('');
  const [openedSection, setOpenedSection] = useState('');
  const [removedSection, setRemovedSection] = useState<{ section: ThemeSection; index: number; location: string } | null>(null);
  const cache = useQueryClient();
  const action = useAction();
  const versions = useQuery({ queryKey: ['theme-versions', theme.id], queryFn: () => themeApi.versions(theme.id), enabled: tab === 'history' });
  const canReadCatalog = who.permissions.includes('*') || who.permissions.includes('catalog.read');
  const media = useQuery({ queryKey: ['catalog', 'media'], queryFn: catalogApi.mediaList, enabled: tab === 'sections' && canReadCatalog, retry: false });
  const resources: ThemeMediaResources = { media: media.data ?? [], mediaLoading: media.isPending, mediaError: media.error?.message, retryMedia: () => void media.refetch(), canReadCatalog };
  const can = (op: string) => themeAllowed(who.permissions, op, theme.owner_channel);
  const [translationLocale, setTranslationLocale] = useState('');
  const themeLanguages = useQuery({queryKey:['public-languages'],queryFn:languagesApi.public});
  const selectedLanguage = themeLanguages.data?.languages.find(language => language.locale === translationLocale && language.locale !== themeLanguages.data?.source_locale);
  useEffect(() => {
    if (themeLanguages.data && translationLocale && !selectedLanguage) setTranslationLocale('');
  }, [themeLanguages.data, translationLocale, selectedLanguage]);
  const translationIssues = themeTranslationIssues(config);
  const tabs = (['sections', 'translations', 'fonts', 'tokens', 'history', 'preview'] as const).filter(t => t !== 'preview' || can('preview'));
  const canPublish = (op: string) => can(op) && channels.filter(c => c.theme_id === theme.id || c.rules?.some(r => r.theme_id === theme.id)).every(c => themeAllowed(who.permissions, op, c.channel));
  const dirty = JSON.stringify(config) !== JSON.stringify(theme.configuration);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const sections = location === 'top' || location === 'bottom' ? config.global[location] : config.pages[location as keyof typeof config.pages];
  const available = Object.entries(themeContract.components).filter(([key,d]) => d.locations.includes(location) && !d.required && !['header_options', 'footer_options', 'catalog_filters'].includes(key));
  const errors = validateTheme(config);
  function updateSections(next: ThemeSection[]) {
    setConfig(c => location === 'top' || location === 'bottom' ? { ...c, global: { ...c.global, [location]: next } } : { ...c, pages: { ...c.pages, [location]: next } });
  }
  const optionsComponent = location === 'top' ? 'header_options' : location === 'bottom' ? 'footer_options' : ['category', 'search'].includes(location) ? 'catalog_filters' : null;
  const optionsSection = sections.find(s => s.component === optionsComponent);
  function setOption(key: string, value: ThemeValue) {
    if (!optionsComponent) return;
    if (optionsSection) updateSections(sections.map(s => s.id === optionsSection.id ? { ...s, enabled: true, settings: { ...s.settings, [key]: value } } : s));
    else updateSections([...sections, { id: crypto.randomUUID(), component: optionsComponent, version: 1, enabled: true, settings: { ...Object.fromEntries(Object.entries(themeContract.components[optionsComponent].settings).map(([k,p]) => [k,p.default])), [key]: value } }]);
  }
  const optionGroups = optionsComponent === 'footer_options' ? [['Footer style', /^style$/], ['Service highlights', /^(show_services|service_)/], ['Customer care column', /^column_1_/], ['Account column', /^column_2_/], ['Discovery column', /^column_3_/], ['Newsletter link', /^(newsletter_|show_newsletter)/], ['Brand & copyright', /^(show_brand|copyright|back_to_top_label)/], ['App installation', /^install_/]] as const : [['Display settings', /.*/]] as const;
  const inheritedFilter = config.global.top.find(s => s.enabled && s.component === 'catalog_filters')?.settings.layout || 'vertical';
  async function refresh() { const t = await themeApi.get(theme.id); setTheme(t); await cache.invalidateQueries({ queryKey: ['themes'] }); await cache.invalidateQueries({ queryKey: ['theme-versions', theme.id] }); }
  async function save() { const submitted = config; const t = await themeApi.save(theme.id, theme.revision, submitted); setTheme(t); setConfig(current => current === submitted ? structuredClone(t.configuration) : current); await cache.invalidateQueries({ queryKey: ['themes'] }); return t; }
  return <>
    <div className="theme-editor-heading"><div><button className="text-button" onClick={() => { if (!dirty || window.confirm('Discard unsaved changes?')) onClose(); }}>Back to themes</button><h2>{theme.name}</h2><span className="muted">{theme.owner_channel} · Revision {theme.revision}{dirty ? ' · Unsaved changes' : ''}</span></div><div className="theme-actions">
      {can('create') && <button className="secondary" disabled={action.busy || dirty} onClick={() => action.run(async () => { await themeApi.create(`${theme.name.slice(0,100)} copy`, theme.owner_channel, theme.id); await cache.invalidateQueries({ queryKey: ['themes'] }); setMessage('Theme duplicated.'); })}>Duplicate</button>}
      {can('edit') && <button disabled={action.busy || !dirty || errors.length > 0} onClick={() => action.run(async () => { await save(); setMessage('Draft saved.'); })}>Save draft</button>}
      <button className="secondary" disabled={action.busy || dirty} onClick={() => action.run(async () => { await themeApi.validate(theme.id); setMessage('Theme validation passed.'); })}>Validate</button>
      {canPublish('publish') && <button disabled={action.busy || dirty || errors.length > 0 || translationIssues.length > 0} onClick={() => setConfirm('publish')}>Publish</button>}
    </div></div>
    <ThemeLanguage languages={themeLanguages.data} locale={selectedLanguage?.locale ?? ''} onChange={setTranslationLocale} loading={themeLanguages.isPending} error={themeLanguages.error?.message} onRetry={() => void themeLanguages.refetch()}/>
    <Notice error>{action.error || versions.error?.message}</Notice><Notice>{message}</Notice>
    {errors.length > 0 && <div role="alert" className="theme-errors">{errors.slice(0,8).map((e,i) => <p key={i}>{e}</p>)}</div>}
    {translationIssues.length > 0 && <Notice error>{translationIssues.length} translations need review after source changes. Open Translations to review them before publishing.</Notice>}
    {confirm && <PublicationDialog title={confirm === 'publish' ? 'Publish theme' : 'Rollback theme'} error={action.error} onCancel={() => setConfirm(null)}><h3>{confirm === 'publish' ? 'Publish this draft?' : 'Publish this historical version?'}</h3><p>Assigned channels: {channels.filter(c => c.theme_id === theme.id || c.rules?.some(r => r.theme_id === theme.id)).map(c => c.channel).join(', ') || 'None'}</p><button disabled={action.busy} onClick={() => action.run(async () => { await themeApi.publish(theme.id, theme.revision, confirm === 'publish' ? undefined : confirm); setConfirm(null); await refresh(); setMessage('New version published.'); })}>Confirm publication</button><button className="secondary" onClick={() => setConfirm(null)}>Cancel</button></PublicationDialog>}
    <div className="theme-tabs" role="tablist" aria-label="Theme views">{tabs.map((t, index) => <button key={t} id={`theme-tab-${t}`} role="tab" aria-controls="theme-panel" tabIndex={tab === t ? 0 : -1} aria-selected={tab === t} onClick={() => setTab(t)} onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[next]);
      e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
    }}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
    <div id="theme-panel" role="tabpanel" aria-labelledby={`theme-tab-${tab}`}>
    {tab === 'translations' && <ThemeTranslations configuration={config} disabled={!can('edit') || action.busy} locale={selectedLanguage?.locale ?? ''} languages={themeLanguages.data} onChange={setConfig}/>}
    {tab === 'fonts' && <section className="theme-options-card theme-font-settings"><div className="theme-options-heading"><h3>Storefront fonts</h3><p>Each theme keeps its current fonts. Choose body and heading fonts below; Arabic can use its own fonts without changing the English experience. Save the draft and publish when ready.</p></div>{([['Theme fonts', ['font.body', 'font.heading']], ['Arabic fonts', ['font.arabic.body', 'font.arabic.heading']]] as const).map(([title, keys]) => <fieldset key={String(title)}><legend>{title}</legend><div className="theme-settings">{keys.map(key => <PropertyEditor key={key} name={key} property={themeContract.tokens[key]} value={config.tokens[key] ?? themeContract.tokens[key].default} disabled={!can('edit')} onChange={value => setConfig(current => ({...current, tokens:{...current.tokens, [key]:value}}))}/>)}</div></fieldset>)}<div className="theme-font-samples"><p style={{fontFamily:String(config.tokens['font.body'])}}>Fresh choices, delivered to your door</p><p lang="ar" dir="rtl" style={{fontFamily:String(config.tokens['font.arabic.body'] && config.tokens['font.arabic.body'] !== 'inherit' ? config.tokens['font.arabic.body'] : config.tokens['font.body'])}}>اختيارات طازجة تصلك إلى باب منزلك</p></div><p className="theme-field-help">Use theme font preserves the existing font and its normal Arabic fallback. Font changes stay private until this theme is published.</p></section>}
    {tab === 'tokens' && <div className="theme-token-grid">{Object.entries(themeContract.tokens).map(([key,p]) => <PropertyEditor key={key} name={key} property={p} value={config.tokens[key]} disabled={!can('edit')} onChange={v => setConfig(c => ({ ...c, tokens: { ...c.tokens, [key]: v } }))} />)}</div>}
    {tab === 'sections' && <><nav className="theme-layout-nav" aria-label="Storefront layouts">{[['top', 'Global header'], ['home', 'Home'], ['category', 'Category'], ['search', 'Search'], ['product', 'Product'], ['cart', 'Cart'], ['bottom', 'Global footer']].map(([key, title]) => <button key={key} className="secondary" aria-pressed={location === key} onClick={() => { setLocation(key); setNewComponent(''); }}>{title}</button>)}</nav><label className="field theme-location"><span>Layout</span><select value={location} onChange={e => { setLocation(e.target.value); setNewComponent(''); }}>{['top','home','category','product','search','cart','bottom'].map(l => <option key={l} value={l}>{l === 'top' ? 'Global header' : l === 'bottom' ? 'Global footer' : l[0].toUpperCase() + l.slice(1)}</option>)}</select></label>
      {optionsComponent && <section className="theme-options-card"><div className="theme-options-heading"><h3>{location === 'top' ? 'Header behavior & branding' : location === 'bottom' ? 'Footer content & navigation' : 'Product filters'}</h3><p>{location === 'top' ? 'Shared across storefront pages. Search, account and cart remain available.' : location === 'bottom' ? 'Service highlights, grouped links and a newsletter destination. Use existing store pages for links; the newsletter destination should lead to your signup page.' : 'Choose a horizontal bar above products or a vertical sidebar. Small screens use the responsive filter controls.'}</p></div>
        {optionsComponent === 'catalog_filters' ? <div className="theme-filter-choices">{['horizontal', 'vertical'].map(value => <button key={value} disabled={!can('edit')} aria-pressed={(optionsSection?.enabled ? optionsSection.settings.layout : inheritedFilter) === value} className="secondary" onClick={() => setOption('layout', value)}><span className={`theme-layout-diagram ${value}`} aria-hidden="true"><i/><b/><b/><b/><b/></span><strong>{value === 'horizontal' ? 'Horizontal filters' : 'Vertical filters'}</strong><small>{value === 'horizontal' ? 'More room for the product grid' : 'Filters alongside the products'}</small></button>)}</div> : <div className="theme-option-groups">{optionGroups.map(([title, pattern]) => <fieldset key={title}><legend>{title}</legend><div className="theme-settings">{Object.entries(themeContract.components[optionsComponent].settings).filter(([key]) => pattern.test(key)).map(([key,p]) => p.kind === 'asset' ? <ThemeAssetEditor key={key} name="Logo" value={optionsSection?.settings[key] ?? p.default} disabled={!can('edit')} resources={resources} onChange={value => setOption(key, value)} /> : selectedLanguage && themeTextTranslatable(key,p) ? <ThemeTranslatedProperty key={key} section={optionsSection ? {...optionsSection,settings:{...Object.fromEntries(Object.entries(themeContract.components[optionsComponent].settings).map(([name,property])=>[name,property.default])),...optionsSection.settings}} : {id:'inherited',component:optionsComponent,version:themeContract.components[optionsComponent].version,enabled:true,settings:Object.fromEntries(Object.entries(themeContract.components[optionsComponent].settings).map(([name,property])=>[name,property.default]))}} name={key} property={p} language={selectedLanguage} disabled={!can('edit')} onChange={section => updateSections(optionsSection ? sections.map(item => item.id === optionsSection.id ? {...section,enabled:true} : item) : [...sections,{...section,id:crypto.randomUUID()}])}/> : <PropertyEditor key={key} name={key} property={p} value={optionsSection?.settings[key] ?? p.default} disabled={!can('edit')} canReadCatalog={canReadCatalog} onChange={value => setOption(key,value)} />)}</div></fieldset>)}</div>}
        {optionsComponent === 'catalog_filters' && optionsSection && <button className="text-button" disabled={!can('edit')} onClick={() => updateSections(sections.filter(s => s.id !== optionsSection.id))}>Use global default ({String(inheritedFilter)})</button>}
      </section>}
      <div className="theme-sections-heading"><div><h3>Layout sections</h3><p>Choose the content, source and appearance of each section.</p></div><span>{sections.length} / 30 sections</span></div>
      {removedSection && <div className="theme-section-undo" role="status"><span>{themeContract.components[removedSection.section.component].label} removed from {removedSection.location}.</span><button type="button" className="text-button" disabled={!can('edit') || (removedSection.location === 'top' || removedSection.location === 'bottom' ? config.global[removedSection.location] : config.pages[removedSection.location as keyof typeof config.pages]).length >= 30} onClick={() => {
        const { section, index, location: target } = removedSection;
        setConfig(current => {
          const restore = (items: ThemeSection[]) => { const next = [...items]; next.splice(Math.min(index, next.length), 0, section); return next; };
          return target === 'top' || target === 'bottom' ? { ...current, global: { ...current.global, [target]: restore(current.global[target]) } } : { ...current, pages: { ...current.pages, [target]: restore(current.pages[target as keyof typeof current.pages]) } };
        });
        setRemovedSection(null);
      }}>Undo removal</button></div>}
      <div className="theme-sections">{sections.map((s,index) => {
        if (['header_options', 'footer_options'].includes(s.component) || s.component === 'catalog_filters' && location !== 'top') return null;
        const def = themeContract.components[s.component];
        return <details key={s.id} className="theme-section-editor" open={!!def.required || openedSection === s.id}>
          <summary><span className="theme-section-title">{def.label}{s.settings.heading && <small>{String(s.settings.heading)}</small>}</span><span className="theme-section-state">{def.required ? 'Required' : s.enabled ? 'Enabled' : 'Disabled'}</span></summary>
          <div className="theme-section-controls"><label className="checkbox"><input type="checkbox" checked={s.enabled} disabled={!can('edit') || def.required} onChange={e => updateSections(sections.map(x => x.id === s.id ? { ...x, enabled: e.target.checked } : x))} />Enabled</label>
            <button type="button" className="icon-button" aria-label={`Move ${def.label} up`} title="Move up" disabled={!can('edit') || index === 0} onClick={() => { const next = [...sections]; [next[index-1],next[index]] = [next[index],next[index-1]]; updateSections(next); }}>↑</button>
            <button type="button" className="icon-button" aria-label={`Move ${def.label} down`} title="Move down" disabled={!can('edit') || index === sections.length-1} onClick={() => { const next = [...sections]; [next[index+1],next[index]] = [next[index],next[index+1]]; updateSections(next); }}>↓</button>
            {!def.required && <button type="button" className="secondary" aria-label={`Duplicate ${def.label}`} disabled={!can('edit') || sections.length >= 30} onClick={() => { const copy = { ...structuredClone(s), id: crypto.randomUUID() }; const next = [...sections]; next.splice(index + 1, 0, copy); updateSections(next); setOpenedSection(copy.id); }}>Duplicate section</button>}
            <button type="button" className="icon-button" aria-label={`Remove ${def.label}`} title="Remove section" disabled={!can('edit') || def.required} onClick={() => { setRemovedSection({ section: s, index, location }); updateSections(sections.filter(x => x.id !== s.id)); }}>×</button>
          </div>
          <ThemeSectionSettings section={s} disabled={!can('edit')} resources={resources} language={selectedLanguage} onTranslationChange={section => updateSections(sections.map(x => x.id === section.id ? section : x))} onChange={settings => updateSections(sections.map(x => x.id === s.id ? { ...x, settings } : x))} />
        </details>;
      })}</div>
      {can('edit') && available.length > 0 && <div className="theme-add-section"><label className="field"><span>Section type</span><select aria-label="New component" value={newComponent || available[0][0]} onChange={e => setNewComponent(e.target.value)}>{available.map(([key,d]) => <option key={key} value={key}>{d.label}</option>)}</select></label><button disabled={sections.length >= 30} onClick={() => { const component = newComponent || available[0][0]; const d = themeContract.components[component]; const id = crypto.randomUUID(); updateSections([...sections, { id, component, version: d.version, enabled: true, settings: Object.fromEntries(Object.entries(d.settings).map(([k,p]) => [k,p.default])) }]); setOpenedSection(id); }}>Add section</button></div>}
    </>}
    {tab === 'history' && <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Version</th><th>Published</th><th>Actor</th><th>Source</th><th /></tr></thead><tbody>{versions.data?.map(v => <tr key={v.id}><EntityIdCell row={v}/><td>V{v.number}{v.id === theme.published_version ? ' · Live' : ''}</td><td>{new Date(v.published_at).toLocaleString()}</td><td>{v.created_by}</td><td>{v.source_version ? 'Rollback' : 'Draft'}</td><td>{canPublish('rollback') && <RowActions label={`version ${v.number}`} items={[{label:"Rollback",disabled:dirty||action.busy,reason:dirty?"Save or discard draft changes first":undefined,destructive:true,onSelect:()=>setConfirm(v.id)}]}/>}<details><summary>Configuration</summary><pre>{JSON.stringify(v.configuration,null,2)}</pre></details></td></tr>)}</tbody></table>{versions.data?.length === 0 && <p>No published versions.</p>}</div>}
    {tab === 'preview' && <><div className="theme-actions"><button disabled={action.busy || (dirty && (!can('edit') || errors.length > 0))} onClick={() => action.run(async () => { if (dirty) await save(); setPreview(v => v+1); })}>{dirty ? 'Save and preview' : 'Refresh preview'}</button></div><label className="field theme-location">Preview size<select value={device} onChange={e => setDevice(e.target.value)}><option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="mobile">Mobile</option></select></label><ThemeDraftPreview key={`${preview}-${translationLocale}`} locale={selectedLanguage?.locale || themeLanguages.data?.source_locale || 'en'} id={theme.id} revision={preview} name={theme.name} device={device} /></>}
    </div>
  </>;
}
