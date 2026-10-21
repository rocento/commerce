import type { EntityResponse } from "./entity-id";
import { entityInput } from "./entity-id";
import { traceFetch } from "./telemetry";
import { parseAssistantFailure } from "./assistant-validation";
import createClient from "openapi-fetch";
import type { paths, components } from "./schema";
export type Customer = EntityResponse<components["schemas"]["Customer"]>;
export type Location = EntityResponse<components["schemas"]["Location"]>;
export type LocationInput = components["schemas"]["LocationInput"];
export function locationAddress(location: Pick<LocationInput, "formatted_address" | "geography">): string {
  const g = location.geography;
  const area = g ? [g.city_name, g.state_name, g.country_code === "EG" ? "Egypt" : g.country_code].filter(Boolean).join(", ") : "";
  return !area || location.formatted_address === area ? location.formatted_address : [location.formatted_address, area].filter(Boolean).join(", ");
}

export type AdminIdentity = EntityResponse<components["schemas"]["Identity"]>;
export type AdminUser = EntityResponse<components["schemas"]["Admin"]>;
export type Role = EntityResponse<components["schemas"]["Role"]>;
export type Audit = components["schemas"]["Audit"];
export type UserInput = components["schemas"]["UserInput"];
export type RoleInput = components["schemas"]["RoleInput"];
const http = createClient<paths>({
  baseUrl: "/api",
  credentials: "include",
  fetch: traceFetch,
});
let accessToken: string | undefined;
http.use({
  onRequest({ request }) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/v1/cart/proposals") || path.startsWith("/api/v1/cart/shopping/")) request.headers.set("X-Commerce-Assistant-Errors", "1");
    if (
      accessToken &&
      (new URL(request.url).pathname.includes("/customer/") ||
        new URL(request.url).pathname.startsWith("/api/v1/cart") ||
        new URL(request.url).pathname.startsWith("/api/v1/support/") ||
        new URL(request.url).pathname.startsWith("/api/v1/assistant/"))
    )
      request.headers.set("Authorization", `Bearer ${accessToken}`);
    return request;
  },
});
const header = { "X-Commerce-Request": "1" as const };
const mutation = { params: { header } };
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public failure?: components["schemas"]["AssistantFailure"],
  ) {
    super(message);
  }
}
function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): EntityResponse<T> {
  if (!result.response.ok) {
    const error = result.error;
    const message =
      typeof error === "object" && error !== null && "error" in error
        ? String(error.error)
        : `Request failed (${result.response.status})`;
    const failure = error && typeof error === "object" && "failure" in error ? parseAssistantFailure(error.failure) : undefined;
    throw new ApiError(failure?.message ?? message, result.response.status, failure);
  }
  return result.data as EntityResponse<T>;
}
let restoring: Promise<Customer> | undefined;
let sessionRevision = 0;
function replaceSession(token?: string) {
  sessionRevision++;
  accessToken = token;
  restoring = undefined;
  openingCart = undefined;
}
async function restore(): Promise<Customer> {
  if (!restoring) {
    const revision = sessionRevision;
    const pending = (async () => {
      const result = await http.POST("/v1/customer/auth/refresh", mutation);
      // A response started before logout, reset or another login belongs to the
      // previous session and must not restore its identity or bearer token.
      if (revision !== sessionRevision) throw new ApiError("Session changed", 401);
      if (result.response.status === 401 || result.response.status === 403) replaceSession();
      if (result.response.status === 204) {
        replaceSession();
        // Keep the existing signed-out contract for callers without generating
        // a failed network response for a guest's normal session check.
        throw new ApiError("Signed out", 401);
      }
      const auth = unwrap(result);
      accessToken = auth.access_token;
      return auth.customer;
    })().finally(() => {
      if (restoring === pending) restoring = undefined;
    });
    restoring = pending;
  }
  return restoring;
}
async function authorized<T>(call: () => Promise<T>): Promise<T> {
  const revision = sessionRevision;
  try {
    const result = await call();
    if (revision !== sessionRevision) throw new ApiError("Session changed", 401);
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || revision !== sessionRevision) throw error;
    try { await restore(); } catch (refreshError) { throw error.failure ? error : refreshError; }
    if (revision !== sessionRevision) throw error;
    const result = await call();
    if (revision !== sessionRevision) throw new ApiError("Session changed", 401);
    return result;
  }
}
export const customerApi = {
  restore,
  register: async (identifier: string, password: string) =>
    unwrap(
      await http.POST("/v1/customer/auth/register", {
        ...mutation,
        body: { identifier, password },
      }),
    ),
  login: async (identifier: string, password: string) => {
    const auth = unwrap(
      await http.POST("/v1/customer/auth/login", {
        ...mutation,
        body: { identifier, password },
      }),
    );
    replaceSession(auth.access_token);
    return auth.customer;
  },
  logout: async () => {
    unwrap(await http.POST("/v1/customer/auth/logout", mutation));
    replaceSession();
  },
  requestVerification: async (identifier: string) =>
    unwrap(
      await http.POST("/v1/customer/auth/request-verification", {
        ...mutation,
        body: { identifier },
      }),
    ),
  verify: async (identifier: string, token: string) =>
    unwrap(
      await http.POST("/v1/customer/auth/verify", {
        ...mutation,
        body: { identifier, token },
      }),
    ),
  forgot: async (identifier: string) =>
    unwrap(
      await http.POST("/v1/customer/auth/forgot-password", {
        ...mutation,
        body: { identifier },
      }),
    ),
  reset: async (identifier: string, token: string, password: string) => {
    const result = unwrap(
      await http.POST("/v1/customer/auth/reset-password", {
        ...mutation,
        body: { identifier, token, password },
      }),
    );
    replaceSession();
    return result;
  },
  me: () => authorized(async () => unwrap(await http.GET("/v1/customer/me"))),
  locations: () =>
    authorized(async () => unwrap(await http.GET("/v1/customer/locations"))),
  saveLocation: (body: LocationInput, id?: string) =>
    authorized(async () =>
      id
        ? unwrap(
            await http.PUT("/v1/customer/locations/{id}", {
              params: { header, path: { id } },
              body: entityInput(body),
            }),
          )
        : unwrap(
            await http.POST("/v1/customer/locations", { ...mutation, body: entityInput(body) }),
          ),
    ),
  deleteLocation: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.DELETE("/v1/customer/locations/{id}", {
          params: { header, path: { id } },
        }),
      ),
    ),
};
export const adminApi = {
  me: async () => unwrap(await http.GET("/v1/admin/me")),
  login: async (email: string, password: string) =>
    unwrap(
      await http.POST("/v1/admin/auth/login", {
        ...mutation,
        body: { email, password },
      }),
    ),
  logout: async () =>
    unwrap(await http.POST("/v1/admin/auth/logout", mutation)),
  users: async () => unwrap(await http.GET("/v1/admin/users")),
  roles: async () => unwrap(await http.GET("/v1/admin/roles")),
  audit: async (q = "", offset = 0) =>
    unwrap(
      await http.GET("/v1/admin/audit", { params: { query: { q, offset } } }),
    ),
  saveUser: async (body: UserInput, id?: string) =>
    id
      ? unwrap(
          await http.PUT("/v1/admin/users/{id}", {
            params: { header, path: { id } },
            body: entityInput(body),
          }),
        )
      : unwrap(await http.POST("/v1/admin/users", { ...mutation, body: entityInput(body) })),
  deleteUser: async (id: string) =>
    unwrap(
      await http.DELETE("/v1/admin/users/{id}", {
        params: { header, path: { id } },
      }),
    ),
  saveRole: async (body: RoleInput, id?: string) =>
    id
      ? unwrap(
          await http.PUT("/v1/admin/roles/{id}", {
            params: { header, path: { id } },
            body: entityInput(body),
          }),
        )
      : unwrap(await http.POST("/v1/admin/roles", { ...mutation, body: entityInput(body) })),
  deleteRole: async (id: string) =>
    unwrap(
      await http.DELETE("/v1/admin/roles/{id}", {
        params: { header, path: { id } },
      }),
    ),
};

