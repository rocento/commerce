type AuditReference = {
  action: string;
  entity_id: string;
  entity_name?: string | null;
  entity_type?: string | null;
  details: unknown;
};

export function shortAuditId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function auditEntityLabel(event: AuditReference) {
  const details = record(event.details);
  const type = event.entity_type || (event.action.startsWith('admin.role_') ? 'Role'
    : /^admin\.(user_|logged_|password_|session)/.test(event.action) ? 'Administrator'
    : event.action.startsWith('assistant.tracking.') ? (details.detail === true ? 'Assistant conversation' : 'rengine diagnostics')
    : event.action.split('.')[0].replace(/_/g, ' ').replace(/^./, value => value.toUpperCase()));
  // Historical snapshots also cover records that have since been deleted.
  const snapshot = [record(details.after), record(details.before), details]
    .flatMap(value => [value.name, value.title, value.key, value.email])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return {
    name: event.entity_name || snapshot || type || 'Record',
    context: event.entity_name || snapshot ? type : shortAuditId(event.entity_id),
  };
}
