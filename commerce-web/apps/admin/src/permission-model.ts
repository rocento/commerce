export const permissions: [string, string][] = [
  ["api.docs.read", "View API documentation"],
  ["email_templates.read", "View email templates and previews"],
  ["email_templates.write", "Edit and restore email template drafts"],
  ["email_templates.publish", "Publish email templates"],
  ["markets.read", "View markets"],
  ["markets.write", "Manage draft markets and overrides"],
  ["markets.publish", "Publish markets and restore store defaults"],
  ["languages.read", "View storefront languages"],
  ["languages.write", "Manage languages and translations"],
  ["assistant.settings.read", "View AI configuration"],
  ["assistant.settings.write", "Manage AI configuration"],
  ["assistant.tracking.read", "View rengine reports"],
  ["assistant.tracking.export", "Export rengine reports"],
  ["discovery.read", "View AI discoverability configuration"],
  ["discovery.write", "Manage AI discoverability configuration"],
  ["theme.read", "View themes"],
  ["theme.create", "Create themes"],
  ["theme.edit", "Edit theme drafts"],
  ["theme.preview", "Preview theme drafts"],
  ["theme.publish", "Publish themes"],
  ["theme.rollback", "Rollback themes"],
  ["theme.assign", "Assign channel themes"],
  ["cms.read", "View content"],
  ["cms.write", "Edit content drafts"],
  ["cms.publish", "Publish/schedule content"],
  ["reviews.read", "View review queue"],
  ["reviews.moderate", "Moderate reviews"],
  ["catalog.bulk", "Bulk edit catalog"],
  ["catalog.import", "Import catalog CSV"],
  ["catalog.export", "Export catalog CSV"],
  ["inventory.import", "Import inventory CSV"],
  ["inventory.export", "Export inventory CSV"],
  ["reports.read", "View analytics reports"],
  ["support.read", "View support tickets"],
  ["support.write", "Reply to and resolve support tickets"],
  ["promotions.read", "View promotions"],
  ["promotions.write", "Manage promotions"],
  ["notifications.read", "View notification programs and audit history"],
  ["notifications.write", "Create and manage notification programs"],
  ["notifications.generate", "Generate notification records from customer journeys"],
  ["notifications.publish", "Publish and withdraw storefront inbox notifications"],
  ["tax.read", "View tax rules"],
  ["tax.write", "Manage tax rules"],
  ["fulfillment.settings.read", "View delivery fee"],
  ["fulfillment.settings.write", "Manage delivery fee"],
  ["fulfillment.dispatch", "Dispatch orders"],
  ["orders.read", "View orders"],
  ["orders.write", "Manage orders"],
  ["orders.statuses.read", "View order status definitions"],
  ["orders.statuses.manage", "Manage order status definitions"],
  ["payments.collect", "Record cash collection"],
  ["payments.refund", "Record manual refunds"],
  ["inventory.read", "View inventory"],
  ["inventory.write", "Adjust inventory"],
  ["attributes.read", "View typed attributes"],
  ["attributes.write", "Manage typed attributes"],
  ["customers.read", "View customer profiles"],
  ["customers.segments.write", "Manage customer segments"],
  ["catalog.read", "View catalog"],
  ["catalog.write", "Manage catalog"],
  ["iam.users.read", "View users"],
  ["iam.users.write", "Manage users"],
  ["iam.roles.read", "View roles"],
  ["iam.roles.write", "Manage roles"],
  ["iam.audit.read", "View audit log"],
];

