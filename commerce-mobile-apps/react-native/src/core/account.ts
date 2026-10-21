import type { CommerceClient, Customer } from './commerce';
import { FeatureState } from './featureState';
export type AccountState = Readonly<{ customer: Customer | null }>;
const initial = (): AccountState => ({ customer: null });
type AccountClient = Pick<CommerceClient, 'restore' | 'login' | 'logout' | 'authAction' | 'request'>;
export class AccountStore extends FeatureState<AccountState> {
  onIdentityChange?: () => void;
  constructor(private client: AccountClient) { super(initial()); }
  reset() { this.generation++; this.publish(initial()); this.onIdentityChange?.(); }
  private accept(customer: Customer | null) {
    if (customer?.id !== this.state.customer?.id) { this.generation++; this.publish({ ...initial(), customer }); this.onIdentityChange?.(); }
    else this.publish({ ...this.state, customer });
  }
  async restore() {
    const revision = this.generation;
    const customer = this.state.customer ? await this.client.request<Customer>('v1/customer/me') : await this.client.restore();
    this.checkRevision(revision); this.accept(customer);
  }
  async login(identifier: string, password: string) {
    this.reset(); const revision = this.generation;
    const customer = await this.client.login(identifier, password); this.checkRevision(revision); this.accept(customer);
  }
  async logout() { this.reset(); await this.client.logout(); }
  async auth(action: Parameters<CommerceClient['authAction']>[0], identifier: string, password?: string, code?: string) {
    const revision = this.generation;
    await this.client.authAction(action, identifier, password, code); this.checkRevision(revision);
    if (action === 'reset-password') await this.logout();
    else if (this.state.customer) await this.restore();
  }
}
