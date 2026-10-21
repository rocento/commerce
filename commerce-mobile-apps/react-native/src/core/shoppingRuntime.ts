import type { CommerceClient, Locale, Storage } from './commerce';
import { AppSettingsStore } from './appSettingsStore';
import { AuthenticationForm } from './authenticationForm';
import { ShoppingSession } from './shoppingSession';

/** Owns composition and lifecycle wiring; platform storage is injected. */
export class ShoppingRuntime {
  readonly settings: AppSettingsStore;
  readonly session: ShoppingSession;
  readonly authForm = new AuthenticationForm();
  private generation = 0;
  private disconnect?: () => void;
  constructor(private client: CommerceClient, preferences?: Storage, notificationPreferences?: Storage) {
    this.settings = new AppSettingsStore(preferences);
    this.session = new ShoppingSession(client, notificationPreferences);
    this.connect();
  }
  private connect() {
    if (this.disconnect) return;
    let panel = this.session.navigation.getSnapshot().panel;
    const navigation = this.session.navigation.subscribe(() => {
      const next = this.session.navigation.getSnapshot().panel;
      if (next !== panel) { panel = next; this.authForm.clearSecrets(); }
    });
    this.session.onIdentityChange = () => this.authForm.clearSecrets();
    const settings = this.settings.subscribe(() => { this.client.locale = this.settings.getSnapshot().locale; });
    this.client.locale = this.settings.getSnapshot().locale;
    this.disconnect = () => { navigation(); settings(); this.session.onIdentityChange = undefined; };
  }
  dispose() {
    this.generation++;
    this.disconnect?.(); this.disconnect = undefined;
    this.session.dispose(); this.authForm.reset();
  }
  async start() {
    this.connect();
    const expected = ++this.generation;
    await this.session.perform(() => this.settings.restore(), 'initial');
    if (expected !== this.generation) return;
    await this.session.perform(() => this.session.workflows.recover(), 'initial', this.settings.getSnapshot().locale);
  }
  async selectLocale(locale: Locale) {
    await this.settings.selectLocale(locale);
    this.session.catalog.dismissProduct(); this.session.checkout.invalidate();
    if (this.session.account.getSnapshot().customer) await this.session.reload();
  }
}