export type Cart = EntityResponse<components["schemas"]["Cart"]>;
export type CartItem = components["schemas"]["CartItem"];
let openingCart: Promise<Cart> | undefined;
function openCart(): Promise<Cart> {
  if (!openingCart) {
    const pending = authorized(async () =>
      unwrap(await http.POST("/v1/cart", mutation)),
    ).finally(() => {
      if (openingCart === pending) openingCart = undefined;
    });
    openingCart = pending;
  }
  return openingCart;
}
export const cartApi = {
  trust: () => authorized(() => http.GET("/v1/cart/trust").then(unwrap)),
  trustCapabilities: () => http.GET("/v1/agents/capabilities").then(unwrap),
  confirmProposal: (proposal_id: string, idempotency_key: string, grant_id: string | null = null) => authorized(() => http.POST("/v1/cart/trust/confirm", { ...mutation, body: { proposal_id, idempotency_key, grant_id } }).then(unwrap)),
  actionStatus: (id: string) => authorized(() => http.GET("/v1/cart/trust/actions/{id}", { params: { path: { id } } }).then(unwrap)),
  grant: (body: components["schemas"]["TrustGrantInput"]) => authorized(() => http.POST("/v1/cart/trust/grants", { ...mutation, body }).then(unwrap)),
  revokeGrant: (id: string) => authorized(() => http.DELETE("/v1/cart/trust/grants/{id}", { params: { header, path: { id } } }).then(unwrap)),
  executionGoal: (task: string) => authorized(() => http.GET("/v1/cart/shopping/{task}/goal", { params: { path: { task } } }).then(unwrap)),
  saveExecutionGoal: (task: string, revision: number) => authorized(() => http.POST("/v1/cart/shopping/{task}/goal", { params: { header, path: { task } }, body: { revision } }).then(unwrap)),
  resumeExecutionGoal: (task: string, revision: number) => authorized(() => http.POST("/v1/cart/shopping/{task}/resume", { params: { header, path: { task } }, body: { revision } }).then(unwrap)),
  shoppingContext: (task: string) => authorized(() => http.GET("/v1/cart/shopping/{task}", { params: { path: { task } } }).then(unwrap)),
  cancelShopping: (task: string) => authorized(() => http.DELETE("/v1/cart/shopping/{task}", { ...mutation, params: { header, path: { task } } }).then(unwrap)),
  proposal: (id: string) => authorized(() => http.GET("/v1/cart/proposals/{id}", { params: { path: { id } } }).then(unwrap)),
  propose: (body: components["schemas"]["BasketDraft"]) => authorized(() => http.POST("/v1/cart/proposals", { ...mutation, body }).then(unwrap)),
  applyProposal: (id: string, idempotency_key: string) => authorized(() => http.POST("/v1/cart/proposals/{id}/apply", { params: { header, path: { id } }, body: { idempotency_key } }).then(unwrap)),
  coupon: (code: string) =>
    authorized(async () =>
      unwrap(
        await http.PUT("/v1/cart/coupon", { ...mutation, body: { code } }),
      ),
    ),
  open: openCart,
  add: (product_id: string, quantity: number) =>
    authorized(async () => {
      await openCart();
      return unwrap(
        await http.POST("/v1/cart/items", {
          ...mutation,
          body: { product_id, quantity },
        }),
      );
    }),
  update: (id: string, quantity: number) =>
    authorized(async () =>
      unwrap(
        await http.PUT("/v1/cart/items/{id}", {
          params: { header, path: { id } },
          body: { quantity },
        }),
      ),
    ),
  remove: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.DELETE("/v1/cart/items/{id}", {
          params: { header, path: { id } },
        }),
      ),
    ),
};
export const inventoryApi = {
  list: async (offset = 0) =>
    unwrap(
      await http.GET("/v1/admin/inventory", { params: { query: { offset } } }),
    ),
  stock: async (id: string) =>
    unwrap(await http.GET("/v1/inventory/{id}", { params: { path: { id } } })),
  detail: async (id: string) =>
    unwrap(
      await http.GET("/v1/admin/inventory/{id}", { params: { path: { id } } }),
    ),
  adjust: async (id: string, on_hand: number, reason: string) =>
    unwrap(
      await http.PUT("/v1/admin/inventory/{id}", {
        params: { header, path: { id } },
        body: { on_hand, reason },
      }),
    ),
};

