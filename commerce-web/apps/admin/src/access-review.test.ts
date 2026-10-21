import { describe, expect, it } from 'vitest';
import { auditDateRange, permissionChanges, sensitivePermissions } from './access-review';

describe('access review', () => {
  it('reports only actual grants and revocations, independently of order', () => {
    expect(permissionChanges(['catalog.read', 'iam.roles.write'], ['catalog.write', 'catalog.read', 'catalog.write'])).toEqual({ added: ['catalog.write'], removed: ['iam.roles.write'] });
    expect(permissionChanges(['catalog.read', 'catalog.write'], ['catalog.write', 'catalog.read'])).toEqual({ added: [], removed: [] });
  });
  it('flags unrestricted, identity, financial and channel-scoped publishing access', () => {
    expect(sensitivePermissions(['*', 'iam.roles.write', 'payments.refund', 'theme.publish@mobile', 'catalog.read'])).toEqual(['*', 'iam.roles.write', 'payments.refund', 'theme.publish@mobile']);
  });
  it('converts bounded and open-ended investigations to UTC', () => {
    expect(auditDateRange('2026-10-01T10:00:00+03:00', '')).toEqual({ created_from: '2026-10-01T07:00:00.000Z', created_to: undefined });
    expect(auditDateRange('', '')).toEqual({ created_from: undefined, created_to: undefined });
  });
  it('rejects invalid, reversed and empty date intervals', () => {
    expect(() => auditDateRange('invalid', '')).toThrow('valid dates');
    expect(() => auditDateRange('2026-10-02', '2026-10-01')).toThrow('before');
    expect(() => auditDateRange('2026-10-02', '2026-10-02')).toThrow('before');
  });
});
