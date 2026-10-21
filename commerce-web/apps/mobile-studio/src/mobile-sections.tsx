import { useId, useState, type ReactNode } from 'react';
import './mobile-sections.css';
import type { MobileConfig, MobileIssue, MobileSection } from '@commerce/api-client';
import { appendSection, moveSection, sectionNames, sectionTypes } from './mobile-studio-model';
import { appendLayout, componentCatalog, duplicateSection, layoutPresets, SECTION_LIMIT, sectionTextKey, sectionTitle, updateSectionText, updateEditorialText } from './mobile-section-library';

function ComponentIcon({ type }: { type: MobileSection['type'] }) {
  return <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {type === 'heroBanner' ? <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-4 4 3 4-6 5 7"/></> :
    type === 'richText' ? <><path d="M4 5h16M12 5v14M8 19h8M4 5v3M20 5v3"/></> :
    type === 'spacer' ? <><path d="M4 3h16M4 21h16M12 7v10m-3-7 3-3 3 3m-6 4 3 3 3-3"/></> :
    type === 'productCarousel' ? <><rect x="7" y="4" width="10" height="16" rx="2"/><path d="M3 6v12M21 6v12M10 15h4"/></> :
    <><rect x="3" y="3" width="7" height="7" rx={type === 'categoryGrid' ? 3 : 1}/><rect x="14" y="3" width="7" height="7" rx={type === 'categoryGrid' ? 3 : 1}/><rect x="3" y="14" width="7" height="7" rx={type === 'categoryGrid' ? 3 : 1}/><rect x="14" y="14" width="7" height="7" rx={type === 'categoryGrid' ? 3 : 1}/></>}
  </svg>;
}
export function MobileSections({ config, section, disabled, issues, change, select, settings, addGroceryDemos }: {
  config: MobileConfig; section: MobileSection; disabled: boolean; issues: MobileIssue[];
  change: (config: MobileConfig) => void; select: (id: string) => void; settings: ReactNode; addGroceryDemos?: () => void;
}) {
  const libraryId = useId();
  const [library, setLibrary] = useState(false), [query, setQuery] = useState(''), [group, setGroup] = useState('All'), [dragged, setDragged] = useState<string>(), [remove, setRemove] = useState<string>();
  const sections = config.screens.home.sections, index = sections.findIndex(s => s.id === section.id), key = sectionTextKey(section);
  const localIssues = issues.filter(i => i.path.startsWith(`/screens/home/sections/${index}/`) || i.path === `/screens/home/sections/${index}`);
  function add(type: MobileSection['type']) {
    if (disabled || sections.length >= SECTION_LIMIT) return;
    const next = appendSection(config, type); change(next); select(next.screens.home.sections.at(-1)!.id); setLibrary(false);
  }
  return <div className="ms-section-builder">
    <div className="ms-builder-summary"><div><strong>Build your home screen</strong><span>Arrange native components, then refine their content and behavior.</span></div><button type="button" className="ms-primary" onClick={() => setLibrary(!library)} aria-controls={libraryId} aria-expanded={library}>{library ? 'Close library' : 'Component library'}</button></div>
    {library && <section id={libraryId} className="ms-component-library" aria-label="Component library">
      <div className="ms-library-heading"><span className="ms-sections-eyebrow">COMPONENT LIBRARY</span><h3>Start with the right building block</h3><p className="ms-help">Six components shared by your mobile apps. New sections are added below your existing content.</p></div>
      <label>Search components<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Banner, products, text…"/></label>
      <div className="ms-library-filters" aria-label="Component categories">{['All', 'Commerce', 'Campaigns', 'Content'].map(g => <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}</div>
      <div className="ms-component-cards">{sectionTypes.filter(t => (group === 'All' || componentCatalog[t].group === group) && `${sectionNames[t]} ${componentCatalog[t].description}`.toLowerCase().includes(query.toLowerCase())).map(type => <button key={type} className="ms-component-card" disabled={disabled || sections.length >= SECTION_LIMIT} onClick={() => add(type)} aria-label={`Add ${sectionNames[type]}`}><ComponentIcon type={type}/><span><strong>{sectionNames[type]}</strong><small>{componentCatalog[type].description}</small></span><span aria-hidden="true">+</span></button>)}</div>
      {!sectionTypes.some(t => (group === 'All' || componentCatalog[t].group === group) && `${sectionNames[t]} ${componentCatalog[t].description}`.toLowerCase().includes(query.toLowerCase())) && <p className="ms-help">No components match your search.</p>}
      <div className="ms-layout-collection"><h3>Ready-made layouts</h3><p className="ms-help">Layouts add sections below your current content. Set your own images and choose catalog categories before publishing.</p>
      {addGroceryDemos && <div className="ms-layout-preset"><strong>Grocery banner showcase</strong><p>Tall fresh-produce carousel + wide breakfast banner, with optimized artwork and English / Arabic copy.</p><button disabled={disabled || sections.length > 28} onClick={addGroceryDemos}>Add grocery banner demos</button></div>}
      {layoutPresets.map(p => <div className="ms-layout-preset" key={p.id}><strong>{p.name}</strong><p>{p.description}</p><span>{p.sections.length} sections · English + Arabic</span><button disabled={disabled || sections.length + p.sections.length > SECTION_LIMIT} onClick={() => { const next = appendLayout(config, p.id); change(next); select(next.screens.home.sections[sections.length].id); setLibrary(false); }}>Add {p.name}</button></div>)}
    </div></section>}
    <div className="ms-sections-workspace">
    <section className="ms-section-outline" aria-label="Home screen structure">
    <header className="ms-outline-heading"><div><span className="ms-sections-eyebrow">STRUCTURE</span><h3>Home screen</h3></div><span className="ms-section-count">{sections.length} / {SECTION_LIMIT}</span></header>
    <label className="ms-field">Home presentation<select aria-label="Home presentation" disabled={disabled} value={config.screens.home.layout || 'standard'} onChange={e=>{const next=structuredClone(config);next.screens.home.layout=e.target.value as 'standard'|'storefront';change(next);}}><option value="standard">Standard mobile home</option><option value="storefront">Demo storefront layout</option></select></label>
    {config.screens.home.layout === "storefront" && <p className="ms-hint">These editorial layouts require native app runtime 1.2.0 before publishing to installed apps.</p>}
    <p className="ms-help">Choose a section to edit. Drag to reorder, or use the arrow buttons.</p>
    <ol className="ms-section-list" aria-label="Home sections">{sections.map((s, i) => <li key={s.id} draggable={!disabled} onDragStart={() => setDragged(s.id)} onDragEnd={() => setDragged(undefined)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!disabled && dragged) change(moveSection(config, sections.findIndex(item => item.id === dragged), i)); setDragged(undefined); }} className={s.id === section.id ? 'is-active' : ''}>
      <button onClick={() => { select(s.id); setRemove(undefined); }} aria-pressed={s.id === section.id}><span className="ms-section-position" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><ComponentIcon type={s.type}/><span>{sectionNames[s.type]}<small>{sectionTitle(config, s) || (s.type === 'spacer' ? `${s.props.size} spacing` : s.id)}</small></span></button>
      <div><button aria-label={`Move ${s.id} up`} disabled={disabled || i === 0} onClick={() => change(moveSection(config, i, i - 1))}>↑</button><button aria-label={`Move ${s.id} down`} disabled={disabled || i === sections.length - 1} onClick={() => change(moveSection(config, i, i + 1))}>↓</button></div>
    </li>)}</ol>
    <label className="ms-field">Add section<select aria-label="Add section" value="" disabled={disabled || sections.length >= SECTION_LIMIT} onChange={e => add(e.target.value as MobileSection['type'])}><option value="">Choose a component…</option>{sectionTypes.map(t => <option key={t} value={t}>{sectionNames[t]}</option>)}</select></label>
    {sections.length >= SECTION_LIMIT && <p className="ms-help">The home screen has reached its 30-section limit.</p>}
    <p className="ms-outline-note">This order is shared by your native apps. Use Native Preview to check the running app.</p>
    </section>
    <section className="ms-section-inspector" aria-label="Selected section settings">
    <div className="ms-inspector-heading"><ComponentIcon type={section.type}/><div><span className="ms-sections-eyebrow">EDIT SECTION</span><h3>{sectionNames[section.type]}</h3><small>Section {index + 1} of {sections.length} · {componentCatalog[section.type].group}</small></div></div>
    <p className="ms-help">{componentCatalog[section.type].description}</p>
    {localIssues.length > 0 && <div className="ms-error" role="status"><strong>Section needs attention</strong><ul>{localIssues.map((issue, i) => <li key={i}>{issue.code.replaceAll('_', ' ')} — {issue.path.split('/').at(-1)}</li>)}</ul></div>}
    <fieldset className="ms-section-fields" disabled={disabled}>
      <div className="ms-section-content-column">
      {key && <div className="ms-settings-group"><h4>{section.type === 'heroBanner' ? 'Image description & accessibility' : 'Content & translations'}</h4><p className="ms-help">Edit this section’s copy directly. English and Arabic are saved together with the layout.</p>{(['en', 'ar'] as const).filter(locale => config.localization.supportedLocales.includes(locale)).map(locale => <label className="ms-field" key={locale}>{locale === 'en' ? 'English content' : 'Arabic content'}<textarea aria-label={locale === 'en' ? 'English content' : 'Arabic content'} dir={locale === 'ar' ? 'rtl' : 'ltr'} lang={locale} rows={section.type === 'richText' ? 4 : 2} maxLength={2000} value={config.localization.messages[locale]?.[key] || ''} onChange={e => change(updateSectionText(config, section.id, locale, e.target.value))}/><small>{(config.localization.messages[locale]?.[key] || '').length} / 2000</small></label>)}</div>}
      {(section.type === 'heroBanner' || section.type === 'richText') && <details className="ms-settings-group ms-editorial-options" open={Boolean(section.props.appearance)}><summary>Editorial content</summary><label className="ms-field">Presentation<select value={section.props.appearance || 'standard'} onChange={e=>{const next=structuredClone(config),s=next.screens.home.sections[index];if(s.type !== 'heroBanner' && s.type !== 'richText')return;if(e.target.value==='standard')delete s.props.appearance;else{s.props.appearance=e.target.value as 'editorial'|'campaign';}change(next);}}><option value="standard">Standard</option><option value="editorial">Editorial story</option><option value="campaign">Campaign banner</option></select></label>{section.props.appearance && <>{(['headingKey','bodyKey','eyebrowKey','labelKey'] as const).map(field=><div key={field}>{(['en','ar'] as const).map(locale=><label className="ms-field" key={locale}>{({headingKey:'Heading',bodyKey:'Body',eyebrowKey:'Eyebrow',labelKey:'Button label'})[field]} · {locale}<textarea dir={locale==='ar'?'rtl':'ltr'} maxLength={2000} value={config.localization.messages[locale]?.[section.props[field] || ''] || ''} onChange={e=>change(updateEditorialText(config,section.id,field,locale,e.target.value))}/></label>)}</div>)}<label className="ms-field">Storefront button destination<input placeholder="/search" value={section.props.storefrontPath || ''} onChange={e=>{const next=structuredClone(config),s=next.screens.home.sections[index];if(s.type==='heroBanner'||s.type==='richText'){if(e.target.value)s.props.storefrontPath=e.target.value;else delete s.props.storefrontPath;}change(next);}}/></label></>}</details>}
      {!key && <div className="ms-section-content-note"><ComponentIcon type={section.type}/><h4>A little breathing room</h4><p>This component adds empty space between sections. Choose its size in component settings.</p></div>}
      </div>
      <div className="ms-settings-group ms-section-component-settings"><h4>Component settings</h4>{settings}</div>
      <div className="ms-section-actions"><button disabled={sections.length >= SECTION_LIMIT} onClick={() => { const next = duplicateSection(config, section.id); change(next); select(next.screens.home.sections[index + 1].id); }}>Duplicate section</button><button className="ms-danger" disabled={sections.length <= 1} onClick={() => setRemove(section.id)}>Remove section</button></div>
      {remove === section.id && <div className="ms-remove-confirm" role="group" aria-label="Confirm section removal"><p>Remove this {sectionNames[section.type].toLowerCase()} from the home screen?</p><button className="ms-danger" onClick={() => { const next = structuredClone(config); next.screens.home.sections.splice(index, 1); change(next); select(next.screens.home.sections[Math.max(0, index - 1)].id); setRemove(undefined); }}>Confirm removal</button><button onClick={() => setRemove(undefined)}>Keep section</button></div>}
    </fieldset>
    </section>
    </div>
  </div>;
}