export type CheckoutQuote = EntityResponse<components["schemas"]["CheckoutQuote"]>;
export type Order = EntityResponse<components["schemas"]["Order"]>;
export type OrderDetail = EntityResponse<components["schemas"]["OrderDetail"]>;
export type OrderStatus = Order["status"];
export const orderApi = {
  quote: (location_id: string | null, gift_message?: string) =>
    authorized(async () =>
      unwrap(
        await http.POST("/v1/customer/checkout/quote", {
          ...mutation,
          body: { location_id, gift_message },
        }),
      ),
    ),
  place: (quote_id: string, idempotency_key: string) =>
    authorized(async () =>
      unwrap(
        await http.POST("/v1/customer/checkout/place", {
          ...mutation,
          body: { quote_id, idempotency_key },
        }),
      ),
    ),
  list: (offset = 0) =>
    authorized(async () =>
      unwrap(
        await http.GET("/v1/customer/orders", {
          params: { query: { offset } },
        }),
      ),
    ),
  detail: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.GET("/v1/customer/orders/{id}", {
          params: { path: { id } },
        }),
      ),
    ),
};
export const adminOrderApi = {
  sales: async (offset = 0) =>
    unwrap(
      await http.GET("/v1/admin/orders/sales", { params: { query: { offset } } }),
    ),
  list: async (offset = 0) =>
    unwrap(
      await http.GET("/v1/admin/orders", { params: { query: { offset } } }),
    ),
  detail: async (id: string) =>
    unwrap(
      await http.GET("/v1/admin/orders/{id}", { params: { path: { id } } }),
    ),
  transition: async (id: string, status: OrderStatus, reason: string) =>
    unwrap(
      await http.POST("/v1/admin/orders/{id}/status", {
        params: { path: { id }, header },
        body: { status, reason },
      }),
    ),
  refund: async (id: string, reason: string) =>
    unwrap(
      await http.POST("/v1/admin/orders/{id}/refund", {
        params: { path: { id }, header },
        body: { reason },
      }),
    ),
};

