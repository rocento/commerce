import { describe, expect, it } from 'vitest';
import { ShoppingWorkflows } from './shoppingWorkflows';
import { OperationCancelled } from './featureState';

describe('shopping orchestration', () => {
  it('recovers checkout before optional content and skips content for guests', async () => {
    const calls: string[] = []; let signedIn = false;
    const workflows = new ShoppingWorkflows({
      restoreAccount: async () => { calls.push('account'); return signedIn; },
      recoverySteps: ['checkout', 'delivery', 'cart', 'orders'].map(name => async () => { calls.push(name); }),
      revision: () => 0, saveItem: async () => {}, refreshWishlist: async () => {},
    });
    await workflows.recover(); expect(calls).toEqual(['account']);
    signedIn = true; calls.length = 0;
    await workflows.recover(); expect(calls).toEqual(['account', 'checkout', 'delivery', 'cart', 'orders']);
  });
  it('stops recovery and cross-feature followups when identity changes', async () => {
    let generation = 0; let followups = 0;
    const workflows = new ShoppingWorkflows({
      restoreAccount: async () => true,
      recoverySteps: [async () => { generation++; }, async () => { followups++; }],
      revision: () => generation, saveItem: async () => { generation++; },
      refreshWishlist: async () => { followups++; },
    });
    await expect(workflows.recover()).rejects.toBeInstanceOf(OperationCancelled);
    await expect(workflows.saveForLater('product')).rejects.toBeInstanceOf(OperationCancelled);
    expect(followups).toBe(0);
  });
  it('does not continue after recovery failure and permits an explicit retry', async () => {
    let fail = true; let content = 0;
    const workflows = new ShoppingWorkflows({
      restoreAccount: async () => true,
      recoverySteps: [async () => { if (fail) throw new Error('offline'); }, async () => { content++; }],
      revision: () => 0, saveItem: async () => {}, refreshWishlist: async () => {},
    });
    await expect(workflows.recover()).rejects.toThrow('offline'); expect(content).toBe(0);
    fail = false; await workflows.recover(); expect(content).toBe(1);
  });
});
