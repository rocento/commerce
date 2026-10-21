import createClient from "openapi-fetch";
import { traceFetch } from "./telemetry";
import { ApiError } from "./identity";
import type { components, paths } from "./schema";
export type AssistantProviderSettings = components["schemas"]["AssistantProviderSettings"];
export type AssistantProviderInput = components["schemas"]["AssistantProviderInput"];
const http = createClient<paths>({ baseUrl: "/api", credentials: "include", fetch: traceFetch });
const params = { header: { "X-Commerce-Request": "1" as const } };
export const assistantSettingsApi = {
  async readiness() {
    const result = await http.GET("/v1/admin/assistant/readiness");
    if (result.error) throw new ApiError(result.error.error, result.response.status);
    const data = result.data;
    if (!data || !Array.isArray(data.checks) || data.checks.some(check => !check || typeof check.name !== "string" || typeof check.status !== "string" || typeof check.message !== "string") ||
      ![data.currency_modes, data.quantity_modes, data.payment_modes, data.delivery_modes, data.feature_flags].every(values => Array.isArray(values) && values.every(value => typeof value === "string")) ||
      !data.last_acceptance || typeof data.last_acceptance.status !== "string" || typeof data.last_acceptance.message !== "string") {
      throw new Error("Store readiness is unavailable. The server returned invalid readiness metadata.");
    }
    return result.data;
  },
  async acceptance(body: components["schemas"]["AssistantAcceptanceInput"]) {
    const result = await http.POST("/v1/admin/assistant/acceptance", { body, params });
    if (result.error) throw new ApiError(result.error.error, result.response.status);
    if (!result.data) throw new Error("Store acceptance is unavailable.");
    return result.data;
  },
  async get() {
    const result = await http.GET("/v1/admin/assistant/settings");
    if (result.error) throw new ApiError(result.error.error, result.response.status);
    if (!result.data) throw new Error("AI settings are unavailable.");
    return result.data;
  },
  async save(body: AssistantProviderInput) {
    const result = await http.PUT("/v1/admin/assistant/settings", { body, params });
    if (result.error) throw new ApiError(result.error.error, result.response.status);
    if (!result.data) throw new Error("AI settings could not be saved.");
    return result.data;
  },
  async test(body: AssistantProviderInput) {
    const result = await http.POST("/v1/admin/assistant/settings/test", { body, params });
    if (result.error) throw new ApiError(result.error.error, result.response.status);
    if (!result.data) throw new Error("Connection test is unavailable.");
    return result.data;
  },
};
