import { FeatureState } from './featureState';
export type Tab = 'home' | 'catalog' | 'deals' | 'bag' | 'account';
export type Panel = 'support' | 'comparison' | 'coupon' | 'notifications' | 'language' | 'filters' | 'wishlist' | 'assistant' | 'auth' | 'addresses' | 'address' | 'orders' | 'order' | null;
export interface NavigationState { tab: Tab; panel: Panel; checkout: boolean }
export class NavigationStore extends FeatureState<NavigationState> {
  private orderReturn: Panel = null;
  constructor() { super({ tab: 'home', panel: null, checkout: false }); }
  setTab(tab: Tab) { this.publish({ ...this.state, tab }); }
  selectTab(tab: Tab) { this.orderReturn = null; this.publish({ tab, panel: null, checkout: false }); }
  open(panel: Panel) {
    if (panel === 'order' && this.state.panel !== 'order') this.orderReturn = this.state.panel === 'orders' || this.state.panel === 'notifications' ? this.state.panel : null;
    if (panel !== 'order') this.orderReturn = null;
    this.publish({ ...this.state, panel });
  }
  presentCheckout(checkout: boolean) { this.publish({ ...this.state, checkout }); }
  back() {
    if (this.state.panel) { const panel = this.state.panel === 'order' ? this.orderReturn : this.state.panel === 'address' ? 'addresses' : null; this.open(panel); }
    else if (this.state.checkout) this.presentCheckout(false);
    else if (this.state.tab !== 'home') this.selectTab('home');
    else return false;
    return true;
  }
  resetCustomerRoutes() { this.orderReturn = null; this.publish({ ...this.state, panel: null, checkout: false }); }
}