export type TaxRule = EntityResponse<components["schemas"]["TaxRule"]>;
export type TaxRuleInput = components["schemas"]["TaxRuleInput"];
export const fulfillmentApi = {
  fee: async () => unwrap(await http.GET("/v1/admin/settings/delivery-fee")),
  setFee: async (amount: string, reason: string) =>
    unwrap(
      await http.PUT("/v1/admin/settings/delivery-fee", {
        ...mutation,
        body: { amount, reason },
      }),
    ),
  rules: async () => unwrap(await http.GET("/v1/admin/tax/rules")),
  saveRule: async (body: TaxRuleInput, id?: string) =>
    id
      ? unwrap(
          await http.PUT("/v1/admin/tax/rules/{id}", {
            params: { path: { id }, header },
            body: entityInput(body),
          }),
        )
      : unwrap(await http.POST("/v1/admin/tax/rules", { ...mutation, body: entityInput(body) })),
  dispatch: async (id: string, tracking_reference: string, reason: string, shipment_id?: string) =>
    unwrap(
      await http.POST("/v1/admin/orders/{id}/dispatch", {
        params: { path: { id }, header },
        body: { tracking_reference, reason, shipment_id },
      }),
    ),
};

export type PromotionInput = components["schemas"]["PromotionInput"];
export type Promotion = EntityResponse<components["schemas"]["Promotion"]>;
export type AppliedDiscount = components["schemas"]["AppliedDiscount"];
export const promotionApi = {
  list: async () => unwrap(await http.GET("/v1/admin/promotions")),
  save: async (body: PromotionInput, id?: string) =>
    id
      ? unwrap(
          await http.PUT("/v1/admin/promotions/{id}", {
            params: { path: { id }, header },
            body: entityInput(body),
          }),
        )
      : unwrap(await http.POST("/v1/admin/promotions", { ...mutation, body: entityInput(body) })),
  remove: async (id: string) =>
    unwrap(
      await http.DELETE("/v1/admin/promotions/{id}", {
        params: { path: { id }, header },
      }),
    ),
};

