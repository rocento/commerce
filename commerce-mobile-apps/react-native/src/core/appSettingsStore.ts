import type { Locale, Storage } from './commerce';
import { FeatureState } from './featureState';
export class AppSettingsStore extends FeatureState<{ locale: Locale }> {
  constructor(private preferences?: Storage, locale: Locale = 'en') { super({ locale }); }
  async restore() {
    const revision = this.generation;
    const value = await this.preferences?.get('language');
    if (revision === this.generation && (value === 'en' || value === 'ar')) this.publish({ locale: value });
  }
  /** Serialize writes through the shared operation gate. */
  async selectLocale(locale: Locale) {
    if (locale !== 'en' && locale !== 'ar') return;
    this.generation++;
    await this.preferences?.set('language', locale);
    this.publish({ locale });
  }
}
