import { describe, expect, it } from 'vitest';
import { auditEntityLabel, shortAuditId } from './audit-labels';

const base = { entity_id: '20000000-0000-0000-0000-000000000002', action: 'admin.role_updated', details: {} };
describe('audit entity labels', () => {
  it('uses resolved names and retains the entity type', () => {
    expect(auditEntityLabel({ ...base, entity_name: 'Catalog team', entity_type: 'Role' })).toEqual({ name: 'Catalog team', context: 'Role' });
  });
  it('recovers deleted record names from historical evidence', () => {
    expect(auditEntityLabel({ ...base, details: { before: { name: 'Former role' } } }).name).toBe('Former role');
  });
  it('distinguishes conversation reads from tracking list reads', () => {
    expect(auditEntityLabel({ ...base, action: 'assistant.tracking.read_requested', details: { detail: true } }).name).toBe('Assistant conversation');
    expect(auditEntityLabel({ ...base, action: 'assistant.tracking.read_requested', details: { detail: false } }).name).toBe('rengine diagnostics');
  });
  it('keeps unknown references distinguishable without displaying a full UUID', () => {
    expect(auditEntityLabel({ ...base, details: null })).toEqual({ name: 'Role', context: '20000000…0002' });
    expect(shortAuditId(base.entity_id)).toBe('20000000…0002');
  });
});