// SSE uses the same in-memory customer session and shared transport boundary.
export function assistantHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Commerce-Request": "1",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}
export type SupportInput = components["schemas"]["AssistantTicketInput"];
export type SupportTicket = EntityResponse<components["schemas"]["AssistantTicket"]>;
export type SupportDetail = EntityResponse<components["schemas"]["AssistantTicketDetail"]>;
export const supportApi = {
  initialize: async () =>
    unwrap(await http.POST("/v1/support/session", mutation)),
  create: async (body: SupportInput) => {
    await supportApi.initialize();
    return unwrap(
      await http.POST("/v1/support/tickets", { ...mutation, body }),
    );
  },
  list: () =>
    authorized(async () =>
      unwrap(await http.GET("/v1/customer/support/tickets")),
    ),
  detail: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.GET("/v1/customer/support/tickets/{id}", {
          params: { path: { id } },
        }),
      ),
    ),
  reply: (id: string, request_id: string, body: string) =>
    authorized(async () =>
      unwrap(
        await http.POST("/v1/customer/support/tickets/{id}/messages", {
          params: { path: { id }, header },
          body: { request_id, body },
        }),
      ),
    ),
};
export const adminSupportApi = {
  list: async () => unwrap(await http.GET("/v1/admin/support/tickets")),
  detail: async (id: string) =>
    unwrap(
      await http.GET("/v1/admin/support/tickets/{id}", {
        params: { path: { id } },
      }),
    ),
  reply: async (
    id: string,
    request_id: string,
    body: string,
    status: SupportTicket["status"],
  ) =>
    unwrap(
      await http.POST("/v1/admin/support/tickets/{id}/messages", {
        params: { path: { id }, header },
        body: { request_id, body, status },
      }),
    ),
};

