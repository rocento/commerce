import type { components } from "./schema";
import { ApiError } from "./identity";
import { traceFetch } from "./telemetry";
export type MobileConfig = components["schemas"]["MobileConfig"];
export type MobileSection = components["schemas"]["Mobile_Section"];
export type MobileAction = components["schemas"]["Mobile_Action"];
export type MobileAssetFolder = components["schemas"]["MobileAssetFolder"];
export type MobileAssetLibrary = components["schemas"]["MobileAssetLibrary"];
export type MobileAsset = components["schemas"]["MobileAsset"];
export type MobileMerchant = components["schemas"]["MobileMerchant"];
export type MobileDraft = components["schemas"]["MobileDraft"];
export type MobileVersion = components["schemas"]["MobileVersion"];
export type MobileAuditEvent = components["schemas"]["MobileAuditEvent"];
export type MobileIssue = components["schemas"]["MobileIssue"];
export type MobileEnvironment = "staging" | "production";
export class MobileApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    public issues: MobileIssue[] = [],
  ) {
    super(message, status);
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  key?: string,
): Promise<T> {
  const form = body instanceof FormData;
  const response = await traceFetch(`/api${path}`, {
    method,
    credentials: "include",
    signal,
    headers: {
      ...(method === "GET" ? {} : { "X-Commerce-Request": "1" }),
      ...(body && !form ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new MobileApiError(
      data?.error || `Mobile service returned ${response.status}`,
      response.status,
      data?.issues || [],
    );
  return data as T;
}
const scope = (merchant: string, env: MobileEnvironment, resource: string) =>
  `/v1/merchants/${encodeURIComponent(merchant)}/${resource}?environment=${env}`;
export type MobileCategoryChoice = components["schemas"]["MobileCategoryChoice"];
export interface MobilePreviewCategory { id: string; slug: string; name: string; imageUrl: string | null }
export interface MobileCatalogProduct { productType?: string; parentId?: string | null; optionLabel?: string; id: string; name: string; description?: string | null; price: string; originalPrice: string | null; currency: string; unit: string; inStock: boolean; imageUrl: string | null }
export interface MobileCatalogAttribute { attribute_code: string; label: string; input_type: string; is_filterable: boolean; is_visible_on_front: boolean; options: { value: string; label: string }[]; metadata?: { status?: string; facetable?: boolean; sortable?: boolean; display_order?: number } }
export interface MobileCatalog { feeds?: { id: string; name: string }[]; attributes?: MobileCatalogAttribute[]; facets?: Record<string, Record<string, number>>; merchantId: string; locale: string; source: string; categories: MobilePreviewCategory[]; products: MobileCatalogProduct[]; total?: number; nextOffset?: number | null }
export interface MobileCatalogSearch { attribute_filters?: string; q: string; collection?: string; sort?: string; in_stock?: boolean; min_price?: string; max_price?: string; offset?: number }
export interface MobilePreviewProductDetail { merchantId: string; locale: string; product: MobileCatalogProduct; variants: MobileCatalogProduct[]; requiresDeliveryLocation: boolean }
export type MobilePreviewSession = components["schemas"]["MobilePreviewSession"];
export type MobilePreviewSessionStatus = components["schemas"]["MobilePreviewSessionStatus"];
export interface AndroidServerStatus { state: string; ready: boolean; activeSessions: number | null }
export const mobileApi = {
  assetFolders: (m: string, e: MobileEnvironment, signal?: AbortSignal) => request<MobileAssetFolder[]>(scope(m, e, 'asset-folders'), 'GET', undefined, signal),
  assetLibrary: (m: string, e: MobileEnvironment, query: { folder: string; q: string; offset: number; sort: string }, signal?: AbortSignal) => request<MobileAssetLibrary>(scope(m, e, 'asset-library') + '&' + new URLSearchParams({ ...query, offset: String(query.offset) }), 'GET', undefined, signal),
  saveAssetFolder: (m: string, e: MobileEnvironment, id: string | null, name: string, parentId: string | null) => request<MobileAssetFolder>(scope(m, e, 'asset-folders' + (id ? '/' + encodeURIComponent(id) : '')), id ? 'PUT' : 'POST', { name, parentId }),
  deleteAssetFolder: (m: string, e: MobileEnvironment, id: string) => request(scope(m, e, 'asset-folders/' + encodeURIComponent(id)), 'DELETE'),
  moveAssets: (m: string, e: MobileEnvironment, ids: string[], folderId: string | null) => request(scope(m, e, 'assets/move'), 'POST', { ids, folderId }),
  renameAsset: (m: string, e: MobileEnvironment, id: string, name: string) => request(scope(m, e, 'assets/' + encodeURIComponent(id)), 'PUT', { name }),
  androidServerStatus: (m: string, signal?: AbortSignal) => request<AndroidServerStatus>(`/v1/merchants/${encodeURIComponent(m)}/app-preview/instance`, 'GET', undefined, signal),
  androidServerControl: (m: string, action: 'start' | 'stop') => request<AndroidServerStatus>(`/v1/merchants/${encodeURIComponent(m)}/app-preview/instance`, 'POST', { action }),
  startWorkerPreview: (m: string, e: MobileEnvironment, platform: 'ios' | 'android' = 'ios', implementation: 'native' | 'react-native' = 'native') => request<{ id: string; expiresAt: string }>(scope(m, e, 'app-preview/sessions/worker') + `&platform=${platform}&implementation=${implementation}`, 'POST'),
  startPreview: (m: string, e: MobileEnvironment) => request<MobilePreviewSession>(scope(m, e, 'app-preview/sessions'), 'POST'),
  previewStatus: (m: string, id: string, signal?: AbortSignal) => request<MobilePreviewSessionStatus>(`/v1/merchants/${encodeURIComponent(m)}/app-preview/sessions/${encodeURIComponent(id)}`, 'GET', undefined, signal),
  stopPreview: (m: string, id: string) => request<{ revoked: true }>(`/v1/merchants/${encodeURIComponent(m)}/app-preview/sessions/${encodeURIComponent(id)}`, 'DELETE'),
  product: (merchant: string, id: string, locale: "en"|"ar", pin?: {latitude: string; longitude: string}, signal?: AbortSignal) => {
    const query = new URLSearchParams({locale, ...(pin || {})});
    return request<MobilePreviewProductDetail>(`/v1/merchants/${encodeURIComponent(merchant)}/app-preview/products/${encodeURIComponent(id)}?${query}`, "GET", undefined, signal);
  },
  searchCatalog: (merchant: string, locale: "en" | "ar", filters: MobileCatalogSearch, signal?: AbortSignal) => {
    const query = new URLSearchParams({ locale });
    Object.entries(filters).forEach(([key, value]) => { if (value !== undefined) query.set(key, String(value)); });
    return request<MobileCatalog>(`/v1/merchants/${encodeURIComponent(merchant)}/app-preview/catalog?${query}`, "GET", undefined, signal);
  },
  catalog: (merchant: string, locale: "en" | "ar", collection?: string, signal?: AbortSignal) => request<MobileCatalog>(`/v1/merchants/${encodeURIComponent(merchant)}/app-preview/catalog?locale=${locale}${collection ? `&collection=${encodeURIComponent(collection)}` : ""}`, "GET", undefined, signal),
  categories: (merchant: string, signal?: AbortSignal) => request<MobileCategoryChoice[]>(`/v1/merchants/${encodeURIComponent(merchant)}/app-preview/categories`, "GET", undefined, signal),
  nativeIdentities: (m: string, signal?: AbortSignal) => request<components["schemas"]["MobileNativeIdentity"][]>(scope(m,"production","app-devices/identities"),"GET",undefined,signal),
  devices: (m: string, signal?: AbortSignal) => request<components["schemas"]["MobileDevice"][]>(scope(m,"production","app-devices"),"GET",undefined,signal),
  inviteDevice: (m:string, identityId:string) => request<components["schemas"]["MobileDeviceCode"]>(scope(m,"production","app-devices/invitations"),"POST",{identityId}),
  revokeDevice: (m:string, device:string) => request<components["schemas"]["MobileDeviceRevoked"]>(scope(m,"production",`app-devices/${encodeURIComponent(device)}/revoke`),"POST"),
  merchants: (signal?: AbortSignal) =>
    request<MobileMerchant[]>("/v1/mobile/merchants", "GET", undefined, signal),
  draft: (m: string, e: MobileEnvironment, signal?: AbortSignal) =>
    request<MobileDraft>(
      scope(m, e, "app-config/draft"),
      "GET",
      undefined,
      signal,
    ),
  save: (
    m: string,
    e: MobileEnvironment,
    revision: number,
    config: MobileConfig,
  ) =>
    request<MobileDraft>(scope(m, e, "app-config/draft"), "PUT", {
      expectedRevision: revision,
      config,
    }),
  validate: (m: string, e: MobileEnvironment) =>
    request<{ valid: true }>(scope(m, e, "app-config/validate"), "POST"),
  publish: (m: string, e: MobileEnvironment, revision: number, key: string) =>
    request<MobileVersion>(
      scope(m, e, "app-config/publish"),
      "POST",
      { expectedRevision: revision },
      undefined,
      key,
    ),
  rollback: (
    m: string,
    e: MobileEnvironment,
    revision: number,
    target: number,
    key: string,
  ) =>
    request<MobileVersion>(
      scope(m, e, "app-config/rollback"),
      "POST",
      { expectedRevision: revision, targetVersion: target },
      undefined,
      key,
    ),
  versions: (
    m: string,
    e: MobileEnvironment,
    signal?: AbortSignal,
    before?: number,
  ) =>
    request<MobileVersion[]>(
      scope(m, e, "app-config/versions") +
        (before ? `&beforeVersion=${before}` : ""),
      "GET",
      undefined,
      signal,
    ),
  assets: (
    m: string,
    e: MobileEnvironment,
    signal?: AbortSignal,
    before?: string,
  ) =>
    request<MobileAsset[]>(
      scope(m, e, "assets") +
        (before ? `&beforeId=${encodeURIComponent(before)}` : ""),
      "GET",
      undefined,
      signal,
    ),
  audit: (
    m: string,
    e: MobileEnvironment,
    signal?: AbortSignal,
    before?: string,
  ) =>
    request<MobileAuditEvent[]>(
      scope(m, e, "app-config/audit") +
        (before ? `&beforeId=${encodeURIComponent(before)}` : ""),
      "GET",
      undefined,
      signal,
    ),
  upload: (m: string, e: MobileEnvironment, name: string, file: File, folderId?: string | null) => {
    const data = new FormData();
    data.set("name", name);
    data.set("file", file);
    if (folderId) data.set("folderId", folderId);
    return request<MobileAsset>(scope(m, e, "assets"), "POST", data);
  },
  assetUrl: (m: string, asset: MobileAsset) => {
    if (!asset.verified) return undefined;
    if (!asset.url)
      return `/api/v1/merchants/${encodeURIComponent(m)}/assets/${encodeURIComponent(asset.id)}/content`;
    try {
      const url = new URL(asset.url);
      return url.protocol === "https:" && !url.username && !url.password
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  },
};
