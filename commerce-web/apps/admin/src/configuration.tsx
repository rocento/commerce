import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, useLocation, useParams } from 'react-router-dom';
import type { AdminIdentity } from '@commerce/api-client';
import { PageHeader, PageHeadingLevel } from './page-header';
import {
  AssistantSettings, CapacitySettings, DiscoverabilitySettings, FulfillmentSettings,
  IndustrySettings, DeliveryFee, TaxRules,
} from './route-pages';
import {
  configurationBase, configurationGroups, canReadConfiguration, canWriteConfiguration,
  hasConfigurationPermission, visibleConfigurationGroups,
} from './configuration-model';
import './configuration.css';

export function Configuration({ who }: { who: AdminIdentity }) {
  const location = useLocation();
  const path = (useParams()['*'] ?? '').replace(/\/$/, '');
  const [search, setSearch] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const available = visibleConfigurationGroups(who.permissions);
  const filtered = visibleConfigurationGroups(who.permissions, search);
  const activeGroup = configurationGroups.find(group => group.sections.some(section => section.path === path));
  const section = activeGroup?.sections.find(item => item.path === path);
  const accessible = section && canReadConfiguration(who.permissions, section);
  const has = (permission: string) => hasConfigurationPermission(who.permissions, permission);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (activeGroup) setCollapsedGroups(previous => previous.filter(id => id !== activeGroup.id));
  }, [activeGroup]);

  if (path === 'discoverability') return <Navigate to={`${configurationBase}/discoverability/overview${location.search}${location.hash}`} replace />;
  if (path === 'channel-assignments') return <Navigate to={`/storefront/channel-assignments${location.search}${location.hash}`} replace />;

  if (path === 'markets') return <Navigate to={`/storefront/markets${location.search}${location.hash}`} replace />;

  if (path === 'languages') return <Navigate to={`/storefront/languages${location.search}${location.hash}`} replace />;

  let content: ReactNode;
  if (!path) {
    content = <main className="configuration-overview">
      <div className="configuration-intro"><span className="configuration-kicker">PLATFORM SETTINGS</span><h2>One place to configure your commerce platform</h2><p>Choose a section to review or update its settings. Each section keeps its own scope, permissions and save controls.</p></div>
      <div className="configuration-cards">{available.map(group => <section className="configuration-card" key={group.id}>
        <header><h3>{group.label}</h3><p>{group.description}</p></header>
        {group.sections.map(item => <Link key={item.path} to={`${configurationBase}/${item.path}`}><span><strong>{item.label}</strong><small>{item.description}</small></span><span aria-hidden="true">↗</span></Link>)}
      </section>)}</div>
      {!available.length && <div className="configuration-empty" role="status"><h2>No configuration access</h2><p>Your role does not have permission to view platform settings. Ask an administrator to grant access to the sections you need.</p></div>}
    </main>;
  } else if (!accessible) {
    content = <main className="configuration-empty"><h2>{section ? 'Configuration access restricted' : 'Configuration section not found'}</h2><p>{section ? 'Your role does not have permission to view this section.' : 'Choose an available section from the configuration menu.'}</p><Link to={configurationBase}>Back to configuration</Link></main>;
  } else {
    const pages: Record<string, () => ReactNode> = {
      industry: () => <IndustrySettings canWrite={has('attributes.write')} />,
      fulfillment: () => <FulfillmentSettings canManage={has('fulfillment.settings.manage')} canPickup={has('fulfillment.pickup.manage')} canInventory={has('inventory.write')} canReadInventory={has('inventory.read')} />,
      'delivery-fee': () => <DeliveryFee canWrite={has('fulfillment.settings.write')} />,
      tax: () => <TaxRules canWrite={has('tax.write')} />,
      capacity: () => <CapacitySettings canManage={has('fulfillment.capacity.manage') && has('fulfillment.schedule.manage')} canReadFulfillment={has('fulfillment.settings.view')} />,
      'ai-assistant': () => <AssistantSettings canWrite={has('assistant.settings.write')} />,
    };
    content = path.startsWith('discoverability/') ? <DiscoverabilitySettings canWrite={has('discovery.write')} /> : pages[path]?.();
  }

  return <div className="configuration-page">
    <PageHeader title="Configuration" description="Manage platform settings across your business, catalog and storefront." actions={<span className="configuration-workspace-badge">System configuration</span>} />
    <div className="configuration-layout">
      <aside className="configuration-sidebar">
        <button className="configuration-mobile-toggle secondary" type="button" aria-expanded={mobileOpen} aria-controls="configuration-navigation" onClick={() => setMobileOpen(value => !value)}><span>{accessible ? section.label : 'Configuration sections'}</span><span aria-hidden="true">{mobileOpen ? '−' : '+'}</span></button>
        <div id="configuration-navigation" className={mobileOpen ? 'is-open' : ''}>
          <div className="configuration-sidebar-heading"><strong>Configuration</strong><span>{available.reduce((count, group) => count + group.sections.length, 0)} sections</span></div>
          <div className="configuration-search"><label htmlFor="configuration-search">Search configuration</label><input id="configuration-search" type="search" placeholder="Find a setting…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" className="text-button" onClick={() => setSearch('')}>Clear search</button>}</div>
          <nav aria-label="Configuration sections">
            <NavLink end to={configurationBase} className="configuration-overview-link">Configuration overview</NavLink>
            {filtered.map(group => {
              const expanded = !!search.trim() || !collapsedGroups.includes(group.id);
              return <div className="configuration-nav-group" key={group.id}>
                <button type="button" className="configuration-group-toggle" aria-expanded={expanded} aria-controls={`configuration-group-${group.id}`} onClick={() => setCollapsedGroups(previous => previous.includes(group.id) ? previous.filter(id => id !== group.id) : [...previous, group.id])}><span>{group.label}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
                <div id={`configuration-group-${group.id}`} hidden={!expanded}>{group.sections.map(item => <NavLink key={item.path} to={`${configurationBase}/${item.path}`}><span>{item.label}</span><span aria-hidden="true">›</span></NavLink>)}</div>
              </div>;
            })}
            {!filtered.length && search && <p className="configuration-no-results" role="status">No settings match “{search}”. Try another search.</p>}
          </nav>
          <p className="configuration-sidebar-note">Only settings available to your role are shown.</p>
        </div>
      </aside>
      <div className="configuration-content">
        {accessible && <div className="configuration-section-context"><nav aria-label="Configuration breadcrumb"><Link to={configurationBase}>Configuration</Link><span aria-hidden="true">/</span><span>{activeGroup?.label}</span></nav><div><span className="configuration-scope">{section.scope} scope</span><span className="configuration-access">{!section.write.length ? 'Monitoring' : canWriteConfiguration(who.permissions, section) ? 'Manage settings' : 'Read-only access'}</span></div></div>}
        <PageHeadingLevel.Provider value={2}><Suspense fallback={<main><p role="status">Loading configuration…</p></main>}>{content}</Suspense></PageHeadingLevel.Provider>
      </div>
    </div>
  </div>;
}