export type ContentBlock = components["schemas"]["ContentBlock"];
export type ContentInput = components["schemas"]["ContentInput"];
export type ContentDetail = EntityResponse<components["schemas"]["ContentDetail"]>;
export type ReviewInput = components["schemas"]["ReviewInput"];
export type Review = EntityResponse<components["schemas"]["Review"]>;
export type CatalogFilter = components["schemas"]["CatalogFilter"];
export type BulkInput = components["schemas"]["BulkInput"];
const filterQuery = (f: CatalogFilter) => ({
  q: f.q,
  offset: f.offset,
  category_id: f.category_id ?? undefined,
  active: f.active ?? undefined,
});
export const contentApi = {
  public: async (key: string, locale?: string) =>
    unwrap(await http.GET("/v1/content/{key}", { params: { path: { key }, query: { locale } } })),
  list: async () => unwrap(await http.GET("/v1/admin/content")),
  detail: async (id: string) =>
    unwrap(
      await http.GET("/v1/admin/content/{id}", { params: { path: { id } } }),
    ),
  save: async (body: ContentInput) =>
    unwrap(await http.POST("/v1/admin/content", { ...mutation, body })),
  publish: async (id: string, body: components["schemas"]["ContentPublish"]) =>
    unwrap(
      await http.POST("/v1/admin/content/{id}/releases", {
        params: { path: { id }, header },
        body,
      }),
    ),
  media: async () => unwrap(await http.GET("/v1/admin/content/media")),
};
export const reviewApi = {
  public: async (id: string, offset = 0) =>
    unwrap(
      await http.GET("/v1/products/{id}/reviews", {
        params: { path: { id }, query: { offset } },
      }),
    ),
  own: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.GET("/v1/customer/products/{id}/review", {
          params: { path: { id } },
        }),
      ),
    ),
  submit: (id: string, body: ReviewInput) =>
    authorized(async () =>
      unwrap(
        await http.PUT("/v1/customer/products/{id}/review", {
          params: { path: { id }, header },
          body,
        }),
      ),
    ),
  queue: async (status: string, offset = 0) =>
    unwrap(
      await http.GET("/v1/admin/reviews", {
        params: { query: { status, offset } },
      }),
    ),
  moderate: async (
    id: string,
    body: components["schemas"]["ReviewModeration"],
  ) =>
    unwrap(
      await http.PUT("/v1/admin/reviews/{id}", {
        params: { path: { id }, header },
        body,
      }),
    ),
};
export const wishlistApi = {
  list: () =>
    authorized(async () => unwrap(await http.GET("/v1/customer/wishlist"))),
  add: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.PUT("/v1/customer/wishlist/{id}", {
          params: { path: { id }, header },
        }),
      ),
    ),
  remove: (id: string) =>
    authorized(async () =>
      unwrap(
        await http.DELETE("/v1/customer/wishlist/{id}", {
          params: { path: { id }, header },
        }),
      ),
    ),
};
export const operationsApi = {
  products: async (f: CatalogFilter) =>
    unwrap(
      await http.GET("/v1/admin/operations/products", {
        params: { query: filterQuery(f) },
      }),
    ),
  ids: async (f: CatalogFilter) =>
    unwrap(
      await http.GET("/v1/admin/operations/product-ids", {
        params: { query: filterQuery(f) },
      }),
    ),
  bulk: async (body: BulkInput) =>
    unwrap(await http.POST("/v1/admin/operations/bulk", { ...mutation, body })),
  export: async (kind: string, f: CatalogFilter) =>
    unwrap(
      await http.GET("/v1/admin/operations/{kind}/export", {
        params: { path: { kind }, query: filterQuery(f) },
      }),
    ),
  import: async (kind: string, body: components["schemas"]["CsvInput"]) =>
    unwrap(
      await http.POST("/v1/admin/operations/{kind}/import", {
        params: { path: { kind }, header },
        body,
      }),
    ),
  filters: async () => unwrap(await http.GET("/v1/admin/filters")),
  saveFilter: async (name: string, filters: CatalogFilter) =>
    unwrap(
      await http.POST("/v1/admin/filters", {
        ...mutation,
        body: { name, filters },
      }),
    ),
  deleteFilter: async (id: string) =>
    unwrap(
      await http.DELETE("/v1/admin/filters/{id}", {
        params: { path: { id }, header },
      }),
    ),
};

export const assistantHistory = (conversation_id?: string) =>
  authorized(async () => unwrap(await http.GET("/v1/assistant/history", { params: { query: { conversation_id } } })));

