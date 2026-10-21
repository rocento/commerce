import { describe, expect, it } from 'vitest';
import { buildPermissionTree, changePermissions, filterPermissions, permissionGroups, permissionKeys, permissions } from './permission-model';

describe('role resource selection', () => {
  it('organizes every supported permission exactly once', () => {
    const keys = permissionKeys(permissionGroups);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(permissions.map(([key]) => key).sort());
  });
  it('offers separate rengine read and export grants under analytics', () => {
    const tracking = filterPermissions(buildPermissionTree([], []), 'rengine', false, new Set());
    expect(tracking.map(node => node.id)).toEqual(['analytics']);
    expect(tracking[0].children?.map(node => node.id)).toEqual(['rengine']);
    expect(permissionKeys(tracking)).toEqual(['assistant.tracking.read', 'assistant.tracking.export']);
    const settings = permissionGroups.find(node => node.id === 'system')?.children?.find(node => node.id === 'assistant');
    expect(permissionKeys(settings ? [settings] : [])).toEqual(['assistant.settings.read', 'assistant.settings.write']);
    expect(changePermissions([], permissionKeys(tracking), true, ['assistant.tracking.read'])).toEqual(['assistant.tracking.read']);
    expect(changePermissions([], permissionKeys(tracking), false, ['*'])).toEqual([]);
  });
  it('keeps ancestor paths when searching and limits changes to matches', () => {
    const current = ['catalog.read', 'theme.read@storefront'];
    const visible = filterPermissions(permissionGroups, 'import', false, new Set(current));
    expect(visible.map(node => node.label)).toEqual(['Catalog', 'Fulfillment']);
    const keys = permissionKeys(visible);
    expect(keys.sort()).toEqual(['catalog.import', 'inventory.import']);
    expect(changePermissions(current, keys, true, ['*']).sort()).toEqual([...current, ...keys].sort());
    expect(changePermissions([...current, ...keys], keys, false, ['*'])).toEqual(current);
  });
  it('never grants permissions outside the acting administrator’s permissions', () => {
    const selected = changePermissions([], permissionKeys(permissionGroups), true, ['catalog.read']);
    expect(selected).toEqual(['catalog.read']);
    expect(selected).not.toContain('*');
    expect(changePermissions(['theme.edit'], ['theme.edit'], false, ['catalog.read'])).toEqual([]);
  });
  it('preserves and exposes channel-scoped and unrecognized existing permissions', () => {
    const current = ['theme.edit@storefront', 'extension.read'];
    const nodes = buildPermissionTree(current, ['theme.read@mobile']);
    expect(permissionKeys(nodes)).toEqual(expect.arrayContaining([...current, 'theme.read@mobile']));
    const scoped = filterPermissions(nodes, 'theme.edit@storefront', false, new Set(current));
    expect(permissionKeys(scoped)).toEqual(['theme.edit@storefront']);
    expect(changePermissions(current, ['catalog.read'], true, ['*'])).toEqual([...current, 'catalog.read']);
  });
  it('selected-only filtering keeps selection intact outside the view', () => {
    const current = ['catalog.read', 'iam.roles.read'];
    const visible = filterPermissions(permissionGroups, 'catalog', true, new Set(current));
    expect(permissionKeys(visible)).toEqual(['catalog.read']);
    expect(changePermissions(current, permissionKeys(visible), false, ['*'])).toEqual(['iam.roles.read']);
  });
});
