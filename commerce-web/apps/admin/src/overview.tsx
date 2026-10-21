import { Link } from 'react-router-dom';
import type { AdminIdentity, MerchantInput } from '@commerce/api-client';
import { PageHeader } from './page-header';
import { OverviewMetrics } from './overview-metrics';
import { OverviewIcon } from './overview-icon';
import { merchantQuestions } from './merchant-questions';
import './overview.css';

type OpenAssistant = (question?: MerchantInput['question']) => void;
const allowed = (who: AdminIdentity, permission: string) => who.permissions.includes('*') || who.permissions.includes(permission);

export function Overview({ who, onAsk }: { who: AdminIdentity; onAsk: OpenAssistant }) {
  const can = (permission: string) => allowed(who, permission);
  const canTheme = who.permissions.some(permission => permission === '*' || permission === 'theme.read' || permission.startsWith('theme.read@'));
  const questions = merchantQuestions.filter(item => {
    if (['orders', 'top_sellers'].includes(item.question)) return can('reports.read');
    if (item.question === 'low_stock') return can('inventory.read') && can('catalog.read');
    return item.question === 'order_status' && can('orders.read') && !can('reports.read');
  }).slice(0, 3);
  const intelligence = questions.length ? <aside className="ov-ai-panel" aria-labelledby="ov-ai-title">
    <div className="ov-ai-brand"><span className="ov-ai-mark"><OverviewIcon name="spark"/></span><span>ROCENTO INTELLIGENCE</span></div>
    <h2 id="ov-ai-title">Your data.<br/> A clearer direction.</h2>
    <p>Explore your orders, products and inventory with answers backed by your commerce records.</p>
    <div className="ov-ai-questions"><span>START WITH A QUESTION</span>{questions.map(question => <button key={question.question} type="button" onClick={() => onAsk(question.question)}><span>{question.label}</span><OverviewIcon name="arrow"/></button>)}</div>
    <div className="ov-ai-footer"><OverviewIcon name="shield"/><span>Source-backed answers. Access-aware.</span></div>
  </aside> : null;
  const workspaces = [
    { show: can('customers.read'), title: 'Customer intelligence', description: 'Connect customer profiles, shopping journeys and audience segments.', detail: 'Understand every journey', href: '/customers/journey', icon: 'people', tone: 'violet' },
    { show: can('inventory.read'), title: 'Inventory network', description: 'Coordinate stock, sources and delivery coverage across your operation.', detail: 'Bring fulfillment together', href: '/catalog/stocks', icon: 'network', tone: 'sage' },
    { show: can('attributes.read') || can('catalog.read'), title: 'Catalog intelligence', description: 'Build a richer product catalog with structured attributes and enrichment.', detail: 'Make products easier to discover', href: can('attributes.read') ? '/catalog/enrichment' : '/catalog/products', icon: 'box', tone: 'sand' },
    { show: canTheme, title: 'Storefront experiences', description: 'Shape your storefront with themes, content and channel assignments.', detail: 'Create the right experience', href: '/storefront/themes', icon: 'store', tone: 'blue' },
    { show: can('promotions.read'), title: 'Growth & campaigns', description: 'Manage promotions and coupons from one commercial workspace.', detail: 'Turn interest into orders', href: '/marketing/promotions', icon: 'tag', tone: 'rose' },
    { show: can('discovery.read'), title: 'Search & AI visibility', description: 'Manage how search engines and AI assistants discover your store.', detail: 'Reach the next discovery channel', href: '/system/configuration/discoverability/overview', icon: 'globe', tone: 'peach' },
  ].filter(item => item.show);
  const operations = [
    { permission: 'orders.read', title: 'Orders & shipments', description: 'Review orders and move fulfillment forward.', href: '/sales/orders', icon: 'truck' },
    { permission: 'inventory.read', title: 'Replenishment', description: 'Review stock needs and replenishment suggestions.', href: '/fulfillment/replenishment', icon: 'box' },
    { permission: 'support.read', title: 'Customer support', description: 'Keep customer conversations moving.', href: '/support/tickets', icon: 'support' },
    { permission: 'reviews.read', title: 'Review moderation', description: 'Review and publish customer feedback.', href: '/marketing/reviews', icon: 'people' },
  ].filter(item => can(item.permission));
  const controls = [
    { permission: 'iam.users.read', label: 'Team members', href: '/system/users' },
    { permission: 'iam.roles.read', label: 'Roles & permissions', href: '/system/roles' },
    { permission: 'iam.audit.read', label: 'Audit log', href: '/system/audit' },
  ].filter(item => can(item.permission));
  return <main className="overview-page">
    <div className="ov-welcome"><span className="ov-kicker">WORKSPACE OVERVIEW</span><span>Welcome back, {who.user.name.split(' ')[0]}.</span></div>
    <PageHeader title="Business overview" description="Performance, customer intelligence and operations. One connected view." actions={<>
      {can('reports.read') && <Link className="secondary button-link" to="/reports/dashboard">Explore reports <OverviewIcon name="arrow"/></Link>}
      {!!questions.length && <button type="button" className="ov-ask-button" onClick={() => onAsk(questions[0].question)}><OverviewIcon name="spark"/>Ask Rocento AI</button>}
    </>}/>
    {can('reports.read') ? <OverviewMetrics intelligence={intelligence}/> : intelligence}
    {!!operations.length && <section className="ov-operations" aria-labelledby="ov-operations-title"><div className="ov-section-heading"><h2 id="ov-operations-title">Keep business moving</h2><span>Your daily operations</span></div><div className="ov-operation-grid">{operations.map(item => <Link key={item.href} to={item.href} className="ov-operation"><span className="ov-operation-icon"><OverviewIcon name={item.icon}/></span><span><strong>{item.title}</strong><small>{item.description}</small></span><OverviewIcon name="arrow"/></Link>)}</div></section>}
    {!!workspaces.length && <section className="ov-workspaces" aria-labelledby="ov-workspaces-title"><div className="ov-section-heading"><div><span className="ov-kicker">THE POWER OF CONNECTED COMMERCE</span><h2 id="ov-workspaces-title">Built to work together</h2></div><span>Explore your platform</span></div><div className="ov-workspace-grid">{workspaces.map(item => <Link key={item.href} to={item.href} className="ov-workspace-card"><div className="ov-workspace-top"><span className={`ov-capability-icon ov-tone-${item.tone}`}><OverviewIcon name={item.icon}/></span><OverviewIcon name="arrow"/></div><h3>{item.title}</h3><p>{item.description}</p><span className="ov-workspace-detail">{item.detail}</span></Link>)}</div></section>}
    {!workspaces.length && !operations.length && !can('reports.read') && <section className="ov-panel ov-no-access"><OverviewIcon name="shield"/><h2>Your workspace access</h2><p>Your administrator can enable the commerce workspaces you need. Available administration tools are listed below.</p></section>}
    <div className="ov-governance"><span><OverviewIcon name="shield"/>{can('*') ? 'Full administration access' : 'Workspace access follows your role'}</span>{!!controls.length && <nav aria-label="Workspace administration">{controls.map(item => <Link key={item.href} to={item.href}>{item.label}<OverviewIcon name="arrow"/></Link>)}</nav>}</div>
  </main>;
}
