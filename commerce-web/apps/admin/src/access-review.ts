export function permissionChanges(before: string[], after: string[]) {
  return {
    added: [...new Set(after)].filter(key => !before.includes(key)).sort(),
    removed: [...new Set(before)].filter(key => !after.includes(key)).sort(),
  };
}
export function sensitivePermissions(keys: string[]) {
  return keys.filter(key => key === '*' || ['iam.users.write', 'iam.roles.write', 'payments.refund', 'payments.collect', 'theme.publish', 'theme.assign', 'cms.publish', 'assistant.settings.write'].includes(key.split('@')[0]));
}
export function auditDateRange(from: string, to: string) {
  const start = from ? new Date(from) : undefined;
  const end = to ? new Date(to) : undefined;
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) throw new Error('Enter valid dates.');
  if (start && end && start >= end) throw new Error('Start time must be before end time.');
  return { created_from: start?.toISOString(), created_to: end?.toISOString() };
}