export type AttributeDefinition = EntityResponse<components["schemas"]["AttributeDefinition"]>;
export type AttributeSet = EntityResponse<components["schemas"]["AttributeSet"]>;
export type ProductStructure = components["schemas"]["ProductStructure"];
export type CustomerProfile = components["schemas"]["CustomerProfile"];
export const attributeApi = {
 promo: (id:string) => http.GET("/v1/admin/promotions/{id}/attribute-conditions",{params:{path:{id}}}).then(unwrap),
 savePromo: (id:string,body:Record<string,unknown>) => http.PUT("/v1/admin/promotions/{id}/attribute-conditions",{params:{path:{id},header},body}).then(unwrap),
 list: (entity_type: AttributeDefinition["entity_type"]) => http.GET("/v1/admin/attribute-definitions",{params:{query:{entity_type}}}).then(unwrap),
 public: (locale?: string) => http.GET("/v1/catalog/attribute-definitions", {params:{query:{locale}}}).then(unwrap),
 save: (body:AttributeDefinition) => http.POST("/v1/admin/attribute-definitions",{...mutation,body:entityInput(body)}).then(unwrap),
 delete: (id:string) => http.DELETE("/v1/admin/attribute-definitions/{id}",{params:{path:{id},header}}).then(unwrap),
 sets: () => http.GET("/v1/admin/attribute-sets").then(unwrap),
 saveSet: (body:AttributeSet) => http.POST("/v1/admin/attribute-sets",{...mutation,body:entityInput(body)}).then(unwrap),
 deleteSet: (id:string) => http.DELETE("/v1/admin/attribute-sets/{id}",{params:{path:{id},header}}).then(unwrap),
 family: (id:string, locale = "en") => withCustomerSession(() => http.GET("/v1/catalog/products/{id}/family",{headers:{...customerSessionHeaders(),"X-Storefront-Locale":locale},params:{path:{id}}}).then(unwrap)),
 adminFamily: (id:string) => http.GET("/v1/admin/catalog/products/{id}/family",{params:{path:{id}}}).then(unwrap),
 structure: (id:string,body:ProductStructure) => http.PUT("/v1/admin/catalog/products/{id}/family",{params:{path:{id},header},body}).then(unwrap),
 category: (id:string) => http.GET("/v1/admin/catalog/categories/{id}/attributes",{params:{path:{id}}}).then(unwrap),
 saveCategory: (id:string,body:Record<string,unknown>) => http.PUT("/v1/admin/catalog/categories/{id}/attributes",{params:{path:{id},header},body}).then(unwrap),
 profile: () => authorized(()=>http.GET("/v1/customer/profile").then(unwrap)),
 saveProfile: (body:components["schemas"]["ProfileInput"]) => authorized(()=>http.PUT("/v1/customer/profile",{...mutation,body}).then(unwrap)),
 customerDefinitions: (locale?: string) => authorized(()=>http.GET("/v1/customer/attribute-definitions", {params:{query:{locale}}}).then(unwrap)),
 bundle: (id:string,selected:string[]) => authorized(()=>http.POST("/v1/cart/bundles/{id}",{params:{path:{id},header},body:{selected}}).then(unwrap)),
 order: (id:string) => authorized(()=>http.GET("/v1/customer/orders/{id}/extensions",{params:{path:{id}}}).then(unwrap)),
  adminOrder: (id:string) => http.GET("/v1/admin/orders/{id}/extensions",{params:{path:{id}}}).then(unwrap),
  comments: (id:string) => http.GET("/v1/admin/orders/{id}/comments",{params:{path:{id}}}).then(unwrap),
  comment: (id:string,body:string) => http.POST("/v1/admin/orders/{id}/comments",{params:{path:{id},header},body:{body}}).then(unwrap),
};

export const adminCustomerApi = {
  journey: (id: string, query: NonNullable<paths["/v1/admin/customers/{id}/journey"]["get"]["parameters"]["query"]>, signal?: AbortSignal) =>
    http.GET("/v1/admin/customers/{id}/journey", { params: { path: { id }, query }, signal }).then(unwrap),
  profile: (id: string) =>
    http
      .GET("/v1/admin/customers/{id}/profile", { params: { path: { id } } })
      .then(unwrap),
};

// Theme resolution shares the authenticated customer session without exposing tokens.
export const customerSessionHeaders = assistantHeaders;
export function withCustomerSession<T>(call: () => Promise<T>): Promise<T> {
  return accessToken ? authorized(call) : call();
}

