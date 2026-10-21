import { describe, expect, it } from 'vitest';
import {
  canReadConfiguration, canWriteConfiguration, configurationGroups, hasConfigurationPermission,
  visibleConfigurationGroups,
} from './configuration-model';

const section = (path: string) => {
  const match = configurationGroups.flatMap(group => group.sections).find(item => item.path === path);
  if (!match) throw new Error(`Missing configuration section: ${path}`);
  return match;
};
const visiblePaths = (permissions: string[], search = '') =>
  visibleConfigurationGroups(permissions, search).flatMap(group => group.sections.map(item => item.path));

describe('configuration access', () => {
  it('requires both capacity and scheduling grants for their shared controls', () => {
    const capacity = section('capacity');
    const reads = ['fulfillment.capacity.view', 'fulfillment.schedule.view'];
    const writes = ['fulfillment.capacity.manage', 'fulfillment.schedule.manage'];
    for (const permission of reads) {
      expect(canReadConfiguration([permission], capacity)).toBe(false);
      expect(visiblePaths([permission])).not.toContain('capacity');
    }
    expect(canReadConfiguration(reads, capacity)).toBe(true);
    for (const permission of writes) expect(canWriteConfiguration([permission], capacity)).toBe(false);
    expect(canWriteConfiguration(writes, capacity)).toBe(true);
  });

  it.each(['*', 'theme.read', 'theme.read@storefront', 'theme.read@mobile'])(
    'admits channel assignments with the read grant %s', permission => {
      expect(hasConfigurationPermission([permission], 'theme.read')).toBe(true);
      expect(visiblePaths([permission])).not.toContain('channel-assignments');
    },
  );

  it.each(['theme.reader', 'theme.readonly@storefront', 'theme.read.storefront', 'theme.read@', 'theme.assign', 'theme.assign@storefront'])(
    'does not infer channel read access from %s', permission => {
      expect(hasConfigurationPermission([permission], 'theme.read')).toBe(false);
      expect(visiblePaths([permission])).not.toContain('channel-assignments');
    },
  );

  it('keeps markets outside system configuration', () => {
    expect(visiblePaths(['*'])).not.toContain('markets');
    expect(visiblePaths(['markets.read', 'markets.write', 'markets.publish'])).toEqual([]);
  });

  it('keeps fulfillment policy read-only when only pickup management is delegated', () => {
    const fulfillment = section('fulfillment');
    const pickupOnly = ['fulfillment.settings.view', 'fulfillment.pickup.manage'];
    expect(canReadConfiguration(pickupOnly, fulfillment)).toBe(true);
    expect(canWriteConfiguration(pickupOnly, fulfillment)).toBe(false);
    expect(canWriteConfiguration([...pickupOnly, 'fulfillment.settings.manage'], fulfillment)).toBe(true);
  });

  it('searches descriptive keywords without exposing unauthorized sections', () => {
    expect(visiblePaths(['assistant.settings.read'], '  OPENAI   key  ')).toEqual(['ai-assistant']);
    expect(visiblePaths(['tax.read'], 'openai key')).toEqual([]);
    expect(visiblePaths(['fulfillment.settings.read'], 'shipping fees')).toEqual(['delivery-fee']);
    expect(visiblePaths([], 'shipping')).toEqual([]);
    expect(visiblePaths(['tax.write'], 'tax')).toEqual([]);
    expect(visibleConfigurationGroups(['tax.read'], 'tax').map(group => group.id)).toEqual(['sales']);
  });
});
