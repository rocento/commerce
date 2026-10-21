import { ProductRelationships } from "./product-relationships";
import {
  ApiReference,
  EmailTemplates,
  Configuration,
  MarketsSettings,
  MegamenuAdmin,
  Guide,
  CapacityScheduling,
  Roles,
  AuditLog,
  CategoryManagement,
  CatalogEnrichment,
  MerchantAssistant,
  AiReports,
  DeliveryAreas,
  ContentAdmin,
  StorefrontLanguages,
  ThemesAdmin,
  Reviews,
  Reports,
  SupportTickets,
  Promotions,
  MarketingNotifications,
  PromotionEditorPage,
  AdminOrders,
  OrderGeography,
  OrderStatuses,
  CatalogGeography,
  CustomerGeography,
  Customers,
  CustomerAttributes,
  CustomerSegments,
  Inventory,
  Replenishment,
  ReplenishmentPolicyPage,
  SourceEditor,
  Sources,
  StockEditor,
  Stocks,
  Catalog,
  ProductEditorPage,
  LegacyAttributeEditorPage,
  AttributeDefinitions,
  AttributeDefinitionEditorPage,
  AttributeSetEditorPage,
  ImportCenter,
  ExportCenter,
  CustomerJourney,
  Users,
} from "./route-pages";
import { fulfillmentPlanApi } from "@commerce/api-client";
import { PageHeader } from "./page-header";
import { configurationBase, hasConfigurationPermission, legacyConfigurationRoutes, visibleConfigurationGroups } from "./configuration-model";
import { Overview } from "./overview";
import { AdminShortcuts } from "./shortcuts";
import type { ExportEntity } from "./export-center";
import React, { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import {
  createBrowserRouter,
  RouterProvider,
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  adminApi,
  ApiError,
  type AdminIdentity,
  type MerchantInput,
} from "@commerce/api-client";
import { BrandLogo, Field, Notice, useAction } from "@commerce/ui";
import "@commerce/ui/styles.css";
import "./style.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function allowed(who: AdminIdentity, permission: string) {
  return who.permissions.includes("*") || who.permissions.includes(permission);
}
function LegacySupportRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/support/tickets/${id}` : "/support/tickets"} replace />;
}
function LegacyReplenishmentRedirect() {
  const { id } = useParams();
  return <Navigate to={`/fulfillment/replenishment/${id}`} replace/>;
}
function LegacyConfigurationRedirect({ section }: { section?: string }) {
  const location = useLocation();
  const discoverySection = useParams()['*'] || 'overview';
  return <Navigate to={`${configurationBase}/${section ?? `discoverability/${discoverySection}`}${location.search}${location.hash}`} replace />;
}
function LegacyStorefrontRedirect({ section }: { section: string }) {
  const location = useLocation();
  return <Navigate to={`/storefront/${section}${location.search}${location.hash}`} replace />;
}
function LegacyEmailTemplatesRedirect() {
  const location = useLocation();
  return <Navigate to={`/marketing/email-templates${location.search}${location.hash}`} replace />;
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/></>,
    store: <><path d="M3 10h18l-2-7H5l-2 7ZM4 10v11h16V10M9 21v-7h6v7"/><path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></>,
    box: <><path d="m4 7 8-4 8 4-8 4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></>,
    warehouse: <><path d="m3 9 9-5 9 5v12H3ZM7 21V11h10v10M7 15h10M7 18h10"/></>,
    tag: <><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
    cart: <><path d="M3 4h2l2.2 10.3a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L20.5 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    file: <><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21h-4v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3h4v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.62.6 1.1 1.22 1H21v4h-.08a1.7 1.7 0 0 0-1.55 1Z"/></>,
    spark: <><path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7ZM5 3l.6 1.7L7 5.3l-1.4.6L5 7.5l-.6-1.6L3 5.3l1.4-.6Z"/></>,
    support: <><path d="M4 13v-1a8 8 0 0 1 16 0v1M4 12H3v7h4v-7H4Zm16 0h1v7h-4v-7h3ZM20 19v1a2 2 0 0 1-2 2h-5"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    truck: <><path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
function NavItem({to, icon, children, end}: {to:string; icon:string; children:ReactNode; end?:boolean}) {
  return <NavLink to={to} end={end}><Icon name={icon}/><span>{children}</span></NavLink>;
}
const SidebarContext = React.createContext<{compact: boolean; active: string; setActive: (value: string) => void}>({ compact: false, active: '', setActive: () => {} });
function SidebarGroup({label, icon, children, open = false}: {label:string; icon:string; children:ReactNode; open?:boolean}) {
  const { compact, active, setActive } = React.useContext(SidebarContext);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const expanded = compact && active === label;
  useEffect(() => {
    if (!expanded) return;
    panel.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    function dismiss(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setActive('');
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setActive(''); trigger.current?.focus(); }
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [expanded, setActive]);
  if (!compact) return <details className="nav-group" open={open}><summary><Icon name={icon}/><span>{label}</span><b>⌄</b></summary><div className="nav-children">{children}</div></details>;
  return <div className="nav-rail-group">
    <button ref={trigger} type="button" className="nav-rail-trigger" data-active={open || expanded} aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={() => setActive(expanded ? '' : label)}><Icon name={icon}/><span>{label}</span></button>
    {expanded && createPortal(<div ref={panel} id={id} className="admin-nav-flyout" role="region" aria-label={`${label} navigation`}>
      <header><div><small>ADMINISTRATION</small><h2>{label}</h2></div><button type="button" aria-label={`Close ${label} menu`} onClick={() => { setActive(''); trigger.current?.focus(); }}>×</button></header>
      <nav aria-label={label} onClick={event => { if ((event.target as HTMLElement).closest('a')) setActive(''); }}>{children}</nav>
    </div>, document.body)}
  </div>;
}

function App() {
  const location = useLocation();
  const q = useQuery({ queryKey: ["admin-me"], queryFn: adminApi.me });
  const fulfillmentSettings=useQuery({queryKey:['fulfillment-settings'],queryFn:fulfillmentPlanApi.settings,enabled:!!q.data&&(q.data.permissions.includes('*')||q.data.permissions.includes('fulfillment.settings.view')),retry:false});
  const geoEnabled=fulfillmentSettings.data?.stores?.some(s=>s.resolved.geo_fencing_enabled)??true;
  const a = useAction();
  const [collapsed, setCollapsed] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia('(min-width: 781px) and (max-width: 1180px)').matches);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia('(max-width: 780px)').matches);
  const [activeMenu, setActiveMenu] = useState('');
  const compactNavigation = !mobileViewport && (collapsed || compactViewport);
  useEffect(() => {
    const narrow = window.matchMedia('(min-width: 781px) and (max-width: 1180px)');
    const mobile = window.matchMedia('(max-width: 780px)');
    const update = () => { setCompactViewport(narrow.matches); setMobileViewport(mobile.matches); setActiveMenu(''); };
    narrow.addEventListener('change', update); mobile.addEventListener('change', update);
    return () => { narrow.removeEventListener('change', update); mobile.removeEventListener('change', update); };
  }, []);
  useEffect(() => { setActiveMenu(''); }, [location.pathname, collapsed]);
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState<MerchantInput["question"]>();
  const openAssistant = (question?: MerchantInput["question"]) => { setAssistantQuestion(question); setAssistantOpen(true); };
  if (q.isPending)
    return (
      <div className="admin-loading" role="status">
        <BrandLogo />
        Opening your workspace…
      </div>
    );
  if (!q.data || (q.error instanceof ApiError && q.error.status === 401)) {
    return (
      <Login
        offline={
          q.error && (!(q.error instanceof ApiError) || q.error.status !== 401)
            ? q.error.message
            : ""
        }
      />
    );
  }
  const who = q.data;
  const canReadThemes = hasConfigurationPermission(who.permissions, 'theme.read');
  const exportEntities: ExportEntity[] = [
    ["catalog","Products","Product catalog including SKU, pricing, category, attributes, and publication status.","catalog.export"],
    ["inventory","Inventory quantities","Current on-hand, reserved, and available inventory quantities by SKU.","inventory.export"],
    ["orders","Orders","Order records, fulfillment state, totals, and customer references.","orders.read"],
    ["reviews","Reviews","Product review queue and moderation status.","reviews.read"],
    ["promotions","Promotions","Promotion rules, validity periods, and activation status.","promotions.read"],
    ["support","Support tickets","Customer support cases and their current workflow status.","support.read"],
    ["content","Content","CMS pages, blocks, publication status, and revision metadata.","cms.read"],
    ["users","Admin users","Administrator accounts, roles, and account status.","iam.users.read"],
    ["audit","Audit log","Administrative changes and actor history for compliance review.","iam.audit.read"],
  ].filter((item)=>allowed(who,item[3])).map(([value,label,description])=>({value,label,description}));
  const canConfigure = visibleConfigurationGroups(who.permissions).length > 0;
  const securitySectionActive = ["/system/users", "/system/roles", "/system/audit"].some(path => location.pathname === path || location.pathname.startsWith(`${path}/`));
  const systemSectionActive = !securitySectionActive && (location.pathname.startsWith("/system/") || location.pathname.startsWith("/settings/") || location.pathname.startsWith("/discoverability"));
  return (
    <div className={`admin-shell ${collapsed ? "is-collapsed" : ""} ${compactNavigation ? "is-compact-nav" : ""} ${navigationOpen ? "navigation-open" : ""}`}>
      <SidebarContext.Provider value={{ compact: compactNavigation, active: activeMenu, setActive: setActiveMenu }}>
      <aside className="sidebar">
        <div className="brand-row"><a href="/" className="brand" aria-label="Recento home"><span className="recento-full"><BrandLogo /></span><span className="recento-compact"><BrandLogo iconOnly /></span></a><button className="icon-button collapse-button" onClick={()=>setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>‹</button></div>
        <button type="button" className="admin-navigation-toggle secondary" aria-expanded={navigationOpen} aria-controls="admin-navigation" onClick={() => setNavigationOpen(!navigationOpen)}>{navigationOpen ? "Close navigation" : "Open navigation"}</button>
        <nav id="admin-navigation" aria-label="Administration navigation">
          <NavItem to="/" end icon="home">Overview</NavItem>
          {(allowed(who,"catalog.read")||allowed(who,"attributes.read")) && <SidebarGroup label="Catalog" icon="box" open={location.pathname.startsWith("/catalog/") && !["/catalog/inventory","/catalog/sources","/catalog/stocks","/catalog/delivery-areas"].some((path)=>location.pathname.startsWith(path))}>{allowed(who,"catalog.read")&&(["products","categories","attributes","media"] as const).map(section=><NavLink key={section} to={`/catalog/${section}`}><span>{section[0].toUpperCase()+section.slice(1)}</span></NavLink>)}{allowed(who,"catalog.read")&&<NavLink to="/catalog/relationships"><span>Product relationships</span></NavLink>}{allowed(who,"catalog.read")&&allowed(who,"orders.read")&&<NavLink to="/catalog/geography"><span>Catalog geography</span></NavLink>}{allowed(who,"attributes.read")&&<NavLink to="/catalog/enrichment"><span>Catalog enrichment</span></NavLink>}</SidebarGroup>}
          {allowed(who,"inventory.read") && <SidebarGroup label="Inventory" icon="warehouse" open={["/catalog/inventory","/catalog/sources","/catalog/stocks","/fulfillment/replenishment"].some(path => location.pathname.startsWith(path))}>
            <NavLink to="/catalog/inventory"><span>Stock overview</span></NavLink>
            <NavLink to="/fulfillment/replenishment"><span>Replenishment</span></NavLink>
            <NavLink to="/catalog/sources"><span>Locations</span></NavLink>
            <NavLink to="/catalog/stocks"><span>Stock pools</span></NavLink>
          </SidebarGroup>}
          {((allowed(who,"fulfillment.capacity.view") && allowed(who,"fulfillment.schedule.view")) || (geoEnabled && allowed(who,"inventory.read"))) && <SidebarGroup label="Delivery" icon="truck" open={location.pathname.startsWith("/catalog/delivery-areas") || (location.pathname.startsWith("/fulfillment/") && !location.pathname.startsWith("/fulfillment/replenishment"))}>
            {geoEnabled && allowed(who,"inventory.read") && <NavLink to="/catalog/delivery-areas"><span>Service areas</span></NavLink>}
            {allowed(who,"fulfillment.capacity.view") && allowed(who,"fulfillment.schedule.view") && <NavLink to="/fulfillment/capacity"><span>Scheduling &amp; capacity</span></NavLink>}
          </SidebarGroup>}
          {(allowed(who,"orders.read") || allowed(who,"orders.statuses.read")) && <SidebarGroup label="Sales" icon="cart" open={location.pathname.startsWith("/sales/")}>{allowed(who,"orders.read") && <><NavLink to="/sales/orders"><span>Orders</span></NavLink><NavLink to="/sales/order-geography"><span>Order geography</span></NavLink></>}{allowed(who,"orders.statuses.read") && <NavLink to="/sales/order-statuses"><span>Order statuses</span></NavLink>}</SidebarGroup>}
          {allowed(who,"customers.read") && <SidebarGroup label="Customer" icon="users" open={location.pathname.startsWith("/customers/")}><NavLink to="/customers/profiles"><span>Profiles</span></NavLink><NavLink to="/customers/geography"><span>Customer geography</span></NavLink><NavLink to="/customers/journey"><span>Shopping journey</span></NavLink><NavLink to="/customers/segments"><span>Segments</span></NavLink><NavLink to="/customers/attributes"><span>Attributes</span></NavLink></SidebarGroup>}
          {(allowed(who,"promotions.read")||allowed(who,"reviews.read")||allowed(who,"notifications.read")||allowed(who,"email_templates.read")) && <SidebarGroup label="Marketing" icon="tag" open={location.pathname.startsWith("/marketing/")}>{allowed(who,"promotions.read")&&<NavLink to="/marketing/promotions"><span>Promotions</span></NavLink>}{allowed(who,"notifications.read")&&<NavLink to="/marketing/notifications"><span>Notifications</span></NavLink>}{allowed(who,"reviews.read")&&<NavLink to="/marketing/reviews"><span>Reviews</span></NavLink>}{allowed(who,"email_templates.read")&&<NavLink to="/marketing/email-templates"><span>Email templates</span></NavLink>}</SidebarGroup>}
          {allowed(who,"reports.read") && <SidebarGroup label="Analytics" icon="chart" open={location.pathname.startsWith("/reports/")}><NavLink to="/reports/dashboard"><span>Dashboard</span></NavLink><NavLink to="/reports/cohorts"><span>Cohort &amp; retention</span></NavLink><NavLink to="/reports/ai-models"><span>AI models</span></NavLink></SidebarGroup>}
          {(allowed(who,"markets.read") || allowed(who,"languages.read") || canReadThemes || allowed(who,"cms.read")) && <SidebarGroup label="Storefront" icon="store" open={location.pathname.startsWith("/storefront/")}>
            {allowed(who,"markets.read") && <NavLink to="/storefront/markets"><span>Markets</span></NavLink>}
            {allowed(who,"languages.read") && <NavLink to="/storefront/languages"><span>Languages</span></NavLink>}
            {canReadThemes && <><NavLink to="/storefront/themes"><span>Themes</span></NavLink><NavLink to="/storefront/channel-assignments"><span>Channel assignments</span></NavLink></>}
            {allowed(who,"cms.read") && <><NavLink to="/storefront/pages"><span>Pages & blocks</span></NavLink><NavLink to="/storefront/navigation"><span>Navigation</span></NavLink></>}
          </SidebarGroup>}
          {(allowed(who,"iam.users.read") || allowed(who,"iam.roles.read") || allowed(who,"iam.audit.read")) && <SidebarGroup label="Security" icon="shield" open={securitySectionActive}>
            {allowed(who,"iam.users.read") && <NavLink to="/system/users"><span>Admin users</span></NavLink>}
            {allowed(who,"iam.roles.read") && <NavLink to="/system/roles"><span>Roles &amp; permissions</span></NavLink>}
            {allowed(who,"iam.audit.read") && <NavLink to="/system/audit"><span>Audit log</span></NavLink>}
          </SidebarGroup>}
          {(allowed(who,"api.docs.read") || canConfigure || exportEntities.length > 0 || allowed(who,"catalog.import") || allowed(who,"inventory.import")) && <SidebarGroup label="System" icon="settings" open={systemSectionActive}>
            {allowed(who,"api.docs.read") && <NavLink to="/system/api-reference"><span>API reference</span></NavLink>}
            {canConfigure && <NavLink to={configurationBase}><span>Configuration</span></NavLink>}
            {(allowed(who,"catalog.import") || allowed(who,"inventory.import")) && <NavLink to="/system/import"><span>Data transfer · Import</span></NavLink>}
            {exportEntities.length > 0 && <NavLink to="/system/export"><span>Data transfer · Export</span></NavLink>}
          </SidebarGroup>}
          {allowed(who,"support.read") && <SidebarGroup label="Support" icon="support" open={location.pathname.startsWith("/support/")}><NavLink to="/support/tickets"><span>Support tickets</span></NavLink></SidebarGroup>}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">{who.user.name.slice(0,2).toUpperCase()}</span><div className="user-copy"><span>{who.user.name}</span><small>{who.user.email}</small></div>
          <button
            className="secondary"
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                await adminApi.logout();
                client.setQueryData(["admin-me"], null);
                client.removeQueries({
                  predicate: (q) => q.queryKey[0] !== "admin-me",
                });
              })
            }
          >
            Sign out
          </button>
        </div>
      </aside>
      </SidebarContext.Provider>
      <div className="admin-body">
        <header className="admin-header">
          <nav className="admin-header-context" aria-label="Workspace"><NavLink to="/">Administration</NavLink>{location.pathname !== "/" && <><span aria-hidden="true">/</span><span aria-current="location">{securitySectionActive ? "Security" : systemSectionActive ? "System" : ({catalog: "Catalog", customers: "Customers", sales: "Sales", support: "Support", marketing: "Marketing", reports: "Reports", storefront: "Storefront", system: "System", discoverability: "Search & AI", settings: "Settings", fulfillment: "Fulfillment"} as Record<string, string>)[location.pathname.split("/")[1]] || "Workspace"}</span></>}</nav>
          <div className="header-actions"><span className="workspace-chip"><span>Orbit Commerce</span><small>Store workspace</small></span></div>
        </header>
        <Notice error>{a.error}</Notice>
        <AdminShortcuts permissions={who.permissions} />
        <Suspense fallback={<main><p role="status">Loading page…</p></main>}>
        <Routes>
          <Route path="/system/api-reference" element={allowed(who,"api.docs.read") ? <ApiReference /> : <Denied />} />
          <Route path="/system/configuration/*" element={<Configuration who={who} />} />
          {Object.entries(legacyConfigurationRoutes).map(([path, section]) => <Route key={path} path={path} element={<LegacyConfigurationRedirect section={section} />} />)}
          <Route path="/discoverability/*" element={<LegacyConfigurationRedirect />} />
          <Route path="/catalog/relationships" element={allowed(who,"catalog.read")?<ProductRelationships canWrite={allowed(who,"catalog.write")} canReadSegments={allowed(who,"customers.read")}/>:<Denied/>}/>
          <Route path="/catalog/enrichment" element={allowed(who,"attributes.read")?<CatalogEnrichment canReadCatalog={allowed(who,"catalog.read")} canManageDiscovery={allowed(who,"attributes.write")} canWrite={allowed(who,"attributes.write")&&allowed(who,"catalog.write")}/>:<Denied/>}/>
          {Object.entries({ '/content/pages': 'pages', '/content/navigation': 'navigation', '/content/languages': 'languages', '/content/themes': 'themes', '/content/theme-assignments': 'channel-assignments' }).map(([path, section]) => <Route key={path} path={path} element={<LegacyStorefrontRedirect section={section} />} />)}
          <Route path="/storefront/markets" element={allowed(who,"markets.read") ? <MarketsSettings canWrite={allowed(who,'markets.write')} canReadCatalog={allowed(who,'catalog.read')} canPublish={allowed(who,'markets.publish') && allowed(who,'catalog.write') && allowed(who,'cms.publish')} /> : <Denied />} />
          <Route path="/storefront/navigation" element={allowed(who,"cms.read") ? <MegamenuAdmin permissions={who.permissions} canWrite={allowed(who,"cms.write")} canPublish={allowed(who,"cms.publish")}/> : <Denied/>}/>
          <Route path="/storefront/languages" element={allowed(who,"languages.read") ? <StorefrontLanguages canReadMarkets={allowed(who,'markets.read')} canReadAttributes={allowed(who,'attributes.read')} canWriteAttributes={allowed(who,'attributes.write')} canReadContent={allowed(who,'cms.read')} canWriteContent={allowed(who,'cms.write')} canWrite={allowed(who,'languages.write')} canReadCatalog={allowed(who,'catalog.read')} canWriteCatalog={allowed(who,'catalog.write')} /> : <Denied />} />
          <Route path="/storefront/themes" element={canReadThemes ? <ThemesAdmin who={who} /> : <Denied />} />
          <Route path="/storefront/channel-assignments" element={canReadThemes ? <ThemesAdmin who={who} view="assignments" /> : <Denied />} />
          <Route
            path="/storefront/pages"
            element={
              allowed(who, "cms.read") ? (
                <ContentAdmin
                  canWrite={allowed(who, "cms.write")}
                  canPublish={allowed(who, "cms.publish")}
                />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/marketing/reviews"
            element={
              allowed(who, "reviews.read") ? (
                <Reviews canModerate={allowed(who, "reviews.moderate")} />
              ) : (
                <Denied />
              )
            }
          />

          <Route
            path="/reports/dashboard"
            element={allowed(who, "reports.read") ? <Reports key="dashboard" /> : <Denied />}
          />
          <Route path="/reports/ai-models" element={allowed(who, "reports.read") ? <AiReports /> : <Denied />} />
          <Route
            path="/reports/cohorts"
            element={
              allowed(who, "reports.read") ? (
                <Reports key="cohorts" cohortsOnly />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/customers/cohorts"
            element={
              allowed(who, "customers.read") && allowed(who, "reports.read") ? (
                <Reports key="customer-cohorts" cohortsOnly />
              ) : (
                <Denied />
              )
            }
          />
          <Route path="/customers/journey" element={allowed(who, "customers.read") ? <CustomerJourney canManageNotifications={allowed(who, "notifications.read")} /> : <Denied />} />
          <Route path="/customers/journey/:id" element={allowed(who, "customers.read") ? <CustomerJourney canManageNotifications={allowed(who, "notifications.read")} /> : <Denied />} />
          <Route path="/marketing/notifications" element={allowed(who, "notifications.read") ? <MarketingNotifications canWrite={allowed(who, "notifications.write")} canGenerate={allowed(who, "notifications.generate")} canPublish={allowed(who, "notifications.publish")} canReadCustomers={allowed(who, "customers.read")} canReadOrders={allowed(who, "orders.read")} /> : <Denied />} />
          <Route path="/support/guide" element={<Guide permissions={who.permissions} />} />
          <Route path="/sales/support" element={<LegacySupportRedirect />} />
          <Route path="/sales/support/:id" element={<LegacySupportRedirect />} />
          <Route path="/sales/customers" element={<Navigate to="/customers/profiles" replace />} />
          <Route path="/sales/customers/:id" element={<CustomerProfileRedirect />} />
          <Route
            path="/support/tickets"
            element={
              allowed(who, "support.read") ? (
                <SupportTickets canWrite={allowed(who, "support.write")} />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/support/tickets/:id"
            element={
              allowed(who, "support.read") ? (
                <SupportTickets canWrite={allowed(who, "support.write")} />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/marketing/promotions"
            element={
              allowed(who, "promotions.read") ? (
                <Promotions canWrite={allowed(who, "promotions.write")} />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/sales/orders"
            element={
              allowed(who, "orders.read") ? (
                <AdminOrders who={who} />
              ) : (
                <Denied />
              )
            }
          />
          <Route
            path="/sales/orders/:id"
            element={
              allowed(who, "orders.read") ? (
                <AdminOrders who={who} />
              ) : (
                <Denied />
              )
            }
          />
          <Route path="/catalog/geography" element={allowed(who, 'catalog.read') && allowed(who, 'orders.read') ? <CatalogGeography /> : <Denied />} />
          <Route path="/customers/geography" element={allowed(who, 'customers.read') ? <CustomerGeography /> : <Denied />} />
          <Route path="/sales/order-statuses" element={allowed(who, "orders.statuses.read") ? <OrderStatuses canManage={allowed(who, "orders.statuses.manage")} /> : <Denied />} />
          <Route path="/sales/order-geography" element={allowed(who, 'orders.read') ? <OrderGeography who={who} /> : <Denied />} />
          <Route
            path="/customers/profiles"
            element={allowed(who, "customers.read") ? <Customers /> : <Denied />}
          />
          <Route
            path="/customers/profiles/:id"
            element={allowed(who, "customers.read") ? <Customers /> : <Denied />}
          />
          <Route
            path="/customers/segments"
            element={allowed(who, "customers.read") ? <CustomerSegments canWrite={allowed(who, "customers.segments.write")} /> : <Denied />}
          />
          <Route
            path="/customers/segments/:id"
            element={allowed(who, "customers.read") ? <CustomerSegments canWrite={allowed(who, "customers.segments.write")} /> : <Denied />}
          />
          <Route
            path="/customers/attributes"
            element={allowed(who, "attributes.read") ? <CustomerAttributes canWrite={allowed(who, "attributes.write")} /> : <Denied />}
          />
          <Route path="/" element={<Overview who={who} onAsk={openAssistant} />} />
          <Route path="/catalog/sources" element={allowed(who,"inventory.read")?<Sources canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>
          <Route path="/catalog/sources/new" element={allowed(who,"inventory.read")?<SourceEditor canWrite={allowed(who,"inventory.write")} canReadPickup={allowed(who,"fulfillment.settings.view")} canManagePickup={allowed(who,"fulfillment.settings.manage")&&allowed(who,"fulfillment.pickup.manage")}/>:<Denied/>}/>
          <Route path="/catalog/sources/:id" element={allowed(who,"inventory.read")?<SourceEditor canWrite={allowed(who,"inventory.write")} canReadPickup={allowed(who,"fulfillment.settings.view")} canManagePickup={allowed(who,"fulfillment.settings.manage")&&allowed(who,"fulfillment.pickup.manage")}/>:<Denied/>}/>
          <Route path="/catalog/stocks" element={allowed(who,"inventory.read")?<Stocks canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>
          <Route path="/catalog/stocks/new" element={allowed(who,"inventory.read")?<StockEditor canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>
          <Route path="/catalog/stocks/:id" element={allowed(who,"inventory.read")?<StockEditor canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>

          <Route path="/catalog/delivery-areas" element={allowed(who,"inventory.read")?<DeliveryAreas canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>
          <Route path="/fulfillment/capacity" element={allowed(who,"fulfillment.capacity.view")&&allowed(who,"fulfillment.schedule.view")?<CapacityScheduling canSchedule={allowed(who,"fulfillment.schedule.manage")} canCapacity={allowed(who,"fulfillment.capacity.manage")} canOverride={allowed(who,"fulfillment.override.manage")}/>:<Denied/>}/>
          <Route path="/fulfillment/new-schedule" element={allowed(who,"fulfillment.capacity.view")&&allowed(who,"fulfillment.schedule.view")&&allowed(who,"fulfillment.schedule.manage")?<CapacityScheduling canSchedule canCapacity={allowed(who,"fulfillment.capacity.manage")} canOverride={allowed(who,"fulfillment.override.manage")}/>:<Denied/>}/>
          <Route path="/fulfillment/schedules/:id" element={allowed(who,"fulfillment.capacity.view")&&allowed(who,"fulfillment.schedule.view")&&allowed(who,"fulfillment.schedule.manage")?<CapacityScheduling canSchedule canCapacity={allowed(who,"fulfillment.capacity.manage")} canOverride={allowed(who,"fulfillment.override.manage")}/>:<Denied/>}/>
          <Route path="/fulfillment/new-capacity" element={allowed(who,"fulfillment.capacity.view")&&allowed(who,"fulfillment.schedule.view")&&allowed(who,"fulfillment.capacity.manage")?<CapacityScheduling canSchedule={allowed(who,"fulfillment.schedule.manage")} canCapacity canOverride={allowed(who,"fulfillment.override.manage")}/>:<Denied/>}/>
          <Route path="/fulfillment/capacity-rules/:id" element={allowed(who,"fulfillment.capacity.view")&&allowed(who,"fulfillment.schedule.view")&&allowed(who,"fulfillment.capacity.manage")?<CapacityScheduling canSchedule={allowed(who,"fulfillment.schedule.manage")} canCapacity canOverride={allowed(who,"fulfillment.override.manage")}/>:<Denied/>}/>
          <Route path="/fulfillment/replenishment" element={allowed(who,"inventory.read")?<Replenishment canWrite={allowed(who,"inventory.write")}/>:<Denied/>}/>
          <Route path="/fulfillment/replenishment/:id" element={allowed(who,"inventory.write")?<ReplenishmentPolicyPage/>:<Denied/>}/>
          <Route path="/stores/replenishment" element={<Navigate to="/fulfillment/replenishment" replace/>}/>
          <Route path="/stores/replenishment/:id" element={<LegacyReplenishmentRedirect/>}/>
          <Route
            path="/catalog/inventory"
            element={
              allowed(who, "inventory.read") ? (
                <Inventory
                  canWrite={allowed(who, "inventory.write")}
                />
              ) : (
                <Denied />
              )
            }
          />
          {(["products", "categories", "attributes", "media"] as const).map(
            (section) => (
              <Route
                key={section}
                path={`/catalog/${section}`}
                element={
                  allowed(who, "catalog.read") ? (
                    <Catalog
                      permissions={who.permissions}
                      section={section}
                      canWrite={allowed(who, "catalog.write")}
                    />
                  ) : (
                    <Denied />
                  )
                }
              />
            ),
          )}
          <Route path="/marketing/promotions/:id" element={allowed(who,"promotions.read") && allowed(who,"promotions.write") ? <PromotionEditorPage/> : <Denied/>}/>
          <Route path="/catalog/products/:id" element={allowed(who,"catalog.write") ? <ProductEditorPage permissions={who.permissions}/> : <Denied/>}/>
          <Route path="/catalog/categories/:id" element={allowed(who,"catalog.read") ? <CategoryManagement canWrite={allowed(who,"catalog.write")} permissions={who.permissions}/> : <Denied/>}/>
          <Route path="/customers/attributes/definitions/:id" element={allowed(who,"attributes.write") ? <AttributeDefinitionEditorPage customer permissions={who.permissions}/> : <Denied/>}/>
          <Route path="/catalog/attributes/definitions/:id" element={allowed(who,"attributes.write") ? <AttributeDefinitionEditorPage permissions={who.permissions}/> : <Denied/>}/>
          <Route path="/catalog/attributes/sets" element={allowed(who,"catalog.read") ? <main><AttributeDefinitions view="sets" canWrite={allowed(who,"attributes.write")}/></main> : <Denied/>}/>
          <Route path="/catalog/attributes/sets/:id" element={allowed(who,"attributes.write") ? <AttributeSetEditorPage/> : <Denied/>}/>
          <Route path="/catalog/attributes/legacy/:id" element={allowed(who,"catalog.write") ? <LegacyAttributeEditorPage/> : <Denied/>}/>
          <Route path="/system/email-templates" element={<LegacyEmailTemplatesRedirect />} />
          <Route path="/marketing/email-templates" element={allowed(who,"email_templates.read") ? <EmailTemplates canWrite={allowed(who,"email_templates.write")} canPublish={allowed(who,"email_templates.publish")}/> : <Denied/>}/>
          <Route
            path="/system/users"
            element={
              allowed(who, "iam.users.read") ? <Users who={who} /> : <Denied />
            }
          />
          <Route
            path="/system/roles"
            element={
              allowed(who, "iam.roles.read") ? <Roles who={who} /> : <Denied />
            }
          />
          <Route
            path="/system/audit"
            element={allowed(who, "iam.audit.read") ? <AuditLog /> : <Denied />}
          />
          <Route path="/system/import" element={(allowed(who,"catalog.import")||allowed(who,"inventory.import")) ? <ImportCenter canCatalog={allowed(who,"catalog.import")} canInventory={allowed(who,"inventory.import")}/> : <Denied/>}/>
          <Route path="/system/export" element={exportEntities.length ? <ExportCenter entities={exportEntities}/> : <Denied/>}/>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Denied />} />
        </Routes>
        </Suspense>
      </div>
      {assistantOpen && <Suspense fallback={<p role="status">Loading assistant…</p>}><MerchantAssistant initialQuestion={assistantQuestion} onClose={() => setAssistantOpen(false)} /></Suspense>}
    </div>
  );
}
function CustomerProfileRedirect() {
  const { id } = useParams();
  return <Navigate to={`/customers/profiles/${id ?? ""}`} replace />;
}
function Denied() {
  return (
    <main>
      <PageHeader title={<>This page isn’t available</>} description={<>
        Your role may not have access. Ask your administrator if you need it.
      </>} />
    </main>
  );
}
function Login({ offline }: { offline: string | null | undefined }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      const who = await adminApi.login(email, password);
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== "admin-me" });
      client.setQueryData(["admin-me"], who);
    });
  }
  return (
    <div className="admin-login">
      <section>
        <a href="/" className="brand" aria-label="Recento home">
          <span className="recento-full"><BrandLogo /></span><span className="recento-compact"><BrandLogo iconOnly /></span>
        </a>
        <p className="eyebrow">ADMIN WORKSPACE</p>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in to manage your commerce workspace.</p>
        <form onSubmit={submit}>
          <Field
            label="Work email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={128}
          />
          <Notice error>{a.error || offline}</Notice>
          <button disabled={a.busy}>
            {a.busy ? "Signing in…" : "Sign in to workspace"}
          </button>
        </form>
        <p className="help">Access is managed by your store administrator.</p>
      </section>
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/customer-journey', element: <Navigate to="/customers/journey" replace /> },
  { path: '*', element: <App /> },
]);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