export type IndustryProfile = EntityResponse<components["schemas"]["IndustryProfile"]>;
export type IndustryPreview = EntityResponse<components["schemas"]["IndustryPreview"]>;
export type AttributeMetadata = components["schemas"]["AttributeMetadata"];
export const catalogSchemaApi = {
 discovery: () => http.GET("/v1/admin/catalog/discovery").then(unwrap),
 discoveryConfigure: (enabled:boolean) => http.PUT("/v1/admin/catalog/discovery",{...mutation,body:{enabled}}).then(unwrap),
 schema: () => http.GET("/v1/catalog/schema").then(unwrap),
 profiles: () => http.GET("/v1/admin/catalog/industry-profiles").then(unwrap),
 saveProfile: (body: IndustryProfile) => http.POST("/v1/admin/catalog/industry-profiles",{...mutation,body:{...entityInput(body),template:body.template.map(item=>({...item,definition:entityInput(item.definition)}))}}).then(unwrap),
 configuration: () => http.GET("/v1/admin/catalog/industry").then(unwrap),
 preview: (id:string) => http.GET("/v1/admin/catalog/industry-profiles/{id}/preview",{params:{path:{id}}}).then(unwrap),
 apply: (body:components["schemas"]["IndustryApply"]) => http.PUT("/v1/admin/catalog/industry",{...mutation,body}).then(unwrap),
 values: (id:string) => http.GET("/v1/admin/catalog/products/{id}/attribute-values",{params:{path:{id}}}).then(unwrap),
 suggestions: (query: NonNullable<paths['/v1/admin/catalog/enrichment']['get']['parameters']['query']> = {}) => http.GET("/v1/admin/catalog/enrichment",{params:{query}}).then(unwrap),
 generateEnrichment: (id:string) => http.POST('/v1/admin/catalog/products/{id}/enrichment',{params:{path:{id},header}}).then(unwrap),
 review: (id:string,approve:boolean) => http.PUT("/v1/admin/catalog/enrichment/{id}",{params:{path:{id},header},body:{approve}}).then(unwrap),
};

export const memoryApi = {
 read: (conversation_id?:string, signal?:AbortSignal) => withCustomerSession(()=>http.GET('/v1/assistant/memory',{params:{query:{conversation_id}},signal}).then(unwrap)),
 consent: (body:components['schemas']['MemoryConsent']) => withCustomerSession(()=>http.PUT('/v1/assistant/memory',{...mutation,body}).then(unwrap)),
 preference: (body:components['schemas']['MemoryPreferenceInput']) => withCustomerSession(()=>http.POST('/v1/assistant/memory/preferences',{...mutation,body}).then(unwrap)),
 removePreference: (id:string) => withCustomerSession(()=>http.DELETE('/v1/assistant/memory/preferences/{id}',{params:{path:{id},header}}).then(unwrap)),
 clear: () => withCustomerSession(()=>http.DELETE('/v1/assistant/memory',mutation).then(unwrap)),
 clearContext: (id:string) => withCustomerSession(()=>http.DELETE('/v1/assistant/memory/context/{id}',{params:{path:{id},header}}).then(unwrap)),
 export: () => withCustomerSession(()=>http.GET('/v1/assistant/memory/export').then(unwrap)),
 goals: () => withCustomerSession(()=>http.GET('/v1/cart/saved-goals').then(unwrap)),
 goal: (task:string,body:components['schemas']['SavedGoalMetadata']) => withCustomerSession(()=>http.PUT('/v1/cart/saved-goals/{task}',{params:{path:{task},header},body}).then(unwrap)),
 forgetGoal: (task:string,version:number) => withCustomerSession(()=>http.DELETE('/v1/cart/saved-goals/{task}',{params:{path:{task},query:{version},header}}).then(unwrap)),
};

export const marketApi = {
  read: async () => unwrap(await http.GET("/v1/market")),
  product: async (id: string) => unwrap(await http.GET("/v1/market/products/{id}", { params: { path: { id } } })),
  measure: (id: string, quantity: string) => authorized(() => http.PUT("/v1/cart/items/{id}/measure", { params: { header, path: { id } }, body: { quantity } }).then(unwrap)),
};