export type PermissionNode = { id: string; label: string; permission?: string; children?: PermissionNode[] };
const actionOrder = ['read', 'create', 'write', 'edit', 'preview', 'publish', 'rollback', 'assign', 'bulk', 'import', 'export'];
const rank = (key: string) => { const index = actionOrder.indexOf(key.split('.').at(-1)!); return index < 0 ? actionOrder.length : index; };
const branch = (id: string, label: string, prefixes: string[]): PermissionNode => ({
  id, label, children: permissions.filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))).sort(([a], [b]) => rank(a) - rank(b)).map(([permission, label]) => ({ id: permission, permission, label })),
});
export const permissionGroups: PermissionNode[] = [
  { id: 'catalog', label: 'Catalog', children: [branch('products', 'Products & categories', ['catalog.']), branch('attributes', 'Attributes', ['attributes.'])] },
  { id: 'fulfillment', label: 'Fulfillment', children: [branch('inventory', 'Inventory', ['inventory.']), branch('delivery', 'Delivery & dispatch', ['fulfillment.'])] },
  { id: 'sales', label: 'Sales', children: [branch('orders', 'Orders', ['orders.']), branch('payments', 'Payments', ['payments.']), branch('tax', 'Tax rules', ['tax.'])] },
  branch('support', 'Support', ['support.']),
  branch('customers', 'Customers & segments', ['customers.']),
  { id: 'marketing', label: 'Marketing', children: [branch('promotions', 'Promotions', ['promotions.']), branch('notifications', 'Notifications', ['notifications.']), branch('reviews', 'Reviews', ['reviews.'])] },
  { id: 'analytics', label: 'Analytics & reports', children: [branch('reports', 'Analytics reports', ['reports.']), branch('rengine', 'rengine diagnostics', ['assistant.tracking.'])] },
  { id: 'content', label: 'Content', children: [branch('cms', 'Pages & blocks', ['cms.']), branch('themes', 'Themes & channel assignments', ['theme.'])] },
  branch('markets', 'Markets', ['markets.']),
  branch('languages', 'Storefront languages', ['languages.']),
  branch('discovery', 'Discoverability', ['discovery.']),
  { id: 'system', label: 'System', children: [branch('api-docs', 'API documentation', ['api.docs.']), branch('email-templates', 'Email templates', ['email_templates.']), branch('users', 'Admin users', ['iam.users.']), branch('roles', 'Roles & permissions', ['iam.roles.']), branch('audit', 'Audit log', ['iam.audit.']), branch('assistant', 'AI configuration', ['assistant.settings.'])] },
];
export function permissionKeys(nodes: PermissionNode[]): string[] {
  return nodes.flatMap(node => node.permission ? [node.permission] : permissionKeys(node.children || []));
}
// Keep existing scoped and extension permissions visible rather than silently losing them.
export function buildPermissionTree(selected: string[], actor: string[]): PermissionNode[] {
  const known = new Set(permissionKeys(permissionGroups));
  const extra = [...new Set([...selected, ...actor])].filter(key => key !== '*' && !known.has(key)).sort();
  const scoped = extra.filter(key => key.startsWith('theme.') && key.includes('@'));
  const channels = [...new Set(scoped.map(key => key.split('@')[1]))];
  const additional = extra.filter(key => !scoped.includes(key));
  return [...permissionGroups,
    ...(channels.length ? [{ id: 'channels', label: 'Channel-specific themes', children: channels.map(channel => ({ id: `channel:${channel}`, label: channel, children: scoped.filter(key => key.split('@')[1] === channel).map(permission => ({ id: permission, permission, label: permissions.find(([key]) => key === permission.split('@')[0])?.[1] || permission })) })) }] : []),
    ...(additional.length ? [{ id: 'additional', label: 'Additional permissions', children: additional.map(permission => ({ id: permission, permission, label: permission })) }] : []),
  ];
}
export function filterPermissions(nodes: PermissionNode[], query: string, selectedOnly: boolean, selected: Set<string>): PermissionNode[] {
  const term = query.trim().toLowerCase();
  return nodes.flatMap(node => {
    const matches = `${node.label} ${node.permission || ''}`.toLowerCase().includes(term);
    if (node.permission) return matches && (!selectedOnly || selected.has(node.permission)) ? [node] : [];
    const children = filterPermissions(node.children || [], matches ? '' : term, selectedOnly, selected);
    return children.length ? [{ ...node, children }] : [];
  });
}
export function changePermissions(current: string[], keys: string[], checked: boolean, actor: string[]): string[] {
  const allowed = new Set(actor);
  const next = new Set(current);
  for (const key of keys) {
    if (!checked) next.delete(key);
    else if (allowed.has('*') || allowed.has(key)) next.add(key);
  }
  return [...next];
}
