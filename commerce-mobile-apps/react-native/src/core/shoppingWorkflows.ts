import { OperationCancelled } from './featureState';

export interface ShoppingWorkflowDependencies {
  restoreAccount(): Promise<boolean>;
  recoverySteps: Array<() => Promise<void>>;
  revision(): number;
  saveItem(id: string): Promise<void>;
  refreshWishlist(): Promise<void>;
}
/** Invoked within the session gate; platform dependencies are supplied at composition. */
export class ShoppingWorkflows {
  constructor(private readonly dependencies: ShoppingWorkflowDependencies) {}
  async recover() {
    if (await this.dependencies.restoreAccount()) await this.reload();
  }
  async reload() {
    const expected = this.dependencies.revision();
    for (const step of this.dependencies.recoverySteps) {
      this.check(expected);
      await step();
      this.check(expected);
    }
  }
  async saveForLater(id: string) {
    const expected = this.dependencies.revision();
    await this.dependencies.saveItem(id);
    this.check(expected);
    await this.dependencies.refreshWishlist();
  }
  private check(expected: number) {
    if (expected !== this.dependencies.revision()) throw new OperationCancelled();
  }
}
