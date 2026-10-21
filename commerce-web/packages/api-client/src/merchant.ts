import createClient from "openapi-fetch";
import { traceFetch } from "./telemetry";
import type { components, paths } from "./schema";
import { ApiError } from "./identity";
export type MerchantInput = components["schemas"]["MerchantInput"];
export type MerchantAnswer = components["schemas"]["MerchantAnswer"];
const http = createClient<paths>({ baseUrl: "/api", credentials: "include", fetch: traceFetch });
export function validateMerchantAnswer(value: unknown, input: MerchantInput): MerchantAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid merchant answer");
  const v = value as Record<string, unknown>;
  const keys = ["question", "from", "to", "currency", "scope", "title", "evaluated_at", "columns", "rows", "notes", "truncated", "request_id", "conversation_id", "helpful"];
  const strings = (a: unknown, max: number, length: number): a is string[] => Array.isArray(a) && a.length <= max && a.every(s => typeof s === "string" && s.length <= length);
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k)) || ["question", "from", "to", "currency", "scope"].some(k => v[k] !== input[k as keyof MerchantInput]) || typeof v.title !== "string" || v.title.length > 100 || typeof v.evaluated_at !== "string" || !Number.isFinite(Date.parse(v.evaluated_at)) || !strings(v.columns,8,100) || v.columns.length === 0 || !strings(v.notes,10,1000) || !Array.isArray(v.rows) || v.rows.length > 20 || typeof v.truncated !== "boolean") throw new Error("Invalid merchant answer");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof v.request_id !== "string" || !uuid.test(v.request_id) || typeof v.conversation_id !== "string" || !uuid.test(v.conversation_id) || (v.helpful !== null && typeof v.helpful !== "boolean")) throw new Error("Invalid message identity");
  if ((input.request_id && v.request_id !== input.request_id) || (input.conversation_id && v.conversation_id !== input.conversation_id)) throw new Error("Merchant answer belongs to another request");
  const width = v.columns.length;
  if (!v.rows.every(r => strings(r,8,4000) && r.length === width)) throw new Error("Invalid merchant rows");
  return value as MerchantAnswer;
}
export async function queryMerchant(input: MerchantInput, signal: AbortSignal): Promise<MerchantAnswer> {
  const result = await http.POST("/v1/admin/assistant/query", { body: input, params: { header: { "X-Commerce-Request": "1" } }, signal });
  if (result.error) throw new ApiError(result.error.error, result.response.status);
  return validateMerchantAnswer(result.data, input);
}

export async function merchantHistory(conversation_id?: string): Promise<MerchantAnswer[]> {
  const result = await http.GET('/v1/admin/assistant/history',{params:{query:{conversation_id}}});
  if(result.error || !result.data) throw new Error('Merchant history unavailable');
  if(result.data.length>30) throw new Error('Invalid merchant history');
  return result.data.map(answer => validateMerchantAnswer(answer, {...answer, stock_threshold:0,sales_threshold:0,order_id:null}));
}
export async function merchantFeedback(request_id: string, helpful: boolean): Promise<void> {
  const result = await http.POST('/v1/admin/assistant/feedback', {body:{request_id,helpful},params:{header:{'X-Commerce-Request':'1'}}});
  if(result.error) throw new Error('Feedback could not be saved');
}
export async function merchantMetrics() {
  const result = await http.GET('/v1/admin/assistant/metrics');
  if(result.error || !result.data) throw new Error('Merchant metrics unavailable');
  return result.data;
}
export async function assistantUsage() {
  const result = await http.GET('/v1/admin/assistant/usage');
  if(result.error || !result.data) throw new Error('Shopper usage unavailable');
  return result.data;
}
