export const configurationBase = '/system/configuration';

export type ConfigurationSection = {
  path: string;
  label: string;
  description: string;
  read: string[];
  write: string[];
  scope: string;
  keywords?: string;
};
export type ConfigurationGroup = { id: string; label: string; description: string; sections: ConfigurationSection[] };

/** Navigation and route access share one registry; API permissions remain authoritative. */
export const configurationGroups: ConfigurationGroup[] = [
  { id: 'general', label: 'General', description: 'Your business details.', sections: [
    { path: 'discoverability/profile', label: 'Business profile', description: 'Public business details, contact information and store policies.', read: ['discovery.read'], write: ['discovery.write'], scope: 'Installation', keywords: 'merchant address organization returns shipping' },
  ] },
  { id: 'catalog', label: 'Catalog', description: 'Industry templates and product structure.', sections: [
    { path: 'industry', label: 'Catalog setup', description: 'Choose an industry template and default attributes for new products.', read: ['attributes.read'], write: ['attributes.write'], scope: 'Installation', keywords: 'industry profile product schema attributes templates defaults' },
  ] },
  { id: 'sales', label: 'Sales & fulfillment', description: 'Checkout charges and fulfillment policies.', sections: [
    { path: 'fulfillment', label: 'Delivery & pickup', description: 'Store policies, delivery coverage, inventory routing and pickup.', read: ['fulfillment.settings.view'], write: ['fulfillment.settings.manage'], scope: 'Store', keywords: 'branches locations stock global scheduling capacity' },
    { path: 'delivery-fee', label: 'Delivery fee', description: 'Public delivery fee with location and warehouse overrides.', read: ['fulfillment.settings.read'], write: ['fulfillment.settings.write'], scope: 'Installation', keywords: 'shipping fees charges' },
    { path: 'tax', label: 'Tax rules', description: 'Geographic tax rates, priorities and delivery taxation.', read: ['tax.read'], write: ['tax.write'], scope: 'Installation', keywords: 'checkout rates zones' },
    { path: 'capacity', label: 'Capacity activation', description: 'Checkout admission controls for installations using legacy capacity settings.', read: ['fulfillment.capacity.view', 'fulfillment.schedule.view'], write: ['fulfillment.capacity.manage', 'fulfillment.schedule.manage'], scope: 'Installation', keywords: 'legacy scheduling controls limits' },
  ] },
  { id: 'storefront', label: 'Storefront', description: 'Customer shopping assistance.', sections: [
    { path: 'ai-assistant', label: 'Shopping Assistance', description: 'AI assistant activation, model, provider connection and readiness.', read: ['assistant.settings.read'], write: ['assistant.settings.write'], scope: 'Installation', keywords: 'openai api key artificial intelligence model' },
  ] },
  { id: 'discovery', label: 'Search & AI visibility', description: 'Public discovery, indexing and crawler access.', sections: [
    { path: 'discoverability/overview', label: 'Visibility overview', description: 'Current discovery health and recommended actions.', read: ['discovery.read'], write: [], scope: 'Installation', keywords: 'health checks status' },
    { path: 'discoverability/seo', label: 'Search engine optimization', description: 'Store identity, metadata defaults and search indexing.', read: ['discovery.read'], write: ['discovery.write'], scope: 'Installation', keywords: 'seo canonical url title description indexing sitemap' },
    { path: 'discoverability/ai', label: 'AI & crawler access', description: 'Crawler rules, product feeds and AI discovery access.', read: ['discovery.read'], write: ['discovery.write'], scope: 'Installation', keywords: 'robots bots feeds' },
    { path: 'discoverability/performance', label: 'Discovery performance', description: 'Search and AI discovery activity and attribution.', read: ['discovery.read'], write: [], scope: 'Installation', keywords: 'analytics traffic reporting' },
  ] },
];

export function hasConfigurationPermission(permissions: string[], permission: string) {
  return permissions.includes('*') || permissions.includes(permission)
    || (permission.startsWith('theme.') && permissions.some(value => value.startsWith(`${permission}@`) && value.slice(permission.length + 1).trim().length > 0));
}
export function canReadConfiguration(permissions: string[], section: ConfigurationSection) {
  return section.read.every(permission => hasConfigurationPermission(permissions, permission));
}
export function canWriteConfiguration(permissions: string[], section: ConfigurationSection) {
  if (!section.write.length) return false;
  return section.write.every(permission => hasConfigurationPermission(permissions, permission));
}
export function visibleConfigurationGroups(permissions: string[], search = '') {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return configurationGroups.map(group => ({ ...group, sections: group.sections.filter(section =>
    canReadConfiguration(permissions, section) && terms.every(term =>
      `${group.label} ${section.label} ${section.description} ${section.keywords ?? ''}`.toLocaleLowerCase().includes(term)),
  ) })).filter(group => group.sections.length > 0);
}

export const legacyConfigurationRoutes: Record<string, string> = {
  '/settings/markets': 'markets',
  '/settings/languages': 'languages',
  '/settings/catalog/industry': 'industry',
  '/settings/fulfillment': 'fulfillment',
  '/settings/delivery-fee': 'delivery-fee',
  '/settings/tax': 'tax',
  '/settings/ai-assistant': 'ai-assistant',
  '/settings/discoverability': 'discoverability/overview',
};
