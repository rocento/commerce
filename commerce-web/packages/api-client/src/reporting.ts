import { traceFetch } from "./telemetry";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { ApiError } from "./identity";
export type DashboardReport = components["schemas"]["DashboardReport"];
const http = createClient<paths>({baseUrl:"/api",credentials:"include",fetch:traceFetch});
export async function getReport(from:string,to:string):Promise<DashboardReport> {
  const r=await http.GET("/v1/admin/reports/dashboard",{params:{query:{from,to}}});
  if(r.error)throw new ApiError(r.error.error,r.response.status);
  if(!r.data)throw new Error("No report returned");
  return r.data;
}

export async function getAssistantReport():Promise<components["schemas"]["AssistantReport"]> {
  const result=await http.GET("/v1/admin/reports/assistant");
  if(result.error)throw new ApiError(result.error.error,result.response.status);
  if(!result.data)throw new Error("No assistant report returned");
  return result.data;
}
