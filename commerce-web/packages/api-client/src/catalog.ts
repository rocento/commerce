import type { EntityResponse } from "./entity-id";
import { entityInput } from "./entity-id";
import { traceFetch } from "./telemetry";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { ApiError, customerSessionHeaders, withCustomerSession } from "./identity";
export type Product = EntityResponse<components["schemas"]["Product"]>;
export type ProductInput = components["schemas"]["ProductInput"];
export type Category = EntityResponse<components["schemas"]["Category"]>;
export type CategoryInput = components["schemas"]["CategoryInput"];
export type Attribute = EntityResponse<components["schemas"]["Attribute"]>;
export type AttributeInput = components["schemas"]["AttributeInput"];
export type MediaFolder = EntityResponse<components["schemas"]["MediaFolder"]>;
export type LibraryMedia = EntityResponse<components["schemas"]["LibraryMedia"]>;
export type MediaFolderInput = components["schemas"]["MediaFolderInput"];
export type Media = EntityResponse<components["schemas"]["Media"]>;
export type SearchInput = NonNullable<
  paths["/v1/search"]["get"]["parameters"]["query"]
>;
const http = createClient<paths>({ baseUrl: "/api", credentials: "include", fetch: traceFetch });
const header = { "X-Commerce-Request": "1" as const };
async function unwrap<T>(
  request: Promise<{ data?: T; error?: { error: string }; response: Response }>,
): Promise<EntityResponse<T>> {
  const r = await request;
  if (r.error) throw new ApiError(r.error.error, r.response.status);
  if (!r.response.ok || r.data === undefined)
    throw new ApiError("Request failed", r.response.status);
  return r.data as EntityResponse<T>;
}
export const mediaUrl = (id: string) => `/api/v1/catalog/media/${id}/content`;
export type CatalogImage = components["schemas"]["CatalogImage"];
/** Use only advertised renditions; older or unprocessed media keeps its original URL. */
export function mediaImageProps(id: string, image?: CatalogImage): { src: string; srcSet?: string; width?: number; height?: number } {
  const src = mediaUrl(id);
  if (!image || image.id !== id || image.width <= 0 || image.height <= 0) return { src };
  const variants = [...new Map(image.variants.filter(variant => ([480, 960].includes(variant.width) || variant.width === image.width) && variant.width <= image.width && variant.height > 0).map(variant => [variant.width, variant])).values()].sort((a, b) => a.width - b.width);
  const fullSize = variants.some(variant => variant.width === image.width);
  return {
    src: fullSize ? `${src}?width=${image.width}` : src,
    width: image.width,
    height: image.height,
    ...(variants.length ? { srcSet: [...variants.map(variant => `${src}?width=${variant.width} ${variant.width}w`), ...(!fullSize ? [`${src} ${image.width}w`] : [])].join(', ') } : {}),
  };
}
export type BestsellerPeriod = components["schemas"]["BestsellerPeriod"];
export const catalogApi = {
  bestsellers: (period: BestsellerPeriod = "last_month", limit = 8, locale = "en") => withCustomerSession(() => unwrap(http.GET("/v1/catalog/bestsellers", { headers: { ...customerSessionHeaders(), "X-Storefront-Locale": locale }, params: { query: { period, limit } } }))),
  adminCategories: () => unwrap(http.GET("/v1/admin/catalog/categories")),
  categories: (locale = "en") => unwrap(http.GET("/v1/catalog/categories", { headers: { "X-Storefront-Locale": locale } })),
  categoryAvailability: (signal?: AbortSignal) => withCustomerSession(() => unwrap(http.GET("/v1/catalog/category-availability", { headers: customerSessionHeaders(), signal }))),
  product: (id: string, locale = "en") =>
    withCustomerSession(() => unwrap(http.GET("/v1/catalog/products/{id}", { headers: { ...customerSessionHeaders(), "X-Storefront-Locale": locale }, params: { path: { id } } }))),
  adminProduct: (id: string) =>
    unwrap(http.GET("/v1/admin/catalog/products/{id}", { params: { path: { id } } })),
  media: (id: string) =>
    unwrap(http.GET("/v1/catalog/media/{id}", { params: { path: { id } } })),
  search: (query: SearchInput, signal?: AbortSignal, locale = "en") =>
    withCustomerSession(() => unwrap(http.GET("/v1/search", { headers: { ...customerSessionHeaders(), "X-Storefront-Locale": locale }, params: { query }, signal }))),
  products: (offset = 0) =>
    unwrap(
      http.GET("/v1/admin/catalog/products", { params: { query: { offset } } }),
    ),
  attributes: () => unwrap(http.GET("/v1/admin/catalog/attributes")),
  mediaList: () => unwrap(http.GET("/v1/admin/catalog/media")),
  mediaFolders: () => unwrap(http.GET("/v1/admin/catalog/media/folders")),
  mediaLibrary: (query: { folder?: string; q?: string; offset?: number; limit?: number }) => unwrap(http.GET("/v1/admin/catalog/media/library", { params: { query } })),
  saveMediaFolder: (id: string | null, body: MediaFolderInput) => id
    ? unwrap(http.PUT("/v1/admin/catalog/media/folders/{id}", { params: { path: { id }, header }, body }))
    : unwrap(http.POST("/v1/admin/catalog/media/folders", { params: { header }, body })),
  deleteMediaFolder: (id: string) => unwrap(http.DELETE("/v1/admin/catalog/media/folders/{id}", { params: { path: { id }, header } })),
  moveMedia: (ids: string[], folder_id: string | null) => unwrap(http.POST("/v1/admin/catalog/media/move", { params: { header }, body: { ids, folder_id } })),

  saveProduct: (id: string | null, body: ProductInput) =>
    id
      ? unwrap(
          http.PUT("/v1/admin/catalog/products/{id}", {
            params: { path: { id }, header },
            body: entityInput(body),
          }),
        )
      : unwrap(
          http.POST("/v1/admin/catalog/products", { params: { header }, body: entityInput(body) }),
        ),
  deleteProduct: (id: string) =>
    unwrap(
      http.DELETE("/v1/admin/catalog/products/{id}", {
        params: { path: { id }, header },
      }),
    ),
  saveCategory: (id: string | null, body: CategoryInput) =>
    id
      ? unwrap(
          http.PUT("/v1/admin/catalog/categories/{id}", {
            params: { path: { id }, header },
            body: entityInput(body),
          }),
        )
      : unwrap(
          http.POST("/v1/admin/catalog/categories", {
            params: { header },
            body: entityInput(body),
          }),
        ),
  deleteCategory: (id: string) =>
    unwrap(
      http.DELETE("/v1/admin/catalog/categories/{id}", {
        params: { path: { id }, header },
      }),
    ),
  saveAttribute: (id: string | null, body: AttributeInput) =>
    id
      ? unwrap(
          http.PUT("/v1/admin/catalog/attributes/{id}", {
            params: { path: { id }, header },
            body: entityInput(body),
          }),
        )
      : unwrap(
          http.POST("/v1/admin/catalog/attributes", {
            params: { header },
            body: entityInput(body),
          }),
        ),
  deleteAttribute: (id: string) =>
    unwrap(
      http.DELETE("/v1/admin/catalog/attributes/{id}", {
        params: { path: { id }, header },
      }),
    ),
  saveMedia: (id: string, alt: string) =>
    unwrap(
      http.PUT("/v1/admin/catalog/media/{id}", {
        params: { path: { id }, header },
        body: { alt },
      }),
    ),
  deleteMedia: (id: string) =>
    unwrap(
      http.DELETE("/v1/admin/catalog/media/{id}", {
        params: { path: { id }, header },
      }),
    ),
  upload: async (file: File, alt: string, folderId?: string | null): Promise<Media> => {
    const form = new FormData();
    form.append("file", file);
    form.append("alt", alt);
    if (folderId) form.append("folder_id", folderId);
    const response = await fetch("/api/v1/admin/catalog/media", {
      method: "POST",
      credentials: "include",
      headers: { "X-Commerce-Request": "1" },
      body: form,
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(data.error ?? "Upload failed", response.status);
    return data;
  },
  event: (body: components["schemas"]["AnalyticsEvent"]) =>
    withCustomerSession(() => unwrap(http.POST("/v1/analytics/events", { params: { header }, headers: customerSessionHeaders(), body }))),
};
