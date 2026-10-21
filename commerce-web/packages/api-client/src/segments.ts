import type { EntityResponse } from "./entity-id";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { ApiError } from "./identity";
import { traceFetch } from "./telemetry";

const http = createClient<paths>({ baseUrl: "/api", credentials: "include", fetch: traceFetch });
const header = { "X-Commerce-Request": "1" as const };
async function unwrap<T>(request: Promise<{ data?: T; error?: { error: string }; response: Response }>): Promise<T> {
  const result = await request;
  if (!result.response.ok) throw new ApiError(result.error?.error ?? "Request failed", result.response.status);
  return result.data as T;
}
export type CustomerSegment = EntityResponse<components["schemas"]["CustomerSegment"]>;
export type CustomerSegmentInput = components["schemas"]["CustomerSegmentInput"];
export type SegmentRule = components["schemas"]["SegmentRule"];
export type SegmentField = components["schemas"]["SegmentField"];
export const segmentsApi = {
  count: () => unwrap(http.GET("/v1/admin/customer-segments/count")),
  list: (offset = 0) => unwrap(http.GET("/v1/admin/customer-segments", { params: { query: { offset } } })),
  fields: () => unwrap(http.GET("/v1/admin/customer-segments/fields")),
  get: (id: string) => unwrap(http.GET("/v1/admin/customer-segments/{id}", { params: { path: { id } } })),
  save: (body: CustomerSegmentInput, id?: string) => id
    ? unwrap(http.PUT("/v1/admin/customer-segments/{id}", { params: { path: { id }, header }, body }))
    : unwrap(http.POST("/v1/admin/customer-segments", { params: { header }, body })),
  delete: (id: string, revision: number) => unwrap(http.DELETE("/v1/admin/customer-segments/{id}", { params: { path: { id }, query: { revision }, header } })),
};
