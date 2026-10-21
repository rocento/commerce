import { ApiError } from './identity';

export type InterfaceLocale = 'en' | 'ar';
export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export interface InterfaceMessage { key: string; group: string; plural: string | null; en: Partial<Record<PluralForm,string>>; ar: Partial<Record<PluralForm,string>> }
export interface InterfaceOverride { key: string; locale: InterfaceLocale; form: PluralForm; text: string; source_text: string }
export interface InterfaceBundle { revision: number; catalog_version: string; messages: InterfaceMessage[]; overrides: InterfaceOverride[] }
export interface InterfaceChange { key: string; locale: InterfaceLocale; form: PluralForm; before: string; after: string }
export interface InterfacePreview { revision: number; catalog_version: string; changes: InterfaceChange[]; errors: {row: number; field: string; message: string}[] }
export interface InterfaceEdit { key: string; locale: InterfaceLocale; form: PluralForm; text: string | null; expected_revision: number; catalog_version: string }
const base = '/api/v1/admin/languages/interface';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {method,credentials:'include',cache:'no-store',headers:body === undefined ? undefined : {'content-type':'application/json','X-Commerce-Request':'1'},body:body === undefined ? undefined : JSON.stringify(body)});
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status === 409 ? 'Translations changed after this preview or edit was opened. Reload and review the latest changes before saving.' : result && typeof result === 'object' && 'error' in result ? String(result.error) : `Translation request failed (${response.status})`,response.status);
  return result as T;
}
export const interfaceTranslationsApi = {
  public: async (signal?: AbortSignal): Promise<InterfaceBundle> => {
    const response = await fetch('/api/v1/languages/interface', { cache: 'no-store', signal });
    if (!response.ok) throw new ApiError('Unable to load storefront interface translations', response.status);
    return response.json() as Promise<InterfaceBundle>;
  },
  get: () => request<InterfaceBundle>(''),
  preview: (csv: string) => request<InterfacePreview>('/preview','POST',{csv}),
  apply: (csv: string, preview: InterfacePreview) => request<{revision: number; changed: number}>('/import','PUT',{csv,expected_revision:preview.revision,catalog_version:preview.catalog_version}),
  edit: (input: InterfaceEdit) => request<{revision: number; changed: number}>('','PUT',input),
  export: async () => {
    const response = await fetch(`${base}/export`,{credentials:'include',cache:'no-store'});
    if (!response.ok) throw new ApiError('Unable to export translations',response.status);
    return response.blob();
  },
};

export function interfaceText(bundle: InterfaceBundle, message: InterfaceMessage, locale: InterfaceLocale, form: PluralForm): string {
  return bundle.overrides.find(o => o.key === message.key && o.locale === locale && o.form === form)?.text ?? message[locale][form] ?? '';
}
/** Plain text only. Callers render as text, never as HTML. */
export function formatInterfaceMessage(bundle: InterfaceBundle, key: string, locale: InterfaceLocale, parameters: Record<string,string|number> = {}): string {
  const message = bundle.messages.find(m => m.key === key);
  if (!message) throw new Error(`Unknown interface key: ${key}`);
  let form: PluralForm = 'other';
  if (message.plural) {
    const count = parameters[message.plural];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) throw new Error(`Provide a nonnegative number for ${message.plural}`);
    form = new Intl.PluralRules(locale).select(count) as PluralForm;
  }
  if (!(form in message[locale])) form = 'other';
  return interfaceText(bundle,message,locale,form).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name: string) => {
    if (!Object.hasOwn(parameters,name)) throw new Error(`Missing placeholder: ${name}`);
    const value = parameters[name];
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
  });
}
