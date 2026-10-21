import { ApiError } from './identity';
import type { TranslationKind } from './languages';
import { entityInput } from './entity-id';
export interface MarketDraft { id: string; readonly entity_id?: number; name: string; country: string; currency: string; locales: string[]; default_locale: string; revision: number }
export type MarketInput = Omit<MarketDraft, 'revision' | 'entity_id'> & { expected_revision: number };
export interface Markets { items: MarketDraft[]; live: { region: string; currency: string }; locales: string[]; source_locale?: string; activation_available: boolean; active?: { revision:number;release_id:string|null;market_id:string|null;name:string|null;created_at:string|null } }
export interface MarketOverride { source: { name: string; available: boolean; price?: string; currency?: string }; currency: string; override: { available: boolean | null; price: string | null; revision: number } }
export interface MarketOverrideInput { available: boolean | null; price: string | null; currency: string; expected_revision: number }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin/markets${path}`, { method, credentials: 'include', cache: 'no-store', headers: body === undefined ? undefined : { 'content-type': 'application/json', 'X-Commerce-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(response.status === 409 ? 'This market changed in another session. Reload before saving.' : value.error || 'Unable to load markets', response.status);
  return value as T;
}
const path = (market: string, kind: TranslationKind, id: string) => `/${encodeURIComponent(market)}/${kind}/${encodeURIComponent(id)}`;
export const marketsApi = {
  list: async () => {
    const markets = await request<Markets>('');
    if (!markets || !Array.isArray(markets.items) || !Array.isArray(markets.locales) || !markets.live || typeof markets.live.region !== 'string' || typeof markets.live.currency !== 'string') {
      throw new Error('Market settings are unavailable. The server returned invalid market metadata.');
    }
    return markets;
  },
  save: (input: MarketInput) => request<MarketDraft>('', 'POST', entityInput(input)),
  entity: (market: string, kind: TranslationKind, id: string) => request<MarketOverride>(path(market, kind, id)),
  saveEntity: (market: string, kind: TranslationKind, id: string, input: MarketOverrideInput) => request<{ revision: number }>(path(market, kind, id), 'PUT', input),
};
export interface MarketReadiness {
 token:string;ready:boolean;active_revision:number;available_products:number;missing_prices:number;overridden_products:number;source_locale:string;
 checks:{code:string;ready:boolean;message:string}[];
 delivery:{amount:string;currency:string};tax:{id:string;name:string;rate_bps:number;tax_delivery:boolean}[];
}
export interface MarketPreview {items:{id:string;sku:string;name:string;available:boolean;source_price:string;source_currency:string;price:string|null;currency:string;inherited:boolean}[];total:number;offset:number;limit:number}
export const marketPublicationApi={
 readiness:(id:string)=>request<MarketReadiness>(`/${encodeURIComponent(id)}/readiness`),
 preview:(id:string,q='',offset=0)=>request<MarketPreview>(`/${encodeURIComponent(id)}/preview?${new URLSearchParams({q,offset:String(offset)})}`),
 publish:(id:string,token:string,reason:string)=>request<{release_id:string;readonly entity_id?:number;revision:number}>(`/${encodeURIComponent(id)}/publish`,'POST',{token,reason}),
 restore:(expected_revision:number,reason:string)=>request<{revision:number}>('/restore-defaults','POST',{expected_revision,reason}),
};
