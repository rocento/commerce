import { type PublicLanguages } from '@commerce/api-client';
import { Notice } from '@commerce/ui';

export function ThemeLanguage({languages, locale, onChange, loading, error, onRetry}: {
  languages?: PublicLanguages; locale: string; onChange: (locale: string) => void; loading: boolean; error?: string; onRetry: () => void;
}) {
  const source = languages?.languages.find(language => language.locale === languages.source_locale);
  return <section className="theme-language-scope" aria-label="Theme language settings">
    <label className="field">Theme language<select aria-label="Theme language" value={locale} disabled={!languages || loading} onChange={event => onChange(event.target.value)}><option value="">{source ? `${source.native_name} (${source.locale}) · Source` : 'Source language'}</option>{languages?.languages.filter(language => language.locale !== languages.source_locale).map(language => <option key={language.locale} value={language.locale}>{language.native_name} ({language.locale})</option>)}</select></label>
    <p>{locale ? 'Editing translated text for the whole theme. Empty fields use source text.' : 'Editing source text for the whole theme.'} The selected language applies across layouts, components, translation review and preview. Layout, media and destinations are shared.</p>
    {loading && <p role="status">Loading storefront languages…</p>}
    <Notice error>{error}</Notice>{error && <button className="secondary" onClick={onRetry}>Retry languages</button>}
    {languages && languages.languages.length < 2 && <p>Add a storefront language in Languages to translate this theme.</p>}
  </section>;
}
