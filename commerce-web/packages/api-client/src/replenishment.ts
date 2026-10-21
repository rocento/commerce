import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { ApiError } from "./identity";
import { traceFetch } from "./telemetry";
const http=createClient<paths>({baseUrl:"/api",credentials:"include",fetch:traceFetch});
const header={"X-Commerce-Request":"1" as const};
async function unwrap<T>(request:Promise<{data?:T;error?:{error:string};response:Response}>):Promise<T>{const r=await request;if(!r.response.ok||r.data===undefined)throw new ApiError(r.error?.error??"Request failed",r.response.status);return r.data;}
export type ReplenishmentRecommendation=components["schemas"]["ReplenishmentRecommendation"];
export type ReplenishmentPolicyInput=components["schemas"]["ReplenishmentPolicyInput"];
export const replenishmentApi={
 list:()=>unwrap(http.GET("/v1/admin/replenishment")),
 save:(id:string,body:ReplenishmentPolicyInput)=>unwrap(http.PUT("/v1/admin/replenishment/{id}",{params:{path:{id},header},body})),
 refresh:()=>unwrap(http.POST("/v1/admin/replenishment/refresh",{params:{header}})),
};
