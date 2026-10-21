import { ApiError } from './identity';

export interface StorefrontLanguage { locale: string; name: string; native_name: string; direction: 'ltr' | 'rtl'; revision: number }
export interface LanguageSettings { source_locale: string; languages: StorefrontLanguage[]; publication_available: boolean }
export type PublicLanguages = Pick<LanguageSettings, 'source_locale' | 'languages'>;
export type LanguageInput = Omit<StorefrontLanguage, 'revision'> & { expected_revision: number };
export type TranslationKind = 'product' | 'category' | 'navigation' | 'attribute';
export interface CatalogTranslation {
  entity_id: string; name: string; source: Record<string, string>; fields: Record<string, string>;
  revision: number; status: 'missing' | 'draft' | 'needs_review' | 'reviewed';
}
export interface TranslationPage { items: CatalogTranslation[]; total: number; missing: number; needs_review: number; reviewed: number; draft: number; offset: number; limit: number }
export interface TranslationInput { expected_revision: number; source: Record<string, string>; fields: Record<string, string>; reviewed: boolean }
function validateLanguageMetadata<T extends PublicLanguages>(settings: T): T {
  if (!settings || typeof settings.source_locale !== 'string' || !Array.isArray(settings.languages) || settings.languages.some(language => !language || typeof language.locale !== 'string' || typeof language.name !== 'string' || typeof language.native_name !== 'string')) {
    throw new Error('Language settings are unavailable. The server returned invalid language metadata.');
  }
  return settings;
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin/languages${path}`, {
    method, credentials: 'include', cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'X-Commerce-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(response.status === 409 ? 'This content changed in another session. Reload the latest version before saving.' : value.error || 'Unable to load languages', response.status);
  return value as T;
}
export const languagesApi = {
  public: async (): Promise<PublicLanguages> => {
    const response = await fetch('/api/v1/languages', { cache: 'no-store' });
    if (!response.ok) throw new ApiError('Unable to load storefront languages', response.status);
    return validateLanguageMetadata(await response.json() as PublicLanguages);
  },
  list: async () => {
    return validateLanguageMetadata(await request<LanguageSettings>(''));
  },
  save: (input: LanguageInput) => request<StorefrontLanguage>('', 'POST', input),
  translations: (locale: string, kind: TranslationKind, q = '', offset = 0) => request<TranslationPage>(`/${encodeURIComponent(locale)}/translations?${new URLSearchParams({kind, q, offset: String(offset)})}`),
  translation: (locale: string, kind: TranslationKind, id: string) => request<CatalogTranslation>(`/${encodeURIComponent(locale)}/translations/${kind}/${encodeURIComponent(id)}`),
  saveTranslation: (locale: string, kind: TranslationKind, id: string, input: TranslationInput) => request<{ revision: number; status: 'draft' | 'reviewed' }>(`/${encodeURIComponent(locale)}/translations/${kind}/${encodeURIComponent(id)}`, 'PUT', input),
};
