import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, catalogApi, customerApi, type Customer, type Product } from "@commerce/api-client";
import { productQuery, startStorefront } from "./storefront-bootstrap";
vi.mock("@commerce/api-client", async () => ({
  ...await vi.importActual<typeof import('@commerce/api-client')>('@commerce/api-client'),
  ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
  customerApi: { restore: vi.fn() }, catalogApi: { product: vi.fn(), categories: vi.fn() },
  deliveryKey: () => "none", mediaUrl: (id: string) => `/api/v1/catalog/media/${id}/content`,
}));
const id = "dd688e36-7062-45c6-968d-696f0829faa6";
const product = { id, media_ids: ["photo"], price: "1.75" } as Product;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(catalogApi.categories).mockResolvedValue([]);
  vi.mocked(catalogApi.product).mockResolvedValue(product);
});
afterEach(() => client.clear());
it("starts categories immediately and personalizes product prefetch after session restore, independently of theme loading", async () => {
  const auth = deferred<Customer>();
  vi.mocked(customerApi.restore).mockReturnValue(auth.promise);
  const preload = vi.fn();
  const session = startStorefront(client, `/products/${id}`, preload);
  expect(customerApi.restore).toHaveBeenCalledTimes(1);
  expect(catalogApi.categories).toHaveBeenCalledTimes(1);
  expect(catalogApi.product).not.toHaveBeenCalled();
  auth.resolve({ id: "customer-a" } as Customer);
  expect((await session).customer?.id).toBe("customer-a");
  await vi.waitFor(() => expect(preload).toHaveBeenCalledWith("/api/v1/catalog/media/photo/content"));
  expect(await client.fetchQuery(productQuery(id, "none", "customer-a"))).toBe(product);
  expect(catalogApi.product).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(productQuery(id, "none").queryKey)).toBeUndefined();
  expect(client.getQueryData(productQuery(id, "30,31", "customer-a").queryKey)).toBeUndefined();
});
it("warms guest data after a normal signed-out response", async () => {
  vi.mocked(customerApi.restore).mockRejectedValue(new ApiError("Signed out", 401));
  const preload = vi.fn();
  expect((await startStorefront(client, `/products/${id}`, preload)).customer).toBeNull();
  await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(1));
  expect(client.getQueryData(productQuery(id, "none").queryKey)).toEqual(product);
});
it('warms the responsive detail candidate with the same sizes as the gallery', async () => {
  vi.mocked(customerApi.restore).mockRejectedValue(new ApiError('Signed out', 401));
  vi.mocked(catalogApi.product).mockResolvedValue({ ...product, images: { photo: { id: 'photo', alt: 'Ring', width: 1024, height: 1024, variants: [{ width: 480, height: 480 }, { width: 960, height: 960 }] } } });
  const preload = vi.fn();
  await startStorefront(client, `/products/${id}`, preload);
  await vi.waitFor(() => expect(preload).toHaveBeenCalledWith('/api/v1/catalog/media/photo/content', {
    srcSet: '/api/v1/catalog/media/photo/content?width=480 480w, /api/v1/catalog/media/photo/content?width=960 960w, /api/v1/catalog/media/photo/content 1024w',
    sizes: '(max-width: 650px) 100vw, 50vw',
  }));
});
it("does not cache guest pricing after an unexpected account failure", async () => {
  const error = new Error("Network unavailable");
  vi.mocked(customerApi.restore).mockRejectedValue(error);
  expect(await startStorefront(client, `/products/${id}`, vi.fn())).toEqual({ customer: null, error });
  expect(catalogApi.product).not.toHaveBeenCalled();
});
it("does not delay session readiness while the product request is pending", async () => {
  vi.mocked(customerApi.restore).mockResolvedValue({ id: "customer-a" } as Customer);
  const pending = deferred<Product>();
  vi.mocked(catalogApi.product).mockReturnValue(pending.promise);
  expect((await startStorefront(client, `/products/${id}`, vi.fn())).customer?.id).toBe("customer-a");
  expect(client.isFetching()).toBeGreaterThan(0);
  pending.resolve(product);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
});
it("leaves failed product requests retryable by the route", async () => {
  vi.mocked(customerApi.restore).mockResolvedValue({ id: "customer-a" } as Customer);
  vi.mocked(catalogApi.product).mockRejectedValueOnce(new Error("Temporary failure"));
  await startStorefront(client, `/products/${id}`, vi.fn());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(await client.fetchQuery(productQuery(id, "none", "customer-a"))).toEqual(product);
  expect(catalogApi.product).toHaveBeenCalledTimes(2);
});
it.each(["/checkout", "/assistant", "/products/not-a-uuid"])("does not prefetch products for %s", async path => {
  vi.mocked(customerApi.restore).mockResolvedValue({ id: "customer-a" } as Customer);
  await startStorefront(client, path, vi.fn());
  expect(catalogApi.product).not.toHaveBeenCalled();
  expect(catalogApi.categories).not.toHaveBeenCalled();
});
it("keeps Arabic product copy separate from English cache entries", async () => {
  const arabic = { ...product, name: "تمر" } as Product;
  vi.mocked(catalogApi.product).mockImplementation(async (_id, locale) => locale === "ar" ? arabic : product);
  expect(await client.fetchQuery(productQuery(id, "none", undefined, "ar"))).toEqual(arabic);
  expect(await client.fetchQuery(productQuery(id, "none", undefined, "en"))).toEqual(product);
  expect(catalogApi.product).toHaveBeenCalledWith(id, "ar");
  expect(catalogApi.product).toHaveBeenCalledWith(id, "en");
});
