import { describe, expect, it } from 'vitest';
import type { EffectiveIndexingPolicy } from '@commerce/api-client';
import { crawlerStatus, indexingStatus } from './discovery-status';
const policy = (state: EffectiveIndexingPolicy['state'], merchant_preference = true) => ({ state, merchant_preference } as EffectiveIndexingPolicy);
describe('effective visibility status', () => {
  it.each(['MERCHANT_DISABLED', 'BLOCKED_BY_ENVIRONMENT', 'BLOCKED_BY_HEADER', 'DOMAIN_UNVERIFIED', 'CONFIGURATION_ERROR'] as const)('does not report access from a saved allow preference when %s', state => {
    expect(indexingStatus(policy(state)).label).not.toBe('Allowed');
    expect(crawlerStatus(policy(state), true).label).toBe('Blocked by indexing');
  });
  it('does not turn a missing observation into a positive or zero-error result', () => {
    expect(indexingStatus().label).toBe('Unavailable');
    expect(crawlerStatus(undefined, true).label).toBe('Unavailable');
    expect(crawlerStatus(policy('INDEXABLE'), undefined).label).toBe('Unavailable');
  });
  it('keeps the provider block even when indexing is allowed', () => {
    expect(crawlerStatus(policy('INDEXABLE'), false).label).toBe('Blocked');
    expect(crawlerStatus(policy('INDEXABLE'), true).label).toBe('Allowed');
  });
  it('does not present protected environments as a failure to enable production', () => {
    expect(indexingStatus(policy('BLOCKED_BY_ENVIRONMENT')).tone).toBe('neutral');
    expect(indexingStatus(policy('BLOCKED_BY_ENVIRONMENT')).label).toBe('Protected environment');
  });
  it('does not claim confirmed indexing or ranking when eligible', () => {
    expect(indexingStatus(policy('INDEXABLE')).description).toContain('not confirmed');
    expect(crawlerStatus(policy('INDEXABLE'), true).description).toContain('not confirmed');
  });
});
